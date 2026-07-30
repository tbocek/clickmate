// Turns the daemon's raw event stream into readable macro steps.
//
// The daemon sees every physical event because it grabs the devices, but it only
// knows relative pointer deltas. The shell knows the true pointer position, so
// button presses are annotated here with global.get_pointer() at press time.

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
import { newId, type ClickStep, type KeyStep, type MoveStep, type RawStep, type Step, type WaitStep } from './model.js';
import type { Config } from './store.js';

export interface RecorderCallbacks {
    onStep?: (step: Step) => void;
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

    private _recording = false;
    private _steps: Step[] = [];

    private _lastT = 0;
    private _heldMods = new Map<number, number>();
    private _modifierCombined = false;
    private _pendingKeys = new Map<number, PendingKey>();
    private _pendingClick: { code: number; t: number; x: number; y: number } | null = null;
    private _motionPending = false;
    private _rawEvents: { dt: number; type: number; code: number; value: number }[] = [];
    private _ignoredCodes = new Set<number>();

    constructor(daemon: DaemonClient, config: Config, callbacks: RecorderCallbacks = {}) {
        this._daemon = daemon;
        this._config = config;
        this._callbacks = callbacks;
    }

    get recording(): boolean {
        return this._recording;
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

    async start(): Promise<void> {
        if (this._recording) {
            return;
        }
        this._reset();
        this._recording = true;

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
        this._callbacks.onStatus?.('Recording — press the shortcut again to stop');
    }

    /** Stop recording and return everything captured since start(). */
    async stop(): Promise<Step[]> {
        if (!this._recording) {
            return [];
        }
        this._recording = false;

        try {
            await this._daemon.setRecording(false);
        } catch (error) {
            log(`clickmate: could not stop daemon recording: ${(error as Error).message}`);
        }
        this._stream?.close();
        this._stream = null;

        this._flushMotion();
        if (this._config.recordRaw && this._rawEvents.length > 0) {
            const step: RawStep = {
                id: newId(),
                kind: 'raw',
                label: `Recorded ${this._rawEvents.length} events`,
                events: this._rawEvents,
            };
            this._emit(step);
            this._rawEvents = [];
        }

        const steps = this._steps;
        this._steps = [];
        this._callbacks.onStatus?.(`Recorded ${steps.length} step${steps.length === 1 ? '' : 's'}`);
        return steps;
    }

    destroy(): void {
        this._stream?.close();
        this._stream = null;
        this._recording = false;
    }

    // --- event handling ----------------------------------------------------

    private _reset(): void {
        this._steps = [];
        this._lastT = 0;
        this._heldMods.clear();
        this._modifierCombined = false;
        this._pendingKeys.clear();
        this._pendingClick = null;
        this._motionPending = false;
        this._rawEvents = [];
    }

    private _emit(step: Step): void {
        this._steps.push(step);
        this._callbacks.onStep?.(step);
    }

    private _onEvent(event: StreamedEvent): void {
        if (!this._recording) {
            return;
        }

        if (this._config.recordRaw) {
            const dt = this._lastT ? Math.max(0, event.t - this._lastT) : 0;
            this._lastT = event.t;
            this._rawEvents.push({ dt, type: event.type, code: event.code, value: event.value });
            return;
        }

        if (event.type === EV_REL) {
            if (event.code === REL_X || event.code === REL_Y) {
                this._motionPending = true;
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

        this._insertGap(event.t);
        this._flushMotion();

        const button = buttonFromCode(event.code);
        if (button !== null) {
            this._onButton(event, button);
        } else {
            this._onKey(event);
        }

        this._lastT = event.t;
    }

    /** Idle gaps become explicit wait steps so playback keeps the same rhythm. */
    private _insertGap(t: number): void {
        if (!this._config.recordDelays || this._lastT === 0) {
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
    private _flushMotion(): void {
        if (!this._motionPending) {
            return;
        }
        this._motionPending = false;
        if (!this._config.recordMotion) {
            return;
        }
        const [x, y] = global.get_pointer();
        const step: MoveStep = {
            id: newId(),
            kind: 'move',
            mode: 'abs',
            x: Math.round(x),
            y: Math.round(y),
        };
        this._emit(step);
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

        const step: ClickStep = {
            id: newId(),
            kind: 'click',
            button,
            mode: 'abs',
            x: pending.x,
            y: pending.y,
            holdMs: Math.max(1, Math.round((event.t - pending.t) / 1000)),
        };
        this._emit(step);
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
 * Best-effort mapping from a GTK accelerator to the evdev codes it involves, so
 * the recorder can drop its own stop shortcut.
 */
export function acceleratorToEvdevCodes(accelerator: string): number[] {
    const codes: number[] = [];
    const text = accelerator || '';

    if (/<(Control|Primary|Ctrl)>/i.test(text)) {
        codes.push(29, 97); // KEY_LEFTCTRL, KEY_RIGHTCTRL
    }
    if (/<Shift>/i.test(text)) {
        codes.push(42, 54);
    }
    if (/<Alt>/i.test(text)) {
        codes.push(56, 100);
    }
    if (/<Super>/i.test(text)) {
        codes.push(125, 126);
    }

    const key = text.replace(/<[^>]*>/g, '').trim();
    if (key) {
        const code = keyCode(key);
        if (code !== null) {
            codes.push(code);
        }
    }
    return codes;
}
