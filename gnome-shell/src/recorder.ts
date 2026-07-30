// Turns the daemon's raw event stream into readable macro steps.
//
// The daemon sees every physical event because it grabs the devices, but it only
// knows relative pointer deltas. The shell knows the true pointer position, so
// button presses are annotated here with global.get_pointer() at press time.

import GLib from 'gi://GLib';

import { DaemonClient, EventStream, type StreamedEvent } from './daemon.js';
import {
    EV_KEY,
    EV_REL,
    REL_X,
    REL_Y,
    buttonFromCode,
    isModifier,
    keyCode,
    keyName,
} from './keymap.js';
import { newId, type ClickStep, type KeyStep, type MoveStep, type Step, type WaitStep } from './model.js';
import type { Config } from './store.js';

/** How long the pointer must sit still before a movement counts as finished. */
const MOTION_SETTLE_MS = 400;

/** Movement smaller than this is not worth a step of its own, in pixels. */
const ENDPOINT_EPSILON = 3;

export interface RecorderCallbacks {
    onStatus?: (text: string) => void;
    onError?: (error: Error) => void;
}

interface PendingKey {
    t: number;
    mods: number[];
}

export class Recorder {
    private _daemon: DaemonClient;
    private _stream: EventStream | null = null;
    private _config: Config;
    private _callbacks: RecorderCallbacks;

    private _mode: 'idle' | 'macro' | 'single' = 'idle';
    private _steps: Step[] = [];

    // Single-action capture state.
    private _settleId = 0;
    private _timeoutId = 0;
    private _finishSingle: ((step: Step | null) => void) | null = null;
    private _moved = false;

    private _lastT = 0;
    private _heldMods = new Map<number, number>();
    private _modifierCombined = false;
    private _pendingKeys = new Map<number, PendingKey>();
    private _pendingClick: { code: number; t: number; x: number; y: number } | null = null;
    private _motionPending = false;
    private _ignoredCodes = new Set<number>();
    private _settleMs = 900;
    private _motionId = 0;
    /** Where the macro's pointer already is, so we do not restate it. */
    private _lastEndpoint: { x: number; y: number } | null = null;

    constructor(daemon: DaemonClient, config: Config, callbacks: RecorderCallbacks = {}) {
        this._daemon = daemon;
        this._config = config;
        this._callbacks = callbacks;
    }

    /** True while a whole macro is being recorded. */
    get recording(): boolean {
        return this._mode === 'macro';
    }

    /** True while either kind of capture is in progress. */
    get busy(): boolean {
        return this._mode !== 'idle';
    }

    setConfig(config: Config): void {
        this._config = config;
    }

    /**
     * Key codes to drop, so the shortcut that stops recording does not end up
     * inside the recording.
     */
    setIgnoredCodes(codes: number[]): void {
        this._ignoredCodes = new Set(codes);
    }

    /** Open the event stream and tell the daemon to start reporting. */
    private async _beginSession(mode: 'macro' | 'single'): Promise<void> {
        this._reset();
        this._mode = mode;

        try {
            this._stream = new EventStream(this._daemon.eventPath);
            await this._stream.open(
                event => this._onEvent(event),
                error => {
                    if (error) {
                        this._callbacks.onError?.(error);
                    }
                },
            );
            await this._daemon.setRecording(true);
        } catch (error) {
            // Leaving the mode set would wedge the recorder: it would report
            // itself busy for ever and refuse to start again.
            this._mode = 'idle';
            this._stream?.close();
            this._stream = null;
            throw error;
        }
    }

    private _endSession(): void {
        this._mode = 'idle';
        this._clearTimers();
        this._stream?.close();
        this._stream = null;
        void this._daemon.setRecording(false).catch(error => {
            log(`clickmate: could not stop daemon recording: ${(error as Error).message}`);
        });
    }

    /**
     * `resumeFrom` is where the macro being recorded into already leaves the
     * pointer. Movement that merely returns there is not recorded again: between
     * two sessions the mouse gets used for other things, and that travel is not
     * part of the macro. Positions stay absolute and truthful either way.
     */
    async start(resumeFrom: { x: number; y: number } | null = null): Promise<void> {
        if (this.busy) {
            return;
        }
        await this._beginSession('macro');
        this._lastEndpoint = resumeFrom;
        this._callbacks.onStatus?.('Recording — press the shortcut again to stop');
    }

    /**
     * Watch for a single action and return it as one step: a click as soon as
     * the button is released, or a move once the pointer has been still for
     * `settleMs`. Shares the recorder's stream and click-building so the two
     * cannot drift apart.
     */
    async captureOne(settleMs = 900, timeoutMs = 30000): Promise<Step | null> {
        if (this.busy) {
            return null;
        }

        const result = new Promise<Step | null>(resolve => {
            this._finishSingle = resolve;
        });
        this._settleMs = settleMs;

        try {
            await this._beginSession('single');
        } catch (error) {
            this._settleSingle(null);
            throw error;
        }

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            this._timeoutId = 0;
            this._settleSingle(null);
            return GLib.SOURCE_REMOVE;
        });

        return result;
    }

    /** Give up on a pending single capture. */
    cancel(): void {
        if (this._mode === 'single') {
            this._settleSingle(null);
        }
    }

    private _settleSingle(step: Step | null): void {
        if (this._mode !== 'single') {
            return;
        }
        this._endSession();
        const finish = this._finishSingle;
        this._finishSingle = null;
        finish?.(step);
    }

    private _clearTimers(): void {
        this._clearMotionTimer();
        if (this._settleId) {
            GLib.source_remove(this._settleId);
            this._settleId = 0;
        }
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    /** Stop recording and return everything captured since start(). */
    async stop(): Promise<Step[]> {
        if (this._mode !== 'macro') {
            return [];
        }
        this._endSession();
        this._flushMotion(true);
        const steps = this._steps;
        this._steps = [];
        this._callbacks.onStatus?.(`Recorded ${steps.length} step${steps.length === 1 ? '' : 's'}`);
        return steps;
    }

    destroy(): void {
        this.cancel();
        this._clearTimers();
        this._stream?.close();
        this._stream = null;
        this._mode = 'idle';
    }

    // --- event handling ----------------------------------------------------

    private _reset(): void {
        this._steps = [];
        this._moved = false;
        this._lastEndpoint = null;
        this._lastT = 0;
        this._heldMods.clear();
        this._modifierCombined = false;
        this._pendingKeys.clear();
        this._pendingClick = null;
        this._motionPending = false;
    }

    private _emit(step: Step): void {
        this._steps.push(step);
    }

    private _onEvent(event: StreamedEvent): void {
        if (this._mode === 'idle') {
            return;
        }
        if (this._mode === 'single') {
            this._onSingleEvent(event);
            return;
        }

        if (event.type === EV_REL) {
            if (event.code === REL_X || event.code === REL_Y) {
                this._motionPending = true;
                this._restartMotionTimer();
            }
            return;
        }

        if (event.type !== EV_KEY) {
            return;
        }
        if (event.value === 2) {
            return; // key autorepeat
        }
        if (this._ignoredCodes.has(event.code)) {
            return;
        }

        // Only on the way down: the time between a press and its own release is
        // the hold, which the step already carries, not idle time.
        if (event.value === 1) {
            this._insertGap(event.t);
        }

        const button = buttonFromCode(event.code);
        // A click records the position it happened at, so movement that ends in
        // a press would only repeat it. Movement that ends anywhere else — a key,
        // or simply stopping — is the interesting kind and gets its own step.
        this._flushMotion(button === null);

        if (button !== null) {
            this._onButton(event, button);
        } else {
            this._onKey(event);
        }

        this._lastT = event.t;
    }

    /**
     * Movement arrives as a stream of tiny deltas, so a step is only emitted
     * once the pointer has come to rest.
     */
    private _restartMotionTimer(): void {
        this._clearMotionTimer();
        this._motionId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MOTION_SETTLE_MS, () => {
            this._motionId = 0;
            this._flushMotion(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _clearMotionTimer(): void {
        if (this._motionId) {
            GLib.source_remove(this._motionId);
            this._motionId = 0;
        }
    }

    /**
     * Idle gaps become explicit wait steps so playback keeps the same rhythm.
     * Called for presses only, so a long press is not counted twice.
     */
    private _insertGap(t: number): void {
        if (this._config.recordGapMs <= 0 || this._lastT === 0) {
            return;
        }
        const gapMs = Math.round((t - this._lastT) / 1000);
        if (gapMs < this._config.recordGapMs) {
            return;
        }
        const step: WaitStep = { id: newId(), kind: 'wait', ms: gapMs, jitterMs: 0 };
        this._emit(step);
    }

    /**
     * Pointer movement is stored as one absolute move to wherever the pointer
     * ended up, which survives a different starting position on replay.
     */
    private _flushMotion(emit: boolean): void {
        this._clearMotionTimer();
        if (!this._motionPending) {
            return;
        }
        this._motionPending = false;
        if (!emit || !this._config.recordMotion) {
            return;
        }

        const step = this._pointerStep();
        if (this._isAtEndpoint(step.x!, step.y!)) {
            return;   // the pointer is already where the macro left it
        }
        this._lastEndpoint = { x: step.x!, y: step.y! };
        this._emit(step);
    }

    private _isAtEndpoint(x: number, y: number): boolean {
        const endpoint = this._lastEndpoint;
        return endpoint !== null
            && Math.abs(endpoint.x - x) <= ENDPOINT_EPSILON
            && Math.abs(endpoint.y - y) <= ENDPOINT_EPSILON;
    }

    private _onButton(event: StreamedEvent, button: NonNullable<ReturnType<typeof buttonFromCode>>): void {
        if (event.value === 1) {
            const [x, y] = global.get_pointer();
            this._pendingClick = { code: event.code, t: event.t, x: Math.round(x), y: Math.round(y) };
            return;
        }

        const pending = this._pendingClick;
        this._pendingClick = null;
        if (!pending || pending.code !== event.code) {
            return; // release without a matching press, e.g. recording started mid-click
        }

        const click = this._buildClick(button, pending, event.t);
        this._lastEndpoint = { x: click.x!, y: click.y! };
        this._emit(click);
    }

    /** The one place a press/release pair becomes a click step. */
    private _buildClick(
        button: NonNullable<ReturnType<typeof buttonFromCode>>,
        press: { t: number; x: number; y: number },
        releasedAt: number,
    ): ClickStep {
        return {
            id: newId(),
            kind: 'click',
            button,
            mode: 'abs',
            x: press.x,
            y: press.y,
            holdMs: Math.max(1, Math.round((releasedAt - press.t) / 1000)),
        };
    }

    private _pointerStep(): MoveStep {
        const [x, y] = global.get_pointer();
        return { id: newId(), kind: 'move', mode: 'abs', x: Math.round(x), y: Math.round(y) };
    }

    // --- single-action capture ---------------------------------------------

    private _onSingleEvent(event: StreamedEvent): void {
        if (event.type === EV_REL && (event.code === REL_X || event.code === REL_Y)) {
            this._moved = true;
            this._restartSettleTimer();
            return;
        }
        if (event.type !== EV_KEY || event.value === 2) {
            return;
        }

        const button = buttonFromCode(event.code);
        if (button === null) {
            return; // a key press is not something this capture produces
        }

        if (event.value === 1) {
            const [x, y] = global.get_pointer();
            this._pendingClick = { code: event.code, t: event.t, x: Math.round(x), y: Math.round(y) };
            if (this._settleId) {
                GLib.source_remove(this._settleId);
                this._settleId = 0;
            }
            return;
        }

        const press = this._pendingClick;
        this._pendingClick = null;
        if (press && press.code === event.code) {
            this._settleSingle(this._buildClick(button, press, event.t));
        }
    }

    private _restartSettleTimer(): void {
        if (this._settleId) {
            GLib.source_remove(this._settleId);
        }
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._settleMs, () => {
            this._settleId = 0;
            if (this._pendingClick) {
                return GLib.SOURCE_REMOVE; // mid-drag, wait for the release
            }
            this._settleSingle(this._moved ? this._pointerStep() : null);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _onKey(event: StreamedEvent): void {
        const modifier = isModifier(event.code);

        if (event.value === 1) {
            if (modifier) {
                this._heldMods.set(event.code, event.t);
                this._modifierCombined = false;
            } else {
                if (this._heldMods.size > 0) {
                    this._modifierCombined = true;
                }
                this._pendingKeys.set(event.code, { t: event.t, mods: [...this._heldMods.keys()] });
            }
            return;
        }

        if (modifier) {
            const pressedAt = this._heldMods.get(event.code);
            this._heldMods.delete(event.code);
            // A modifier tapped on its own is a real keystroke worth recording;
            // one that was part of a combination is already covered by that key.
            if (pressedAt !== undefined && !this._modifierCombined && this._heldMods.size === 0) {
                const step: KeyStep = {
                    id: newId(),
                    kind: 'key',
                    code: keyName(event.code),
                    action: 'tap',
                    mods: [],
                    holdMs: Math.max(1, Math.round((event.t - pressedAt) / 1000)),
                };
                this._emit(step);
            }
            return;
        }

        const pending = this._pendingKeys.get(event.code);
        this._pendingKeys.delete(event.code);
        if (!pending) {
            return;
        }

        const step: KeyStep = {
            id: newId(),
            kind: 'key',
            code: keyName(event.code),
            action: 'tap',
            mods: pending.mods.map(keyName),
            holdMs: Math.max(1, Math.round((event.t - pending.t) / 1000)),
        };
        this._emit(step);
    }
}

/**
 * The non-modifier key of an accelerator, so the recorder can drop the keystroke
 * that stops it.
 *
 * Only that one key: the modifiers are deliberately left alone. Filtering Ctrl
 * and Shift for the whole session — because the stop shortcut happens to use
 * them — would quietly strip the modifier off every Ctrl+C and Shift+click you
 * recorded. The modifiers in the stop chord need no filtering anyway: they are
 * only ever turned into a step on release, and by then recording has stopped.
 */
export function acceleratorToEvdevCodes(accelerator: string): number[] {
    const key = (accelerator || '').replace(/<[^>]*>/g, '').trim();
    if (!key) {
        return [];
    }
    const code = keyCode(key);
    return code === null ? [] : [code];
}
