// Clickmate: record, edit and replay input macros with optional screen-aware
// conditions. The shell side owns all control flow; the daemon only injects and
// observes evdev events.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ConditionEvaluator, type EvaluationTrace } from './src/conditions.js';
import { DaemonClient } from './src/daemon.js';
import { MacroRunner } from './src/runner.js';
import { Recorder, acceleratorToEvdevCodes } from './src/recorder.js';
import { MacroStore, type Config } from './src/store.js';
import { starterMacro } from './src/starter.js';
import {
    childLists, describeStep, findStep, lastPointerEndpoint, reachesEnd,
    type Macro, type Step,
} from './src/model.js';
import { MacroPopup } from './ui/popup.js';
import { clearMarker, pickRegion, showMarker } from './ui/overlay.js';

const KEYBINDINGS = [
    'open-popup', 'run-macro', 'record-toggle', 'capture-step', 'panic-stop',
];

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
            shouldPause: () => this._isPointerOverMenu(),
            onFinished: (reason, error) => {
                if (reason === 'error' && error) {
                    Main.notify('Clickmate', `Macro failed: ${error.message}`);
                }
            },
        });
        this._recorder = new Recorder(this._daemon, config, {
            onStatus: text => this._onStatus(text),
            onError: error => Main.notify('Clickmate', `Recording stopped: ${error.message}`),
        });

        this._buildIndicator();

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
    }

    disable(): void {
        for (const name of this._boundKeys) {
            Main.wm.removeKeybinding(name);
        }
        this._boundKeys = [];

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
            onEnabledChanged: enabled => {
                if (enabled) {
                    this._runActiveMacro();
                } else {
                    this._runner?.stop();
                }
            },
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
        if (this._recorder?.recording) {
            this._icon.icon_name = 'media-record-symbolic';
            this._icon.add_style_class_name('clickmate-recording');
        } else if (this._runner?.running) {
            this._icon.icon_name = 'media-playback-start-symbolic';
            this._icon.remove_style_class_name('clickmate-recording');
        } else {
            this._icon.icon_name = 'input-mouse-symbolic';
            this._icon.remove_style_class_name('clickmate-recording');
        }
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

    // --- actions -----------------------------------------------------------

    private _runActiveMacro(): void {
        const macro = this._store?.activeMacro;
        if (!macro) {
            Main.notify('Clickmate', 'No macro selected. Pick one in Settings.');
            this._popup?.refresh();
            return;
        }
        if (this._runner?.running) {
            this._runner.stop();
            return;
        }
        this._indicator?.menu.close(true);
        // We just closed it, so the pause check must not still think otherwise.
        this._menuOpen = false;
        void this._runner?.run(macro);
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
        if (!this._store || !this._daemon) {
            return { ok: false, message: 'not ready' };
        }
        if (this._recorder?.busy) {
            return { ok: false, message: this._recorder.recording ? 'stop the recording first' : 'already waiting for a click' };
        }

        const macro = target?.macroId ? this._store.getMacro(target.macroId) : this._store.activeMacro;
        if (!macro) {
            return { ok: false, message: 'no macro to add to' };
        }

        const list = this._targetList(macro, target);
        if (!list) {
            return { ok: false, message: 'could not find where to add the step' };
        }

        this._indicator?.menu.close(true);
        Main.notify('Clickmate', 'Click anywhere to capture it, or move the pointer and hold still.');

        let step: Step | null = null;
        try {
            step = await this._recorder!.captureOne();
        } catch (error) {
            return { ok: false, message: (error as Error).message };
        }

        if (!step) {
            return { ok: false, message: 'nothing captured' };
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
        } catch {
            return;   // malformed; nothing sensible to do
        }

        const answer = await handle(request);
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
                this._runner?.stop();
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
                this._popup?.setDetail('The clickmate daemon is out of date — run sudo make install.');
            } else if (status.devices.length === 0) {
                this._popup?.setDetail('The daemon has no capture devices.');
            }
        } catch (error) {
            this._popup?.setDetail(`Cannot reach the daemon at ${this._daemon.controlPath}`);
        }
    }
}
