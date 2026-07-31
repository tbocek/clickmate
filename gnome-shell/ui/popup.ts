// The panel popup. Deliberately tiny: a master switch, what is running, what
// went wrong, and a way into the editor. All macro editing lives in the
// preferences window.

import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import type { MacroStore } from '../src/store.js';
import { clearProblems, listProblems, onProblemsChanged, type Problem } from '../src/problems.js';

export interface PopupDeps {
    store: MacroStore;
    isRunning: () => boolean;
    isPaused: () => boolean;
    isRecording: () => boolean;
    onEnabledChanged: (enabled: boolean) => void;
    onOpenPreferences: () => void;
}

/**
 * How many failures the popup lists. The rest stay in the log behind the count,
 * because a menu long enough to scroll is worse than a menu that says "and 12
 * more" — and the journal has all of them either way.
 */
const SHOWN_PROBLEMS = 4;

/** Wrap a label instead of letting one long endpoint URL widen the whole menu. */
function wrappingLabel(text: string, styleClass: string): St.Label {
    const label = new St.Label({ text, style_class: styleClass });
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

export class MacroPopup {
    private _deps: PopupDeps;
    private _switchItem: PopupMenu.PopupSwitchMenuItem;
    private _statusLabel: St.Label;
    private _detailLabel: St.Label;
    private _updatingSwitch = false;
    private _message = '';

    private _problemItem: PopupMenu.PopupBaseMenuItem;
    private _problemHeader: St.Label;
    private _problemList: St.BoxLayout;
    private _clearItem: PopupMenu.PopupMenuItem;
    private _unsubscribe: () => void;

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
        this._detailLabel = wrappingLabel('', 'clickmate-detail');
        this._detailLabel.visible = false;

        this._problemItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._problemHeader = new St.Label({ text: '', style_class: 'clickmate-problems-title' });
        this._problemList = new St.BoxLayout({ vertical: true, style_class: 'clickmate-problems' });
        this._clearItem = new PopupMenu.PopupMenuItem('Clear problems');
        this._clearItem.connect('activate', () => clearProblems());

        // The list is built while the menu is closed as often as not, so keep it
        // current rather than rebuilding it on open: the count is also what the
        // indicator icon uses to decide whether to warn.
        this._unsubscribe = onProblemsChanged(() => this._refreshProblems());
    }

    addTo(menu: PopupMenu.PopupMenu): void {
        menu.addMenuItem(this._switchItem);

        const statusItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const box = new St.BoxLayout({ vertical: true, style_class: 'clickmate-status-box' });
        box.add_child(this._statusLabel);
        box.add_child(this._detailLabel);
        statusItem.add_child(box);
        menu.addMenuItem(statusItem);

        const problemBox = new St.BoxLayout({ vertical: true, style_class: 'clickmate-status-box' });
        const heading = new St.BoxLayout({ style_class: 'clickmate-problems-heading' });
        heading.add_child(new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            style_class: 'clickmate-problems-icon popup-menu-icon',
        }));
        heading.add_child(this._problemHeader);
        problemBox.add_child(heading);
        problemBox.add_child(this._problemList);
        this._problemItem.add_child(problemBox);

        // The rule above the problems is drawn in CSS rather than with a
        // PopupSeparatorMenuItem: the menu manages a separator's visibility
        // itself, and would fight the show/hide this section needs.
        menu.addMenuItem(this._problemItem);
        menu.addMenuItem(this._clearItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._deps.onOpenPreferences());
        menu.addMenuItem(settingsItem);

        this._refreshProblems();
    }

    destroy(): void {
        this._unsubscribe();
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

        this._refreshProblems();
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

    private _refreshProblems(): void {
        const problems = listProblems();
        const visible = problems.length > 0;

        this._problemItem.visible = visible;
        this._clearItem.visible = visible;
        if (!visible) {
            this._problemList.destroy_all_children();
            return;
        }

        this._problemHeader.text = problems.length === 1
            ? '1 problem'
            : `${problems.length} problems`;

        this._problemList.destroy_all_children();
        for (const problem of problems.slice(0, SHOWN_PROBLEMS)) {
            this._problemList.add_child(this._problemWidget(problem));
        }
        if (problems.length > SHOWN_PROBLEMS) {
            this._problemList.add_child(new St.Label({
                text: `and ${problems.length - SHOWN_PROBLEMS} more — see journalctl /usr/bin/gnome-shell`,
                style_class: 'clickmate-problem-hint',
            }));
        }
    }

    private _problemWidget(problem: Problem): St.BoxLayout {
        const box = new St.BoxLayout({ vertical: true, style_class: 'clickmate-problem' });

        const repeat = problem.count > 1 ? ` (×${problem.count})` : '';
        box.add_child(wrappingLabel(
            `${problem.time}  ${problem.source} — ${problem.message}${repeat}`,
            'clickmate-problem-message',
        ));
        if (problem.where) {
            box.add_child(wrappingLabel(`in ${problem.where}`, 'clickmate-problem-hint'));
        }
        if (problem.hint) {
            box.add_child(wrappingLabel(problem.hint, 'clickmate-problem-hint'));
        }
        return box;
    }
}
