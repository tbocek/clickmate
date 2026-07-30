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
import { MacroRunner, restorePointerAccel, type StepState } from './src/runner.js';
import { Recorder, acceleratorToEvdevCodes } from './src/recorder.js';
import { MacroStore, type Config } from './src/store.js';
import { starterMacro } from './src/starter.js';
import type { Condition, Region, Step } from './src/model.js';
import { MacroPopup } from './ui/popup.js';
import { RunHud, pickRegion } from './ui/overlay.js';

const KEYBINDINGS = ['open-popup', 'run-macro', 'record-toggle', 'pick-point', 'panic-stop'];

export default class ClickmateExtension extends Extension {
    private _settings?: Gio.Settings;
    private _store?: MacroStore;
    private _daemon?: DaemonClient;
    private _evaluator?: ConditionEvaluator;
    private _runner?: MacroRunner;
    private _recorder?: Recorder;
    private _popup?: MacroPopup;
    private _hud?: RunHud;
    private _indicator?: PanelMenu.Button;
    private _icon?: St.Icon;
    private _boundKeys: string[] = [];
    private _settingsChangedId = 0;
    private _storeUnsubscribe?: () => void;

    enable(): void {
        this._settings = this.getSettings();

        // If the shell died mid-playback the pointer profile is still flattened.
        restorePointerAccel(this._settings);

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
            onStepState: (id, state) => this._onStepState(id, state),
            onStatus: text => this._onStatus(text),
            onRunningChanged: running => this._onRunningChanged(running),
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
        this._hud = new RunHud(() => this._runner?.stop());

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

        this._runner?.stop();
        this._recorder?.destroy();
        this._evaluator?.destroy();
        this._hud?.destroy();
        this._popup?.destroy();
        this._indicator?.destroy();

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
        }
        this._settingsChangedId = 0;
        this._storeUnsubscribe?.();
        this._store?.destroy();

        // Never leave the desktop with a flattened pointer profile.
        if (this._settings) {
            restorePointerAccel(this._settings);
        }

        this._runner = undefined;
        this._recorder = undefined;
        this._evaluator = undefined;
        this._daemon = undefined;
        this._store = undefined;
        this._popup = undefined;
        this._hud = undefined;
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
            isRecording: () => this._recorder?.recording ?? false,
            onRun: () => this._runActiveMacro(),
            onStop: () => this._runner?.stop(),
            onToggleRecord: () => void this._toggleRecording(),
            onRunStep: step => void this._runSingleStep(step),
            onTestCondition: condition => void this._testCondition(condition),
            onPickRegion: apply => void this._pickRegion(apply),
            onOpenPreferences: () => {
                this._indicator?.menu.close(true);
                this.openPreferences();
            },
        });

        if (indicator.menu instanceof PopupMenu.PopupMenu) {
            this._popup.addTo(indicator.menu);
            indicator.menu.connectObject('open-state-changed', (_menu: PopupMenu.PopupMenu, isOpen: boolean) => {
                if (isOpen) {
                    this._popup?.refresh();
                    void this._checkDaemon();
                }
            }, this);
        }

        Main.panel.addToStatusArea(this.uuid, indicator);
        this._indicator = indicator;
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
        this._popup?.setStatus(text);
        this._hud?.setStatus(text);
    }

    private _onTrace(trace: EvaluationTrace): void {
        const text = `${trace.condition} → ${trace.result ? 'yes' : 'no'}${trace.detail ? ` (${trace.detail})` : ''}`;
        this._popup?.setDetail(text);
        this._hud?.setDetail(text);
    }

    private _onStepState(id: string, state: StepState): void {
        this._popup?.setStepState(id, state);
    }

    private _onRunningChanged(running: boolean): void {
        this._updateIcon();
        this._popup?.refresh();
        if (running) {
            this._hud?.show();
        } else {
            this._hud?.hide();
        }
    }

    // --- actions -----------------------------------------------------------

    private _runActiveMacro(): void {
        const macro = this._store?.activeMacro;
        if (!macro) {
            Main.notify('Clickmate', 'No macro selected.');
            return;
        }
        if (this._runner?.running) {
            this._runner.stop();
            return;
        }
        this._popup?.clearStepStates();
        this._indicator?.menu.close(true);
        void this._runner?.run(macro);
    }

    private async _runSingleStep(step: Step): Promise<void> {
        if (!this._runner || this._runner.running) {
            return;
        }
        this._indicator?.menu.close(true);
        await this._runner.runSingle(step);
    }

    private async _testCondition(condition: Condition): Promise<void> {
        if (!this._evaluator) {
            return;
        }
        this._onStatus('Testing condition…');
        try {
            // Trace output already lands in the detail line via _onTrace.
            await this._evaluator.evaluate(condition);
        } catch (error) {
            this._popup?.setDetail(`Test failed: ${(error as Error).message}`);
        }
    }

    private async _pickRegion(apply: (region: Region) => void): Promise<void> {
        this._indicator?.menu.close(true);
        const region = await pickRegion();
        if (region) {
            apply(region);
        }
        this._indicator?.menu.open(true);
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
            macro.body.push(...steps);
            this._store.save();
            this._updateIcon();
            this._popup?.refresh();
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
            await this._recorder.start();
            Main.notify('Clickmate', `Recording into “${macro.name}”. Press the shortcut again to stop.`);
        } catch (error) {
            Main.notify('Clickmate', `Could not start recording: ${(error as Error).message}`);
        }
        this._updateIcon();
    }

    private _pickPoint(): void {
        const [x, y] = global.get_pointer();
        const px = Math.round(x);
        const py = Math.round(y);
        const applied = this._popup?.applyPickedPoint(px, py);
        Main.notify('Clickmate', applied ?? `Pointer is at ${px},${py}`);
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
            case 'pick-point':
                this._pickPoint();
                break;
            case 'panic-stop':
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
        if (key === 'record-toggle') {
            this._updateIgnoredRecordingKeys();
            return;
        }
        if (key.startsWith('saved-')) {
            return;
        }

        const config: Config | undefined = this._store?.config;
        if (!config) {
            return;
        }
        this._daemon?.setPaths(config.controlSocket, config.eventSocket);
        this._evaluator?.setConfig(config);
        this._evaluator?.clearCache();
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
