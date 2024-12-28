import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Button} from "@girs/gnome-shell/ui/panelMenu";
import { PopupSwitchMenuItem, PopupMenu, PopupMenuItem } from 'resource:///org/gnome/shell/ui/popupMenu.js';

interface ClickerStatus {
    status: 'on' | 'off';
}

interface ClickerLabels {
    ENABLE_BUTTON: string;
    TOGGLE_ACTIVE: string;
    ERROR_CONNECTION: string;
}

const DEFAULT_LABELS: ClickerLabels = {
    ENABLE_BUTTON: 'Enable Autoclicker',
    TOGGLE_ACTIVE: 'Auto-click active',
    ERROR_CONNECTION: 'Could not connect to click-socket'
};

export default class MyExtension extends Extension {

    _indicator: PanelMenu.Button | null | undefined;
    _toggleItem: PopupSwitchMenuItem | null | undefined;
    _keybindingId: number | null = null;
    _statusLabel: St.Label | null = null;
    _isUpdatingToggle: boolean = false;

    async checkClickerStatus(): Promise<ClickerStatus | null> {
        try {
            const client = new Gio.SocketClient();
            //TODO: async seems not to work
            const connection = client.connect(new Gio.UnixSocketAddress({ path: '/var/run/click-socket' }), null);

            // Send a simple HTTP GET request
            const httpRequest = [
                'GET / HTTP/1.1',
                'Host: localhost',
                'Connection: close',
                '',
                ''
            ].join('\r\n');

            // Write to socket
            const outputStream = connection.get_output_stream();
            outputStream.write_all(httpRequest, null);

            // Read response
            const inputStream = connection.get_input_stream();
            const dataInputStream = new Gio.DataInputStream({ base_stream: inputStream });


            // Skip HTTP headers
            let line;
            while ((line = dataInputStream.read_line(null)[0])) {
                if (line.length === 0) break;
            }

            // Read JSON response
            const response = dataInputStream.read_line(null)[0];
            if (response) {
                return JSON.parse(response.toString()) as ClickerStatus;
            }
            return null;
        } catch (error) {
            log(`Error checking clicker status: ${error}`);
            return null;
        }
    }

    async setClickerStatus(enabled: boolean): Promise<boolean> {
        try {
            const client = new Gio.SocketClient();
            const connection = client.connect(new Gio.UnixSocketAddress({ path: '/var/run/click-socket' }), null);

            const data = JSON.stringify({ status: enabled ? 'on' : 'off' });

            // Send HTTP POST request
            const httpRequest = [
                'POST / HTTP/1.1',
                'Host: localhost',
                'Connection: close',
                'Content-Type: application/json',
                `Content-Length: ${data.length}`,
                '',
                data
            ].join('\r\n');

            // Write to socket
            const outputStream = connection.get_output_stream();
            outputStream.write_all(httpRequest, null);

            // Read response
            const inputStream = connection.get_input_stream();
            const dataInputStream = new Gio.DataInputStream({ base_stream: inputStream });

            // Skip HTTP headers
            let line;
            while ((line = dataInputStream.read_line(null)[0])) {
                if (line.length === 0) break;
            }

            // Read JSON response
            const response = dataInputStream.read_line(null)[0];
            if (response) {
                const status = JSON.parse(response.toString()) as ClickerStatus;
                return status.status === (enabled ? 'on' : 'off');
            }
            return false;
        } catch (error) {
            log(`Error setting clicker status: ${error}`);
            return false;
        }
    }

    updateStatusLabel(error: boolean = false) {
        if (!this._statusLabel) {
            return;
        }

        if (error) {
            this._statusLabel.text = 'Could not connect to click-socket';
            this._statusLabel.add_style_class_name('error-label');
        } else {
            this._statusLabel.remove_style_class_name('error-label');
            this._statusLabel.style_class = 'status-label';
        }
    }

    async enable() {

        // Create a panel button
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        // Add an icon
        const icon = new St.Icon({
            icon_name: 'input-mouse-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);

        // Create a menu item for enabling autoclicker
        this._toggleItem = new PopupSwitchMenuItem('Enable Autoclicker', false);
        this._toggleItem.connect('toggled', async (item) => {
            if (this._isUpdatingToggle) return;
            const prevState = !item.state;
            const success = await this.setClickerStatus(item.state);
            if (!success) {
                this._isUpdatingToggle = true;
                item.setToggleState(prevState);
                this._isUpdatingToggle = false;
                this.updateStatusLabel(true);
            } else {
                this.updateStatusLabel(false);
            }

            // Play sound after state change
            this.playSound();
        });

        // Create status label
        this._statusLabel = new St.Label({
            text: '',
            style_class: 'status-label'
        });

        // Add the menu item to the indicator
        if (this._indicator.menu instanceof PopupMenu) {
            this._indicator.menu.addMenuItem(this._toggleItem);

            // Add status label in a menu item
            const statusItem = new PopupMenuItem('');
            statusItem.actor.add_child(this._statusLabel);
            this._indicator.menu.addMenuItem(statusItem);
        }

        // Register the keyboard shortcut
        Main.wm.addKeybinding(
            'toggle-autoclicker',
            this.getSettings(), // Your extension's settings
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.toggleAutoclicker()
        );

        // Add the indicator to the panel
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        const status = await this.checkClickerStatus();
        if (status) {
            if (this._toggleItem) {
                this._toggleItem.setToggleState(status.status === 'on');
            }
            this.updateStatusLabel(false);
        } else {
            this.updateStatusLabel(true);
        }
    }

    async toggleAutoclicker() {
        if (this._toggleItem) {
            const newState = !this._toggleItem.state;
            this._toggleItem.setToggleState(newState);
        }
    }

    playSound() {
        global.display.get_sound_player().play_from_theme(
            'dialog-information',  // You can also use 'bell', 'button-toggle-on', etc.
            'Autoclicker Toggle',
            null
        );
    }

    disable() {
        // Remove the keyboard shortcut
        if (this._keybindingId !== null) {
            Main.wm.removeKeybinding('toggle-autoclicker');
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._toggleItem = null;
    }
}