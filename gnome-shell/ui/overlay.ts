// On-screen chrome: the run HUD and the drag-to-select region picker.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type { Region } from '../src/model.js';

/**
 * A compact always-on-top status strip, so a macro can run with the popup closed
 * while you still see which step it is on and can stop it with one click.
 */
export class RunHud {
    private _box: St.BoxLayout;
    private _statusLabel: St.Label;
    private _detailLabel: St.Label;
    private _visible = false;

    constructor(onStop: () => void) {
        this._box = new St.BoxLayout({
            style_class: 'clickmate-hud',
            vertical: false,
            reactive: true,
            track_hover: true,
        });

        const labels = new St.BoxLayout({ vertical: true, x_expand: true });
        this._statusLabel = new St.Label({ text: '', style_class: 'clickmate-hud-status' });
        this._detailLabel = new St.Label({ text: '', style_class: 'clickmate-hud-detail' });
        labels.add_child(this._statusLabel);
        labels.add_child(this._detailLabel);
        this._box.add_child(labels);

        const stopButton = new St.Button({
            style_class: 'clickmate-hud-stop',
            label: 'Stop',
            can_focus: true,
        });
        stopButton.connect('clicked', () => onStop());
        this._box.add_child(stopButton);
    }

    setStatus(text: string): void {
        this._statusLabel.text = text;
    }

    setDetail(text: string): void {
        this._detailLabel.text = text;
        this._detailLabel.visible = text !== '';
    }

    show(): void {
        if (this._visible) {
            return;
        }
        this._visible = true;
        Main.layoutManager.addChrome(this._box, { affectsInputRegion: true });
        this._reposition();
    }

    hide(): void {
        if (!this._visible) {
            return;
        }
        this._visible = false;
        Main.layoutManager.removeChrome(this._box);
    }

    private _reposition(): void {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) {
            return;
        }
        // Top centre, just under the panel.
        const width = Math.min(520, Math.round(monitor.width * 0.5));
        this._box.set_width(width);
        this._box.set_position(
            monitor.x + Math.round((monitor.width - width) / 2),
            monitor.y + Main.panel.height + 8,
        );
    }

    destroy(): void {
        this.hide();
        this._box.destroy();
    }
}

/**
 * Drag a rectangle over the screen. Resolves null when cancelled with Escape or
 * a right click.
 */
export function pickRegion(): Promise<Region | null> {
    return new Promise(resolve => {
        const overlay = new St.Widget({
            style_class: 'clickmate-picker',
            reactive: true,
            can_focus: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });

        const band = new St.Widget({ style_class: 'clickmate-picker-band', visible: false });
        overlay.add_child(band);

        const hint = new St.Label({
            style_class: 'clickmate-picker-hint',
            text: 'Drag to select the area the model should look at — Escape to cancel',
        });
        overlay.add_child(hint);
        hint.set_position(
            Math.round((global.stage.width - 520) / 2),
            Math.round(global.stage.height / 2),
        );

        Main.layoutManager.uiGroup.add_child(overlay);

        let grab: ReturnType<typeof Main.pushModal> | null = null;
        try {
            grab = Main.pushModal(overlay, { actionMode: Shell.ActionMode.NORMAL });
        } catch (error) {
            log(`clickmate: could not grab the screen for region picking: ${(error as Error).message}`);
        }

        let startX = 0;
        let startY = 0;
        let dragging = false;
        let settled = false;

        const finish = (region: Region | null) => {
            if (settled) {
                return;
            }
            settled = true;
            if (grab) {
                Main.popModal(grab);
            }
            overlay.destroy();
            resolve(region);
        };

        const updateBand = (x: number, y: number) => {
            const left = Math.min(startX, x);
            const top = Math.min(startY, y);
            band.set_position(left, top);
            band.set_size(Math.max(1, Math.abs(x - startX)), Math.max(1, Math.abs(y - startY)));
        };

        overlay.connect('button-press-event', (_actor, event: Clutter.Event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) {
                finish(null);
                return Clutter.EVENT_STOP;
            }
            const [x, y] = event.get_coords();
            startX = Math.round(x);
            startY = Math.round(y);
            dragging = true;
            hint.visible = false;
            band.visible = true;
            updateBand(startX, startY);
            return Clutter.EVENT_STOP;
        });

        overlay.connect('motion-event', (_actor, event: Clutter.Event) => {
            if (!dragging) {
                return Clutter.EVENT_PROPAGATE;
            }
            const [x, y] = event.get_coords();
            updateBand(Math.round(x), Math.round(y));
            return Clutter.EVENT_STOP;
        });

        overlay.connect('button-release-event', (_actor, event: Clutter.Event) => {
            if (!dragging) {
                return Clutter.EVENT_PROPAGATE;
            }
            dragging = false;
            const [x, y] = event.get_coords();
            const region: Region = {
                x: Math.round(Math.min(startX, x)),
                y: Math.round(Math.min(startY, y)),
                w: Math.round(Math.abs(x - startX)),
                h: Math.round(Math.abs(y - startY)),
            };
            finish(region.w < 4 || region.h < 4 ? null : region);
            return Clutter.EVENT_STOP;
        });

        overlay.connect('key-press-event', (_actor, event: Clutter.Event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                finish(null);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        overlay.grab_key_focus();
    });
}
