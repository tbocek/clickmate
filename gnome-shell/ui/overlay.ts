// On-screen chrome: the position marker and the drag-to-select region picker.
// Status text lives in the panel menu, not in a floating overlay.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type { Region } from '../src/model.js';

/** How long a Show marker stays on screen. */
const MARKER_DURATION_MS = 5000;

let markerTimeoutId = 0;
/**
 * Every actor the current marker put on screen. Tracked as a list because the
 * marker is more than one actor: keeping only the container meant a second Show
 * within the timeout cancelled the first timeout and orphaned its label, which
 * then had nothing left to remove it and stayed until logout.
 */
let markerActors: St.Widget[] = [];

/** Take down whatever marker is showing, if any. */
export function clearMarker(): void {
    if (markerTimeoutId) {
        GLib.source_remove(markerTimeoutId);
        markerTimeoutId = 0;
    }
    for (const actor of markerActors) {
        Main.layoutManager.removeChrome(actor);
        actor.destroy();
    }
    markerActors = [];
}

/**
 * Briefly draw an X over a screen position, or an outline over a region, so a
 * coordinate in the editor can be checked against the actual screen. Purely
 * visual: it sits above every window and does not take input.
 */
export function showMarker(x: number, y: number, w?: number, h?: number, durationMs = MARKER_DURATION_MS): void {
    clearMarker();

    const isRegion = typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0;
    const container = new St.Widget({ style_class: 'clickmate-marker', reactive: false });

    if (isRegion) {
        container.set_position(Math.round(x), Math.round(y));
        container.set_size(Math.round(w!), Math.round(h!));
        container.add_style_class_name('clickmate-marker-region');
    } else {
        const size = 44;
        container.set_size(size, size);
        container.set_position(Math.round(x) - size / 2, Math.round(y) - size / 2);

        // Two bars rotated into an X, pivoted on their own centre.
        for (const angle of [45, -45]) {
            const bar = new St.Widget({ style_class: 'clickmate-marker-bar' });
            bar.set_size(size, 3);
            bar.set_position(0, size / 2 - 1);
            bar.set_pivot_point(0.5, 0.5);
            bar.rotation_angle_z = angle;
            container.add_child(bar);
        }
    }

    const label = new St.Label({
        style_class: 'clickmate-marker-label',
        text: isRegion ? `${x},${y} ${w}\u00d7${h}` : `${x}, ${y}`,
    });
    // Below the marker, unless that would run off the bottom of the screen.
    const labelY = y + (isRegion ? h! : 24) + 6;
    const fits = labelY < global.stage.height - 30;

    Main.layoutManager.addChrome(container, { affectsInputRegion: false });
    Main.layoutManager.addChrome(label, { affectsInputRegion: false });
    label.set_position(Math.round(x), Math.round(fits ? labelY : y - 34));

    markerActors = [container, label];
    markerTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, durationMs, () => {
        markerTimeoutId = 0;   // cleared first: this source is already firing
        clearMarker();
        return GLib.SOURCE_REMOVE;
    });
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
