// Clickmate: record, edit and replay input macros with optional screen-aware
// conditions. The shell side owns all control flow; the daemon only injects and
// observes evdev events.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ConditionEvaluator, type EvaluationTrace } from './src/conditions.js';
import { DaemonClient } from './src/daemon.js';
import { MacroRunner, type FinishReason, type RunningStep } from './src/runner.js';
import { Recorder, acceleratorToEvdevCodes } from './src/recorder.js';
import { MacroStore, type Config } from './src/store.js';
import { starterMacro } from './src/starter.js';
import {
    childLists, describeStep, findStep, lastPointerEndpoint, reachesEnd,
    resolveRecordTarget, resolveRunStart, type Macro, type RecordTarget, type Step,
} from './src/model.js';
import { clearProblems, onProblemsChanged, problemCount, reportProblem } from './src/problems.js';
import { MacroPopup } from './ui/popup.js';
import { clearMarker, pickRegion, showMarker } from './ui/overlay.js';

const KEYBINDINGS = [
    'open-popup', 'run-macro', 'record-toggle', 'capture-step', 'panic-stop',
];

/**
 * How often the running position is written to settings. A loop body with no
 * waits in it changes step thousands of times a second; the editor only needs to
 * keep up with the eye.
 */
const RUNNING_PUBLISH_MS = 100;

/** Where preferences wants a captured step to land. */
interface CaptureTarget {
    serial: number;
    macroId?: string;
    parentStepId?: string | null;
    listKey?: string | null;
}

export default class ClickmateExtension extends Extension {
    private _settings?: Gio.Settings;
    private _store?: MacroStore;
    private _daemon?: DaemonClient;
    private _evaluator?: ConditionEvaluator;
    /**
     * One runner per macro, made when that macro first runs and kept afterwards.
     * Several can be going at once — every enabled macro starts together — and
     * they interleave a step at a time, because there is one pointer, one
     * keyboard and one daemon between them.
     */
    private _runners = new Map<string, MacroRunner>();
    /**
     * Macros a `start` step asked for while they were already running. A run
     * cannot begin before the last one has unwound, so the id waits here until
     * that run reports itself finished.
     */
    private _restarting = new Set<string>();
    private _recorder?: Recorder;
    private _popup?: MacroPopup;
    private _indicator?: PanelMenu.Button;
    private _icon?: St.Icon;
    private _boundKeys: string[] = [];
    private _menuOpen = false;
    private _settingsChangedId = 0;
    private _storeUnsubscribe?: () => void;
    private _problemsUnsubscribe?: () => void;
    private _runningPaths = new Map<string, RunningStep[]>();
    private _publishSourceId = 0;
    private _publishSerial = 0;

    enable(): void {
        this._settings = this.getSettings();

        this._store = new MacroStore(this._settings);
        if (this._store.macros.length === 0) {
            const macro = starterMacro();
            this._store.addMacro(macro);
            this._store.activeMacroId = macro.id;
        }

        const config = this._store.config;
        this._daemon = new DaemonClient(config.controlSocket, config.eventSocket);
        this._evaluator = new ConditionEvaluator(config, trace => this._onTrace(trace));
        this._recorder = new Recorder(this._daemon, config, {
            onStatus: text => this._onStatus(text),
            onError: error => {
                reportProblem('Recording', `the recording stopped: ${error.message}`, {
                    hint: 'Anything after this point was not recorded. Check that the clickmate ' +
                        'service is running: systemctl status clickmate.',
                    error,
                });
                Main.notify('Clickmate', `Recording stopped: ${error.message}`);
            },
            onBusyChanged: () => this._updateIcon(),
        });

        this._buildIndicator();

        // A problem filed while the menu is shut has to show somewhere, or the
        // popup only helps people who already suspect something is wrong.
        this._problemsUnsubscribe = onProblemsChanged(() => this._updateIcon());
        this._updateIcon();

        this._storeUnsubscribe = this._store.onChanged(() => {
            this._forgetDeletedRunners();
            this._popup?.refresh();
        });
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            this._onSettingChanged(key);
        });

        for (const name of KEYBINDINGS) {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL,
                () => this._onShortcut(name),
            );
            this._boundKeys.push(name);
        }

        this._updateIgnoredRecordingKeys();
        this._popup?.refresh();

        // Asked once at startup rather than only when the menu opens: a daemon
        // that is not running is the single most common reason for clickmate
        // doing nothing at all, and the warning icon is what points at it.
        void this._checkDaemon();
    }

    disable(): void {
        for (const name of this._boundKeys) {
            Main.wm.removeKeybinding(name);
        }
        this._boundKeys = [];

        if (this._publishSourceId) {
            GLib.source_remove(this._publishSourceId);
            this._publishSourceId = 0;
        }
        this._runningPaths.clear();
        this._publishRunningPaths();

        clearMarker();
        // Nothing is recording once we are gone; a stale "yes" here would leave
        // the editor painted red until the next recording corrected it.
        if (this._settings?.get_string('recording')) {
            this._settings.set_string('recording', '');
        }
        this._recorder?.cancel();
        this._restarting.clear();
        for (const runner of this._runners.values()) {
            runner.stop();
        }
        this._runners.clear();
        this._recorder?.destroy();
        this._evaluator?.destroy();
        this._popup?.destroy();
        this._indicator?.destroy();

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
        }
        this._settingsChangedId = 0;
        this._storeUnsubscribe?.();
        this._problemsUnsubscribe?.();
        this._problemsUnsubscribe = undefined;
        // The list belongs to the popup that is going away with us; a locked
        // screen or a disable/enable cycle should not resurrect old failures.
        clearProblems();
        this._store?.destroy();

        this._recorder = undefined;
        this._evaluator = undefined;
        this._daemon = undefined;
        this._store = undefined;
        this._popup = undefined;
        this._indicator = undefined;
        this._icon = undefined;
        this._settings = undefined;
    }

    // --- UI ----------------------------------------------------------------

    private _buildIndicator(): void {
        const indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._icon = new St.Icon({
            icon_name: 'input-mouse-symbolic',
            style_class: 'system-status-icon',
        });
        indicator.add_child(this._icon);

        this._popup = new MacroPopup({
            store: this._store!,
            runningMacroIds: () => this._runningMacros().map(([id]) => id),
            isPaused: () => this._runningMacros().some(([, runner]) => runner.paused),
            isRecording: () => this._recorder?.recording ?? false,
            resumeStep: () => this._settings?.get_string('record-into') ?? '',
            onEnabledChanged: enabled => {
                if (enabled) {
                    this._runEnabled();
                } else {
                    this._pauseAll();
                }
            },
            onStop: () => this._stopAll(),
            onOpenPreferences: () => {
                this._indicator?.menu.close(true);
                this.openPreferences();
            },
        });

        if (indicator.menu instanceof PopupMenu.PopupMenu) {
            this._popup.addTo(indicator.menu);
            indicator.menu.connectObject('open-state-changed', (_menu: PopupMenu.PopupMenu, isOpen: boolean) => {
                this._menuOpen = isOpen;
                if (isOpen) {
                    this._popup?.refresh();
                    void this._checkDaemon();
                }
            }, this);
        }

        Main.panel.addToStatusArea(this.uuid, indicator);
        this._indicator = indicator;
    }

    /**
     * True while the menu is open and the pointer is within it. Measured against
     * the menu's allocation rather than by listening for hover events: making the
     * menu reactive enough to emit those intercepted the clicks meant for it.
     */
    private _isPointerOverMenu(): boolean {
        if (!this._menuOpen) {
            return false;
        }
        const actor = this._indicator?.menu.actor;
        if (!actor) {
            return false;
        }
        const [left, top] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        const [x, y] = global.get_pointer();
        return x >= left && x <= left + width && y >= top && y <= top + height;
    }

    private _updateIcon(): void {
        if (!this._icon) {
            return;
        }
        const problems = problemCount() > 0;
        // `busy`, not `recording`: waiting for a single click from the Record
        // button in preferences is just as much "we are watching your input" as
        // a whole macro recording, and reads the same way in the panel.
        if (this._recorder?.busy) {
            this._icon.icon_name = 'media-record-symbolic';
            this._icon.add_style_class_name('clickmate-recording');
        } else if (this._runningMacros().length > 0) {
            this._icon.icon_name = 'media-playback-start-symbolic';
            this._icon.remove_style_class_name('clickmate-recording');
        } else if (problems) {
            // Only when nothing is happening: a running macro reporting a
            // recoverable failure should still read as running.
            this._icon.icon_name = 'dialog-warning-symbolic';
            this._icon.remove_style_class_name('clickmate-recording');
        } else {
            this._icon.icon_name = 'input-mouse-symbolic';
            this._icon.remove_style_class_name('clickmate-recording');
        }

        if (problems) {
            this._icon.add_style_class_name('clickmate-problem-icon');
        } else {
            this._icon.remove_style_class_name('clickmate-problem-icon');
        }

        // The editor is usually the window you are looking at while this
        // happens, and it cannot see the panel icon from over there.
        const state = this._recorder?.recording ? 'macro' : this._recorder?.busy ? 'capture' : '';
        if (this._settings && this._settings.get_string('recording') !== state) {
            this._settings.set_string('recording', state);
        }
        // The popup keeps its own subscription, so the list is already current.
    }

    private _onStatus(text: string): void {
        this._popup?.setDetail(text);
    }

    private _onTrace(trace: EvaluationTrace): void {
        const text = `${trace.condition} → ${trace.result ? 'yes' : 'no'}${trace.detail ? ` (${trace.detail})` : ''}`;
        this._popup?.setDetail(text);
    }

    private _onRunningChanged(): void {
        this._updateIcon();
        this._popup?.refresh();
    }

    /**
     * Where a runner is, as the chain of steps it is inside. The popup shows it
     * as a breadcrumb; preferences, which is a different process, reads the ids
     * off a settings key and highlights the matching rows. One chain per running
     * macro, because there can be several at once.
     */
    private _onStepsChanged(macroId: string, path: RunningStep[]): void {
        if (path.length === 0) {
            this._runningPaths.delete(macroId);
        } else {
            this._runningPaths.set(macroId, path);
        }
        this._popup?.setDetail(this._breadcrumb());

        if (this._publishSourceId) {
            return; // a write is already due; it will pick up this path
        }
        this._publishSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RUNNING_PUBLISH_MS, () => {
            this._publishSourceId = 0;
            this._publishRunningPaths();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * What the popup says is happening. With one macro that is just the chain of
     * steps; with several the name has to come first, or two breadcrumbs on one
     * line are unreadable.
     */
    private _breadcrumb(): string {
        const named = this._runningPaths.size > 1;
        return [...this._runningPaths]
            .map(([macroId, path]) => {
                const trail = path.map(entry => entry.label).join(' › ');
                const name = this._store?.getMacro(macroId)?.name;
                return named && name ? `${name}: ${trail}` : trail;
            })
            .join('\n');
    }

    private _publishRunningPaths(): void {
        // The serial is what makes the write differ: the empty list at the end of
        // one run is the same string as at the end of the last, and GSettings does
        // not signal an identical value.
        this._settings?.set_string('running-steps', JSON.stringify({
            serial: ++this._publishSerial,
            running: [...this._runningPaths].map(([macro, path]) => ({
                macro,
                steps: path.map(entry => entry.id),
            })),
        }));
    }

    // --- actions -----------------------------------------------------------

    /** The runner for this macro, built the first time the macro is run. */
    private _runnerFor(macroId: string): MacroRunner | null {
        const existing = this._runners.get(macroId);
        if (existing) {
            return existing;
        }
        if (!this._daemon || !this._evaluator || !this._settings || !this._store) {
            return null;
        }
        const runner = new MacroRunner(
            this._daemon, this._evaluator, this._settings, this._store.config, {
                onStatus: text => this._onStatus(text),
                onRunningChanged: () => this._onRunningChanged(),
                onStepsChanged: path => this._onStepsChanged(macroId, path),
                shouldPause: () => this._isPointerOverMenu(),
                onFinished: (reason, error) => this._onFinished(macroId, reason, error),
                onMacroControl: (action, target) => this._macroControl(action, target),
                macroName: id => this._store?.getMacro(id)?.name,
            });
        this._runners.set(macroId, runner);
        return runner;
    }

    private _onFinished(macroId: string, reason: FinishReason, error?: Error): void {
        const macro = this._store?.getMacro(macroId);
        if (reason === 'done' && macro) {
            // Ran to the end, so there is nothing left to continue from. Only
            // our own mark: a selection in another macro is where someone is
            // working, and finishing over here must not move it.
            if (resolveRunStart(macro.body, this._settings?.get_string('record-into') ?? '')) {
                this._select(macroId, `end:${macroId}`);
            }
        } else if (reason === 'error') {
            // Select the step that threw: you fix it, then press the shortcut
            // again rather than replaying everything before it.
            const failed = this._runners.get(macroId)?.failedStepId;
            if (failed) {
                this._select(macroId, `after:${failed}`);
            }
        }
        // 'stopped' leaves the key alone — pause has just written the step to
        // it, and Stop has just cleared it.

        // A start step asked for a macro that was already running: it had to end
        // before it could begin again, and it has just ended. `_running` is
        // already false by the time we are called, so this starts cleanly.
        if (this._restarting.delete(macroId) && macro) {
            void this._runners.get(macroId)?.run(macro, '');
        }

        // The runner has already filed the problem; this is only the
        // interruption, for the case where the menu is closed.
        if (reason === 'error' && error) {
            Main.notify('Clickmate', `“${macro?.name ?? 'Macro'}” failed: ${error.message}`);
        }
        this._popup?.refresh();
    }

    /** Every macro with a runner going right now, as [id, runner]. */
    private _runningMacros(): [string, MacroRunner][] {
        return [...this._runners].filter(([, runner]) => runner.running);
    }

    /** Runners for macros that have since been deleted, gone with them. */
    private _forgetDeletedRunners(): void {
        for (const [id, runner] of [...this._runners]) {
            if (!runner.running && !this._store?.getMacro(id)) {
                this._runners.delete(id);
            }
        }
    }

    /**
     * The one toggle behind both the shortcut and the popup switch: start every
     * enabled macro, or pause them. They run alongside each other, taking turns
     * at the pointer a step at a time.
     *
     * Pausing is not a suspend — the runs end — but with a single macro it
     * writes down the step it was on, so pressing the shortcut again picks up
     * there instead of at the top. Stop is the separate action that throws that
     * place away.
     */
    private _runEnabled(): void {
        const macros = this._store?.enabledMacros ?? [];
        if (macros.length === 0) {
            Main.notify('Clickmate', this._store?.macros.length
                ? 'No macro is switched on. Turn one on in Settings.'
                : 'No macros yet. Add one in Settings.');
            this._popup?.refresh();
            return;
        }
        if (this._runningMacros().length > 0) {
            this._pauseAll();
            return;
        }
        this._indicator?.menu.close(true);
        // We just closed it, so the pause check must not still think otherwise.
        this._menuOpen = false;
        for (const macro of macros) {
            this._runMacro(macro);
        }
    }

    /**
     * A `start` or `stop` step reaching into another macro. Returns a reason
     * when it could not, which the runner turns into a failed step.
     *
     * Start means start: a macro already going is ended and begun again from the
     * top, because there is one run per macro and asking for it while it runs
     * can only mean from the beginning. That includes a macro restarting itself,
     * which is how a watcher gets back to its first check.
     */
    private _macroControl(action: 'start' | 'stop', macroId: string): string | null {
        const macro = this._store?.getMacro(macroId);
        if (!macro) {
            return 'that macro is no longer there';
        }
        const runner = this._runnerFor(macroId);
        if (!runner) {
            return 'the extension is not ready yet';
        }
        if (runner.running) {
            // Only the last one going tells the daemon to let go: that request
            // is global, and would cut into whatever else is playing.
            const alone = this._runningMacros().length === 1;
            if (action === 'start') {
                this._restarting.add(macroId);
            }
            runner.stop(alone);
        } else if (action === 'start') {
            void runner.run(macro, '');
        }
        this._popup?.refresh();
        return null;
    }

    /** Start one macro, from the selected step when the selection is in it. */
    private _runMacro(macro: Macro): boolean {
        const runner = this._runnerFor(macro.id);
        if (!runner || runner.running) {
            return false;
        }
        void runner.run(macro, this._resumeStepFor(macro));
        return true;
    }

    /** Halt everything, remembering where to continue from where that is one place. */
    private _pauseAll(): void {
        // Whatever a start step asked for, this press is more recent than it.
        this._restarting.clear();
        const running = this._runningMacros();
        if (running.length === 1) {
            // Read before stopping: the path is cleared when the run unwinds.
            const id = running[0][1].currentStepId;
            if (id) {
                this._select(running[0][0], `after:${id}`);
            }
        }
        // Several at once are in several places, and there is one mark. Rather
        // than pick one of them to be wrong about, the next press starts them
        // all from the top.
        //
        // Only the last one tells the daemon: that request is global — it aborts
        // whatever is being injected and lets go of every held key — so doing it
        // first would cut into a macro that is still running.
        running.forEach(([, runner], index) => runner.stop(index === running.length - 1));
        this._popup?.refresh();
    }

    /** Halt and forget where we were, so the next run starts at the top. */
    private _stopAll(): void {
        this._restarting.clear();
        this._clearMark();
        for (const [, runner] of this._runningMacros()) {
            runner.stop();
        }
        this._popup?.refresh();
    }

    /**
     * Id of the step this macro's run starts at; '' means from the beginning. It
     * is the row selected in the editor, which is also where a recording lands —
     * one mark for "here", used by both. A selection in another macro leaves this
     * one starting at the top, which is what `resolveRunStart` reports.
     */
    private _resumeStepFor(macro: Macro): string {
        return resolveRunStart(macro.body, this._settings?.get_string('record-into') ?? '');
    }

    /**
     * Move the editor's selection to a row of this macro. The two go together:
     * the row says where in a macro, and the macro is what a recording is added
     * to, so a mark pointing into one macro while another is the selected one
     * would send the next recording somewhere the editor is not showing.
     */
    private _select(macroId: string, value: string): void {
        if (!this._settings) {
            return;
        }
        if (this._store && this._store.activeMacroId !== macroId) {
            this._store.activeMacroId = macroId;
        }
        // Guarded because preferences repaints on every change of this key, and
        // most writes here are the same value it already holds.
        if (this._settings.get_string('record-into') !== value) {
            this._settings.set_string('record-into', value);
        }
    }

    private _clearMark(): void {
        const current = this._settings?.get_string('record-into') ?? '';
        // A body picked for recording is not somewhere a run was left off, so
        // there is nothing to forget and clearing it would move that choice.
        if (current.startsWith('after:')) {
            this._settings?.set_string('record-into', '');
        }
    }

    /**
     * Preferences cannot grab the screen from its own process, so it bumps a
     * counter and we hand the picked rectangle back through settings.
     */
    /**
     * Watch for one click or pointer move and append it as a step. `target`
     * comes from preferences and names the list it should land in; without one
     * the step goes to the end of the selected macro.
     */
    private async _captureStep(target?: CaptureTarget): Promise<{ ok: boolean; message: string }> {
        // Every failure here is a button press that appeared to do nothing, so
        // each one is worth a line in the popup as well as the return value.
        const fail = (message: string, hint?: string) => {
            reportProblem('Recording', `could not capture a step: ${message}`, { hint });
            return { ok: false, message };
        };

        if (!this._store || !this._daemon) {
            return fail('the extension is not ready yet');
        }
        if (this._recorder?.busy) {
            return fail(this._recorder.recording ? 'stop the recording first' : 'already waiting for a click');
        }

        const macro = target?.macroId ? this._store.getMacro(target.macroId) : this._store.activeMacro;
        if (!macro) {
            return fail('no macro to add to', 'Create one in Settings → Macros first.');
        }

        const where = this._targetList(macro, target);
        if (!where) {
            return fail('could not find where to add the step',
                'The step you were adding into may have been deleted. Close and reopen Settings.');
        }

        this._indicator?.menu.close(true);
        Main.notify('Clickmate', 'Click anywhere to capture it, or move the pointer and hold still.');

        let step: Step | null = null;
        try {
            step = await this._recorder!.captureOne();
        } catch (error) {
            return fail((error as Error).message,
                'Check that the clickmate service is running: systemctl status clickmate');
        }

        if (!step) {
            return fail('nothing was captured before it timed out',
                'Click somewhere, or move the pointer and hold it still, while it waits.');
        }

        where.list.splice(where.at, 0, step);
        this._store.save();

        const message = `Added: ${describeStep(step)}`;
        Main.notify('Clickmate', message);
        return { ok: true, message };
    }

    /**
     * Wait for one click and report where it landed. The same gesture as
     * capturing a step, minus the step: a coordinate in the editor is easier to
     * go and point at than to read off the screen and type in, and this is how
     * an existing one is corrected without recording the step again.
     */
    private async _pickPoint(): Promise<object> {
        const fail = (message: string, hint?: string) => {
            reportProblem('Recording', `could not pick a position: ${message}`, { hint });
            return { ok: false, message };
        };

        if (!this._recorder || !this._daemon) {
            return fail('the extension is not ready yet');
        }
        if (this._recorder.busy) {
            return fail(this._recorder.recording ? 'stop the recording first' : 'already waiting for a click');
        }

        this._indicator?.menu.close(true);
        Main.notify('Clickmate', 'Click the position, or move the pointer there and hold still.');

        let step: Step | null = null;
        try {
            step = await this._recorder.captureOne();
        } catch (error) {
            return fail((error as Error).message,
                'Check that the clickmate service is running: systemctl status clickmate');
        }

        // A click gives its position and a pointer that stopped gives where it
        // stopped; either way what came back is a point on the screen.
        if (!step || step.kind === 'click' && step.mode !== 'abs'
            || !('x' in step) || typeof step.x !== 'number' || typeof step.y !== 'number') {
            return fail('nothing was picked before it timed out',
                'Click somewhere, or move the pointer and hold it still, while it waits.');
        }

        return { ok: true, x: Math.round(step.x), y: Math.round(step.y) };
    }

    /**
     * Run one step, now, because a play button in the editor asked. Only that
     * step: preferences does not offer this on a loop or an `if`, which would
     * take their whole body with them — and an endless loop would take the
     * session, from a window that has no Stop.
     */
    private async _runOneStep(request: { macroId?: string; stepId?: string }): Promise<object> {
        if (!this._store) {
            return { ok: false, message: 'the extension is not ready yet' };
        }
        const macro = request.macroId ? this._store.getMacro(request.macroId) : this._store.activeMacro;
        const loc = macro && request.stepId ? findStep(macro.body, request.stepId) : null;
        if (!loc) {
            return { ok: false, message: 'that step is no longer in the macro' };
        }
        const runner = this._runnerFor(macro!.id);
        if (!runner) {
            return { ok: false, message: 'the extension is not ready yet' };
        }
        if (runner.running) {
            return { ok: false, message: 'this macro is running — stop it first' };
        }
        return runner.runSingle(loc.step);
    }

    /**
     * Start or stop one macro, because the button beside it in the editor asked.
     * The panel switch runs everything that is switched on; this is the one you
     * are looking at, whether it is switched on or not.
     */
    private _runOneMacro(request: { macroId?: string; action?: string }): object {
        const macro = request.macroId ? this._store?.getMacro(request.macroId) : null;
        if (!macro) {
            return { ok: false, message: 'that macro is no longer there' };
        }
        if (request.action === 'stop') {
            const runner = this._runners.get(macro.id);
            // Not a pause: the button says stop, and the editor's selection is
            // where you are working rather than where this got to.
            runner?.stop(this._runningMacros().length === 1);
            this._popup?.refresh();
            return { ok: true, message: `Stopped “${macro.name}”` };
        }
        if (!this._runMacro(macro)) {
            return { ok: false, message: 'it is already running' };
        }
        return { ok: true, message: `Running “${macro.name}”` };
    }

    /** Where a recording lands: whichever row the editor has selected. */
    private _recordTarget(macro: Macro): RecordTarget {
        return resolveRecordTarget(macro.body, this._settings?.get_string('record-into') ?? '');
    }

    private _targetList(macro: Macro, target?: CaptureTarget): { list: Step[]; at: number } | null {
        if (!target) {
            // Nobody named a list, so the editor's choice stands. A request from
            // preferences always names one, even when that one is the top.
            return this._recordTarget(macro);
        }
        if (!target.parentStepId) {
            return { list: macro.body, at: macro.body.length };
        }
        const loc = findStep(macro.body, target.parentStepId);
        if (!loc) {
            return null;
        }
        const lists = childLists(loc.step);
        const match = lists.find(list => list.key === target.listKey) ?? lists[0];
        return match ? { list: match.steps, at: match.steps.length } : null;
    }

    /**
     * Answer one of preferences' requests. Each arrives as serialled JSON on a
     * `<name>-request` key; whatever the handler returns goes back on
     * `<name>-result` carrying the same serial, which is also what makes the
     * value differ every time — GSettings does not signal an identical write.
     */
    private async _answerRequest<T extends { serial?: number }>(
        name: string,
        handle: (request: T) => Promise<object | void> | object | void,
    ): Promise<void> {
        const raw = this._settings?.get_string(`${name}-request`) ?? '';
        if (!raw) {
            return;
        }

        let request: T;
        try {
            request = JSON.parse(raw) as T;
        } catch (error) {
            reportProblem('Settings', `a ${name} request from preferences was malformed`, {
                hint: 'The button that sent it will do nothing until preferences is reopened.',
                error: error as Error,
            });
            return;
        }

        let answer: object | void;
        try {
            answer = await handle(request);
        } catch (error) {
            // Preferences is waiting on the reply, so this cannot just throw into
            // the void: without an answer the button there stays stuck.
            reportProblem('Settings', `the ${name} request failed: ${(error as Error).message}`, {
                hint: 'Preferences asked the shell to do something and it did not work. ' +
                    'Try it again from the preferences window.',
                error: error as Error,
            });
            // Shaped like a handler's own failure answer, so the caller in
            // preferences shows the reason instead of "unknown reason".
            answer = { ok: false, message: (error as Error).message };
        }

        if (answer !== undefined) {
            this._settings?.set_string(
                `${name}-result`,
                JSON.stringify({ serial: request.serial ?? 0, ...answer }),
            );
        }
    }

    private async _toggleRecording(): Promise<void> {
        if (!this._recorder || !this._store) {
            return;
        }
        const macro = this._store.activeMacro;
        if (!macro) {
            Main.notify('Clickmate', 'Create a macro before recording.');
            return;
        }

        if (this._recorder.recording) {
            const steps = await this._recorder.stop();
            const target = this._recordTarget(macro);
            // Appending after an endless loop would put them somewhere that never
            // runs, which is otherwise invisible until you wonder why nothing
            // happens. Inside a body there is no such trap: that is where the
            // loop goes round.
            const atEnd = target.list === macro.body && target.at === macro.body.length;
            const stranded = steps.length > 0 && atEnd && !reachesEnd(macro.body);
            target.list.splice(target.at, 0, ...steps);
            this._store.save();
            this._updateIcon();
            this._popup?.refresh();
            if (stranded) {
                const warning = `Recorded ${steps.length} step${steps.length === 1 ? '' : 's'}, but ` +
                    `“${macro.name}” never gets past its endless loop. Move them inside it in Settings.`;
                this._popup?.setDetail(warning);
                reportProblem('Recording', `${steps.length} recorded step${steps.length === 1 ? '' : 's'} will never run`, {
                    where: macro.name,
                    hint: 'They landed after an endless loop. Open Settings → Macros and drag them ' +
                        'into the loop body.',
                });
                Main.notify('Clickmate', warning);
            }
            return;
        }

        for (const [, runner] of this._runningMacros()) {
            runner.stop();
        }

        // An open shell menu holds the keyboard grab, which would stop you from
        // driving the app you are recording against.
        this._indicator?.menu.close(true);

        try {
            this._updateIgnoredRecordingKeys();
            await this._recorder.start(lastPointerEndpoint(macro.body));
            const where = this._recordTarget(macro).where;
            Main.notify('Clickmate', `Recording into “${macro.name}”${where ? `, ${where}` : ''}. ` +
                'Press the shortcut again to stop.');
        } catch (error) {
            reportProblem('Recording', `could not start: ${(error as Error).message}`, {
                hint: 'The daemon has to be running and capturing your devices. ' +
                    'Check it with: systemctl status clickmate',
                error: error as Error,
            });
            Main.notify('Clickmate', `Could not start recording: ${(error as Error).message}`);
        }
        this._updateIcon();
    }

    private _onShortcut(name: string): void {
        switch (name) {
            case 'open-popup':
                this._indicator?.menu.toggle();
                break;
            case 'run-macro':
                this._runEnabled();
                break;
            case 'record-toggle':
                void this._toggleRecording();
                break;
            case 'capture-step':
                void this._captureStep();
                break;
            case 'panic-stop':
                this._recorder?.cancel();
                // A full stop, not a pause: the emergency key should leave
                // nothing armed to carry on from.
                this._stopAll();
                if (this._recorder?.recording) {
                    void this._recorder.stop();
                }
                this._updateIcon();
                break;
        }
    }

    // --- configuration -----------------------------------------------------

    private _onSettingChanged(key: string): void {
        if (key === 'macros' || key === 'active-macro-id') {
            this._popup?.refresh();
            return;
        }
        if (key === 'running-steps') {
            return; // our own write, several times a second while a macro runs
        }
        if (key === 'record-into') {
            // The selected row is also where the next run starts, and the popup
            // says so — "Continue" rather than "Run".
            this._popup?.refresh();
            return;
        }
        if (key === 'recording') {
            return; // our own state; nothing to redo here
        }
        if (key === 'pick-region-request') {
            void this._answerRequest('pick-region', async () => ({ region: await pickRegion() }));
            return;
        }
        if (key === 'pick-point-request') {
            void this._answerRequest('pick-point', () => this._pickPoint());
            return;
        }
        if (key === 'capture-step-request') {
            void this._answerRequest<CaptureTarget>('capture-step', target => this._captureStep(target));
            return;
        }
        if (key === 'run-step-request') {
            void this._answerRequest<{ serial?: number; macroId?: string; stepId?: string }>(
                'run-step', request => this._runOneStep(request));
            return;
        }
        if (key === 'run-macro-request') {
            void this._answerRequest<{ serial?: number; macroId?: string; action?: string }>(
                'run-macro', request => this._runOneMacro(request));
            return;
        }
        if (key === 'show-marker-request') {
            // Purely visual: returning nothing means no answer is written back.
            void this._answerRequest<{ serial?: number; x: number; y: number; w?: number; h?: number }>(
                'show-marker',
                ({ x, y, w, h }) => {
                    if (Number.isFinite(x) && Number.isFinite(y)) {
                        showMarker(x, y, w, h);
                    }
                },
            );
            return;
        }
        if (key === 'record-toggle') {
            this._updateIgnoredRecordingKeys();
            return;
        }
        if (key.startsWith('saved-') || key.endsWith('-result')) {
            return;
        }

        const config: Config | undefined = this._store?.config;
        if (!config) {
            return;
        }
        this._daemon?.setPaths(config.controlSocket, config.eventSocket);
        this._evaluator?.setConfig(config);
        for (const runner of this._runners.values()) {
            runner.setConfig(config);
        }
        this._recorder?.setConfig(config);
    }

    /** Keep the stop-recording chord out of the recording itself. */
    private _updateIgnoredRecordingKeys(): void {
        const accelerators = this._settings?.get_strv('record-toggle') ?? [];
        const codes = accelerators.flatMap(acceleratorToEvdevCodes);
        this._recorder?.setIgnoredCodes(codes);
    }

    private async _checkDaemon(): Promise<void> {
        if (!this._daemon) {
            return;
        }
        try {
            const status = await this._daemon.status();
            if (status.version < 2) {
                reportProblem('Daemon', `it speaks protocol v${status.version}, this extension needs v2`, {
                    hint: 'Rebuild and reinstall it: cd clickmate && ./deploy.sh',
                });
            } else if (status.devices.length === 0) {
                reportProblem('Daemon', 'it captured no input devices', {
                    hint: 'Nothing can be recorded or replayed. The device names in ' +
                        '/etc/systemd/system/clickmate.service must match this machine — list them with ' +
                        "grep '^N: Name' /proc/bus/input/devices",
                });
            }
        } catch (error) {
            reportProblem('Daemon', `cannot reach it at ${this._daemon.controlPath}: ${(error as Error).message}`, {
                hint: 'Nothing can be recorded or replayed until it answers. ' +
                    'Check it with: systemctl status clickmate',
            });
        }
    }
}
