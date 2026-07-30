// The macro interpreter. Walks the step tree, compiles each primitive into an
// evdev event train and hands it to the daemon one step at a time, which is what
// makes the panic shortcut able to stop playback immediately.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ConditionEvaluator, type EvaluationTrace } from './conditions.js';
import { DaemonClient } from './daemon.js';
import {
    BUTTON_CODES,
    EV_KEY,
    EV_REL,
    KEY_CODES,
    REL_HWHEEL,
    REL_WHEEL,
    REL_X,
    REL_Y,
    keyCode,
    textToEvents,
} from './keymap.js';
import type {
    ClickStep,
    KeyStep,
    Macro,
    MoveStep,
    RawEvent,
    ScrollStep,
    Step,
    TextStep,
    WaitStep,
} from './model.js';
import { describeStep } from './model.js';
import type { Config } from './store.js';

export type StepState = 'running' | 'ok' | 'skipped' | 'failed';
export type FinishReason = 'done' | 'stopped' | 'error';

type Signal = 'normal' | 'break' | 'continue' | 'stop';

export interface RunnerCallbacks {
    onStepState?: (stepId: string, state: StepState) => void;
    onStatus?: (text: string) => void;
    onTrace?: (trace: EvaluationTrace) => void;
    onFinished?: (reason: FinishReason, error?: Error) => void;
    onRunningChanged?: (running: boolean) => void;
}

const MOUSE_SCHEMA = 'org.gnome.desktop.peripherals.mouse';
const MAX_MOVE_ITERATIONS = 8;

export class MacroRunner {
    private _daemon: DaemonClient;
    private _evaluator: ConditionEvaluator;
    private _config: Config;
    private _settings: Gio.Settings;
    private _callbacks: RunnerCallbacks;

    private _running = false;
    private _cancelled = false;
    private _sleepId = 0;
    private _wakeSleep: (() => void) | null = null;
    private _accelNeutralized = false;
    private _warnedAboutMotion = false;

    constructor(
        daemon: DaemonClient,
        evaluator: ConditionEvaluator,
        settings: Gio.Settings,
        config: Config,
        callbacks: RunnerCallbacks = {},
    ) {
        this._daemon = daemon;
        this._evaluator = evaluator;
        this._settings = settings;
        this._config = config;
        this._callbacks = callbacks;
    }

    get running(): boolean {
        return this._running;
    }

    setConfig(config: Config): void {
        this._config = config;
    }

    // --- lifecycle ---------------------------------------------------------

    async run(macro: Macro): Promise<void> {
        if (this._running) {
            return;
        }
        this._running = true;
        this._cancelled = false;
        this._warnedAboutMotion = false;
        this._callbacks.onRunningChanged?.(true);
        this._status(`Running “${macro.name}”`);

        let reason: FinishReason = 'done';
        let failure: Error | undefined;

        try {
            this._neutralizePointerAccel();
            if (macro.suppressInput) {
                await this._daemon.setSuppressInput(true);
            }
            const signal = await this._runList(macro.body);
            if (this._cancelled) {
                reason = 'stopped';
            } else if (signal === 'stop') {
                reason = 'done';
            }
        } catch (error) {
            if (this._cancelled) {
                reason = 'stopped';
            } else {
                reason = 'error';
                failure = error as Error;
                logError(error as Error, 'clickmate: macro failed');
            }
        } finally {
            try {
                if (macro.suppressInput) {
                    await this._daemon.setSuppressInput(false);
                }
            } catch (error) {
                log(`clickmate: could not clear input suppression: ${(error as Error).message}`);
            }
            this._restorePointerAccel();
            this._running = false;
            this._callbacks.onRunningChanged?.(false);
        }

        this._status(
            reason === 'done' ? `Finished “${macro.name}”`
            : reason === 'stopped' ? 'Stopped'
            : `Failed: ${failure?.message ?? 'unknown error'}`,
        );
        this._callbacks.onFinished?.(reason, failure);
    }

    /** Run a single step on its own, for the "try this step" buttons. */
    async runSingle(step: Step): Promise<void> {
        if (this._running) {
            return;
        }
        this._running = true;
        this._cancelled = false;
        this._callbacks.onRunningChanged?.(true);
        try {
            this._neutralizePointerAccel();
            await this._runStep(step);
            this._status(`Ran: ${describeStep(step)}`);
        } catch (error) {
            this._status(`Failed: ${(error as Error).message}`);
            logError(error as Error, 'clickmate: step failed');
        } finally {
            this._restorePointerAccel();
            this._running = false;
            this._callbacks.onRunningChanged?.(false);
        }
    }

    /** Abort immediately: cancel local waits and tell the daemon to let go. */
    stop(): void {
        if (!this._running && !this._cancelled) {
            // Still worth telling the daemon, in case a key is stuck from a crash.
            void this._daemon.stop().catch(() => {});
            return;
        }
        this._cancelled = true;
        this._wakeNow();
        void this._daemon.stop().catch(error => {
            log(`clickmate: stop request failed: ${(error as Error).message}`);
        });
    }

    // --- interpreter -------------------------------------------------------

    private async _runList(steps: Step[]): Promise<Signal> {
        for (const step of steps) {
            if (this._cancelled) {
                return 'stop';
            }
            const signal = await this._runStep(step);
            if (signal !== 'normal') {
                return signal;
            }
        }
        return 'normal';
    }

    private async _runStep(step: Step): Promise<Signal> {
        if (step.enabled === false) {
            this._callbacks.onStepState?.(step.id, 'skipped');
            return 'normal';
        }

        this._callbacks.onStepState?.(step.id, 'running');
        this._status(describeStep(step));

        try {
            const signal = await this._execute(step);
            this._callbacks.onStepState?.(step.id, this._cancelled ? 'skipped' : 'ok');
            return signal;
        } catch (error) {
            this._callbacks.onStepState?.(step.id, 'failed');
            throw error;
        }
    }

    private async _execute(step: Step): Promise<Signal> {
        switch (step.kind) {
            case 'click':
                await this._doClick(step);
                return 'normal';
            case 'move':
                await this._doMove(step);
                return 'normal';
            case 'scroll':
                await this._doScroll(step);
                return 'normal';
            case 'key':
                await this._doKey(step);
                return 'normal';
            case 'text':
                await this._doText(step);
                return 'normal';
            case 'raw':
                await this._play(step.events);
                return 'normal';
            case 'wait':
                await this._doWait(step);
                return 'normal';

            case 'repeat': {
                let iteration = 0;
                for (;;) {
                    if (this._cancelled) {
                        return 'stop';
                    }
                    if (step.count !== 'forever' && iteration >= step.count) {
                        return 'normal';
                    }
                    iteration++;
                    const signal = await this._runList(step.body);
                    if (signal === 'break') {
                        return 'normal';
                    }
                    if (signal === 'stop') {
                        return 'stop';
                    }
                    // Yield to the main loop so a body with no waits in it cannot
                    // starve the compositor.
                    await this._sleep(0);
                }
            }

            case 'while': {
                let iteration = 0;
                const limit = step.maxIterations ?? 0;
                for (;;) {
                    if (this._cancelled) {
                        return 'stop';
                    }
                    if (limit > 0 && iteration >= limit) {
                        this._status(`While loop hit its ${limit} iteration limit`);
                        return 'normal';
                    }
                    const proceed = await this._evaluator.evaluate(step.cond);
                    if (this._cancelled) {
                        return 'stop';
                    }
                    if (!proceed) {
                        return 'normal';
                    }
                    iteration++;
                    const signal = await this._runList(step.body);
                    if (signal === 'break') {
                        return 'normal';
                    }
                    if (signal === 'stop') {
                        return 'stop';
                    }
                    await this._sleep(0);
                }
            }

            case 'if': {
                const proceed = await this._evaluator.evaluate(step.cond);
                if (this._cancelled) {
                    return 'stop';
                }
                return this._runList(proceed ? step.then : step.else ?? []);
            }

            case 'break':
                return 'break';
            case 'continue':
                return 'continue';
            case 'stop':
                return 'stop';
        }
    }

    // --- primitives --------------------------------------------------------

    private async _play(events: RawEvent[]): Promise<void> {
        if (this._cancelled || events.length === 0) {
            return;
        }
        const result = await this._daemon.play(events);
        if (result.aborted) {
            this._cancelled = true;
        }
    }

    private async _doClick(step: ClickStep): Promise<void> {
        if (step.mode === 'abs') {
            await this._moveAbs(step.x ?? 0, step.y ?? 0);
            if (this._cancelled) {
                return;
            }
        }
        const code = BUTTON_CODES[step.button] ?? BUTTON_CODES.left;
        const hold = Math.max(0, step.holdMs ?? 20) * 1000;
        await this._play([
            { dt: 0, type: EV_KEY, code, value: 1 },
            { dt: hold, type: EV_KEY, code, value: 0 },
        ]);
    }

    private async _doMove(step: MoveStep): Promise<void> {
        if (step.mode === 'abs') {
            await this._moveAbs(step.x ?? 0, step.y ?? 0);
            return;
        }
        await this._playRelative(step.dx ?? 0, step.dy ?? 0);
    }

    private async _playRelative(dx: number, dy: number): Promise<void> {
        const events: RawEvent[] = [];
        if (dx) {
            events.push({ dt: 0, type: EV_REL, code: REL_X, value: Math.round(dx), syn: dy === 0 });
        }
        if (dy) {
            events.push({ dt: 0, type: EV_REL, code: REL_Y, value: Math.round(dy), syn: true });
        }
        await this._play(events);
    }

    /**
     * uinput only speaks relative motion, so walk the pointer to the target and
     * verify with global.get_pointer() after each nudge. Converges in one step
     * with a flat acceleration profile, in a few otherwise.
     */
    private async _moveAbs(x: number, y: number): Promise<void> {
        for (let i = 0; i < MAX_MOVE_ITERATIONS; i++) {
            if (this._cancelled) {
                return;
            }
            const [px, py] = global.get_pointer();
            const dx = Math.round(x - px);
            const dy = Math.round(y - py);
            if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
                return;
            }
            await this._playRelative(dx, dy);
            await this._sleep(6);
        }

        if (!this._warnedAboutMotion) {
            this._warnedAboutMotion = true;
            const [px, py] = global.get_pointer();
            this._status(`Pointer stopped at ${Math.round(px)},${Math.round(py)} instead of ${x},${y}`);
            log('clickmate: absolute move did not converge. If the target grabs the pointer ' +
                '(games with mouse look), record relative motion instead of using absolute clicks.');
        }
    }

    private async _doScroll(step: ScrollStep): Promise<void> {
        const events: RawEvent[] = [];
        if (step.dx) {
            events.push({ dt: 0, type: EV_REL, code: REL_HWHEEL, value: Math.round(step.dx), syn: !step.dy });
        }
        if (step.dy) {
            events.push({ dt: 0, type: EV_REL, code: REL_WHEEL, value: Math.round(step.dy), syn: true });
        }
        await this._play(events);
    }

    private async _doKey(step: KeyStep): Promise<void> {
        const code = keyCode(step.code);
        if (code === null) {
            throw new Error(`unknown key ${step.code}`);
        }
        const mods = (step.mods ?? [])
            .map(name => keyCode(name))
            .filter((value): value is number => value !== null);
        const hold = Math.max(0, step.holdMs ?? 20) * 1000;
        const events: RawEvent[] = [];

        if (step.action !== 'up') {
            for (const mod of mods) {
                events.push({ dt: 0, type: EV_KEY, code: mod, value: 1 });
            }
        }

        if (step.action === 'tap') {
            events.push({ dt: 0, type: EV_KEY, code, value: 1 });
            events.push({ dt: hold, type: EV_KEY, code, value: 0 });
        } else {
            events.push({ dt: 0, type: EV_KEY, code, value: step.action === 'down' ? 1 : 0 });
        }

        if (step.action !== 'down') {
            for (const mod of [...mods].reverse()) {
                events.push({ dt: 0, type: EV_KEY, code: mod, value: 0 });
            }
        }

        await this._play(events);
    }

    private async _doText(step: TextStep): Promise<void> {
        await this._play(textToEvents(step.value, step.delayMs ?? 12));
    }

    private async _doWait(step: WaitStep): Promise<void> {
        const jitter = Math.max(0, step.jitterMs ?? 0);
        const offset = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0;
        await this._sleep(Math.max(0, Math.round(step.ms + offset)));
    }

    // --- helpers -----------------------------------------------------------

    private _status(text: string): void {
        this._callbacks.onStatus?.(text);
    }

    private _wakeNow(): void {
        if (this._sleepId) {
            GLib.source_remove(this._sleepId);
            this._sleepId = 0;
        }
        const wake = this._wakeSleep;
        this._wakeSleep = null;
        wake?.();
    }

    private _sleep(ms: number): Promise<void> {
        return new Promise<void>(resolve => {
            this._wakeSleep = resolve;
            this._sleepId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, ms), () => {
                this._sleepId = 0;
                this._wakeSleep = null;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // --- pointer acceleration ---------------------------------------------

    private _mouseSettings(): Gio.Settings | null {
        try {
            return new Gio.Settings({ schema_id: MOUSE_SCHEMA });
        } catch (error) {
            log(`clickmate: ${MOUSE_SCHEMA} is unavailable: ${(error as Error).message}`);
            return null;
        }
    }

    /**
     * A flat profile at speed 0 makes one relative pixel equal one screen pixel,
     * which is what lets absolute moves land on the first try. The previous
     * values go into our own settings so a shell crash can still restore them.
     */
    private _neutralizePointerAccel(): void {
        if (!this._config.neutralizePointerAccel || this._accelNeutralized) {
            return;
        }
        const mouse = this._mouseSettings();
        if (!mouse) {
            return;
        }
        this._settings.set_string('saved-accel-profile', mouse.get_string('accel-profile'));
        this._settings.set_double('saved-pointer-speed', mouse.get_double('speed'));
        mouse.set_string('accel-profile', 'flat');
        mouse.set_double('speed', 0.0);
        this._accelNeutralized = true;
    }

    private _restorePointerAccel(): void {
        if (!this._accelNeutralized) {
            return;
        }
        this._accelNeutralized = false;
        restorePointerAccel(this._settings);
    }
}

/**
 * Put the pointer acceleration settings back. Exported so the extension can call
 * it on enable(), which recovers the desktop after a shell crash mid-playback.
 */
export function restorePointerAccel(settings: Gio.Settings): void {
    const profile = settings.get_string('saved-accel-profile');
    if (!profile) {
        return;
    }
    try {
        const mouse = new Gio.Settings({ schema_id: MOUSE_SCHEMA });
        mouse.set_string('accel-profile', profile);
        mouse.set_double('speed', settings.get_double('saved-pointer-speed'));
    } catch (error) {
        log(`clickmate: could not restore pointer acceleration: ${(error as Error).message}`);
    }
    settings.set_string('saved-accel-profile', '');
    settings.set_double('saved-pointer-speed', 0.0);
}
