// The panel popup. Deliberately tiny: a master switch, what is running, and a
// way into the editor. All macro editing lives in the preferences window.

import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import type { MacroStore } from '../src/store.js';

export interface PopupDeps {
    store: MacroStore;
    isRunning: () => boolean;
    isPaused: () => boolean;
    isRecording: () => boolean;
    onEnabledChanged: (enabled: boolean) => void;
    onOpenPreferences: () => void;
}

export class MacroPopup {
    private _deps: PopupDeps;
    private _switchItem: PopupMenu.PopupSwitchMenuItem;
    private _statusLabel: St.Label;
    private _detailLabel: St.Label;
    private _updatingSwitch = false;
    private _message = '';

    constructor(deps: PopupDeps) {
        this._deps = deps;

        this._switchItem = new PopupMenu.PopupSwitchMenuItem('Enabled', false);
        this._switchItem.connect('toggled', (_item, state: boolean) => {
            if (this._updatingSwitch) {
                return;
            }
            this._deps.onEnabledChanged(state);
        });

        this._statusLabel = new St.Label({ text: 'Idle', style_class: 'clickmate-status' });
        this._detailLabel = new St.Label({ text: '', style_class: 'clickmate-detail' });
        this._detailLabel.visible = false;
    }

    addTo(menu: PopupMenu.PopupMenu): void {
        menu.addMenuItem(this._switchItem);

        const statusItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const box = new St.BoxLayout({ vertical: true, style_class: 'clickmate-status-box' });
        box.add_child(this._statusLabel);
        box.add_child(this._detailLabel);
        statusItem.add_child(box);
        menu.addMenuItem(statusItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._deps.onOpenPreferences());
        menu.addMenuItem(settingsItem);
    }

    destroy(): void {
        this._statusLabel.destroy();
        this._detailLabel.destroy();
    }

    refresh(): void {
        const running = this._deps.isRunning();

        this._updatingSwitch = true;
        this._switchItem.setToggleState(running);
        this._updatingSwitch = false;

        const macro = this._deps.store.activeMacro;
        if (this._deps.isRecording()) {
            this._statusLabel.text = macro ? `Recording into “${macro.name}”` : 'Recording';
        } else if (running && this._deps.isPaused()) {
            this._statusLabel.text = macro ? `Paused — “${macro.name}”` : 'Paused';
        } else if (running) {
            this._statusLabel.text = macro ? `Running “${macro.name}”` : 'Running';
        } else if (!macro) {
            this._statusLabel.text = 'No macro selected';
        } else {
            this._statusLabel.text = `Idle — “${macro.name}” selected`;
        }

        this._detailLabel.text = this._message;
        this._detailLabel.visible = this._message !== '';
    }

    /**
     * The running commentary — current step, condition verdicts, "recorded N
     * steps". Kept after the fact, because most of it happens while the menu is
     * closed and you only read it when you open the menu again.
     */
    setDetail(text: string): void {
        this._message = text;
        this._detailLabel.text = text;
        this._detailLabel.visible = text !== '';
    }
}
