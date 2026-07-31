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
import { MacroRunner, type RunningStep } from './src/runner.js';
import { Recorder, acceleratorToEvdevCodes } from './src/recorder.js';
import { MacroStore, type Config } from './src/store.js';
import { starterMacro } from './src/starter.js';
import {
    childLists, describeStep, findStep, lastPointerEndpoint, reachesEnd,
    type Macro, type Step,
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
    private _runner?: MacroRunner;
    private _recorder?: Recorder;
    private _popup?: MacroPopup;
    private _indicator?: PanelMenu.Button;
    private _icon?: St.Icon;
    private _boundKeys: string[] = [];
    private _menuOpen = false;
    private _settingsChangedId = 0;
    private _storeUnsubscribe?: () => void;
    private _problemsUnsubscribe?: () => void;
    private _runningPath: RunningStep[] = [];
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
        this._runner = new MacroRunner(this._daemon, this._evaluator, this._settings, config, {
            onStatus: text => this._onStatus(text),
            onRunningChanged: running => this._onRunningChanged(running),
            onStepsChanged: path => this._onStepsChanged(path),
            shouldPause: () => this._isPointerOverMenu(),
            onFinished: (reason, error) => {
                if (reason === 'done') {
                    // Ran to the end, so there is nothing left to continue from.
                    this._resumeStep = '';
                } else if (reason === 'error') {
                    // Continue from the step that threw: you fix it, then press
                    // the shortcut again rather than replaying everything before.
                    this._resumeStep = this._runner?.failedStepId ?? '';
                }
                // 'stopped' leaves the key alone — pause has just written the
                // step to it, and Stop has just cleared it.

                // The runner has already filed the problem; this is only the
                // interruption, for the case where the menu is closed.
                if (reason === 'error' && error) {
                    Main.notify('Clickmate', `Macro failed: ${error.message}`);
                }
                this._popup?.refresh();
            },
        });
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

        this._storeUnsubscribe = this._store.onChanged(() => this._popup?.refresh());
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
        this._runningPath = [];
        this._publishRunningPath();

        clearMarker();
        this._recorder?.cancel();
        this._runner?.stop();
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

        this._runner = undefined;
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
            isRunning: () => this._runner?.running ?? false,
            isPaused: () => this._runner?.paused ?? false,
            isRecording: () => this._recorder?.recording ?? false,
            resumeStep: () => this._resumeStep,
            onEnabledChanged: enabled => {
                if (enabled) {
                    this._runActiveMacro();
                } else {
                    this._pauseMacro();
                }
            },
            onStop: () => this._stopMacro(),
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
        } else if (this._runner?.running) {
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
        // The popup keeps its own subscription, so the list is already current.
    }

    private _onStatus(text: string): void {
        this._popup?.setDetail(text);
    }

    private _onTrace(trace: EvaluationTrace): void {
        const text = `${trace.condition} → ${trace.result ? 'yes' : 'no'}${trace.detail ? ` (${trace.detail})` : ''}`;
        this._popup?.setDetail(text);
    }

    private _onRunningChanged(running: boolean): void {
        this._updateIcon();
        this._popup?.refresh();
    }

    /**
     * Where the runner is, as the chain of steps it is inside. The popup shows it
     * as a breadcrumb; preferences, which is a different process, reads the ids
     * off a settings key and highlights the matching rows.
     */
    private _onStepsChanged(path: RunningStep[]): void {
        this._runningPath = path;
        this._popup?.setDetail(path.map(entry => entry.label).join(' › '));

        if (this._publishSourceId) {
            return; // a write is already due; it will pick up this path
        }
        this._publishSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RUNNING_PUBLISH_MS, () => {
            this._publishSourceId = 0;
            this._publishRunningPath();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _publishRunningPath(): void {
        // The serial is what makes the write differ: the empty path at the end of
        // one run is the same string as at the end of the last, and GSettings does
        // not signal an identical value.
        this._settings?.set_string('running-steps', JSON.stringify({
            serial: ++this._publishSerial,
            steps: this._runningPath.map(entry => entry.id),
        }));
    }

    // --- actions -----------------------------------------------------------

    /**
     * The one toggle behind both the shortcut and the popup switch: start, or
     * pause. Pausing is not a suspend — the run ends — but it writes down the
     * step it was on, so pressing the shortcut again picks up there instead of
     * at the top. Stop is the separate action that throws that place away.
     */
    private _runActiveMacro(): void {
        const macro = this._store?.activeMacro;
        if (!macro) {
            Main.notify('Clickmate', 'No macro selected. Pick one in Settings.');
            this._popup?.refresh();
            return;
        }
        if (this._runner?.running) {
            this._pauseMacro();
            return;
        }
        this._indicator?.menu.close(true);
        // We just closed it, so the pause check must not still think otherwise.
        this._menuOpen = false;
        void this._runner?.run(macro, this._resumeStep);
    }

    /** Halt, remembering the step it was on as where to continue from. */
    private _pauseMacro(): void {
        if (!this._runner?.running) {
            return;
        }
        // Read before stopping: the path is cleared when the run unwinds.
        this._resumeStep = this._runner.currentStepId;
        this._runner.stop();
        this._popup?.refresh();
    }

    /** Halt and forget where we were, so the next run starts at the top. */
    private _stopMacro(): void {
        this._resumeStep = '';
        this._runner?.stop();
        this._popup?.refresh();
    }

    /** Id of the step the next run starts at; '' means from the beginning. */
    private get _resumeStep(): string {
        return this._settings?.get_string('resume-step') ?? '';
    }

    private set _resumeStep(id: string) {
        // Guarded because preferences redraws on every change of this key, and
        // most writes here are the same value it already holds.
        if (this._settings && this._settings.get_string('resume-step') !== id) {
            this._settings.set_string('resume-step', id);
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

        const list = this._targetList(macro, target);
        if (!list) {
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

        list.push(step);
        this._store.save();

        const message = `Added: ${describeStep(step)}`;
        Main.notify('Clickmate', message);
        return { ok: true, message };
    }

    private _targetList(macro: Macro, target?: CaptureTarget): Step[] | null {
        if (!target?.parentStepId) {
            return macro.body;
        }
        const loc = findStep(macro.body, target.parentStepId);
        if (!loc) {
            return null;
        }
        const lists = childLists(loc.step);
        const match = lists.find(list => list.key === target.listKey) ?? lists[0];
        return match ? match.steps : null;
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
            // Appending after an endless loop would put them somewhere that never
            // runs, which is otherwise invisible until you wonder why nothing
            // happens.
            const stranded = steps.length > 0 && !reachesEnd(macro.body);
            macro.body.push(...steps);
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

        if (this._runner?.running) {
            this._runner.stop();
        }

        // An open shell menu holds the keyboard grab, which would stop you from
        // driving the app you are recording against.
        this._indicator?.menu.close(true);

        try {
            this._updateIgnoredRecordingKeys();
            await this._recorder.start(lastPointerEndpoint(macro.body));
            Main.notify('Clickmate', `Recording into “${macro.name}”. Press the shortcut again to stop.`);
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
                this._runActiveMacro();
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
                this._stopMacro();
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
        if (key === 'resume-step') {
            // Preferences can set it too, by marking a step to continue from.
            this._popup?.refresh();
            return;
        }
        if (key === 'pick-region-request') {
            void this._answerRequest('pick-region', async () => ({ region: await pickRegion() }));
            return;
        }
        if (key === 'capture-step-request') {
            void this._answerRequest<CaptureTarget>('capture-step', target => this._captureStep(target));
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
        this._runner?.setConfig(config);
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
