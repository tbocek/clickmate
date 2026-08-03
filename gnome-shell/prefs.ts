// The full macro editor. Runs in its own process, so it can use GTK4/Adwaita
// widgets and cannot block the compositor.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    CONDITION_TYPE_LABELS,
    AUTHORABLE_STEP_KINDS as STEP_KINDS,
    STEP_KIND_LABELS,
    type ClickStep,
    type Condition,
    type ConditionType,
    type LlmCondition,
    type Macro,
    type MouseButton,
    type MoveStep,
    type Region,
    type Step,
    type StepKind,
    childLists,
    describeCondition,
    describeStep,
    emptyDocument,
    findStep,
    macroEnabled,
    moveStepNested,
    newCondition,
    newMacro,
    newStep,
    parseDocument,
    parseNumbers,
    removeStep,
    stringifyDocument,
    walk,
} from './src/model.js';
import { MacroStore } from './src/store.js';
import { buildInstruction, testConnection } from './src/llm.js';

const CONDITION_TYPES: ConditionType[] = ['always', 'llm', 'color', 'and', 'or', 'not'];

const MACROS_FILE = 'macroclickwerk-macros.json';
const SETTINGS_FILE = 'macroclickwerk-settings.json';

/**
 * Keys the settings file leaves alone. The macros live in their own export, and
 * the rest is live state — what is running, and the request/answer keys
 * preferences uses to talk to the shell. Importing any of those would either
 * clobber the other export or replay a stale request.
 */
const NOT_SETTINGS = [
    'macros', 'active-macro-id', 'running-steps', 'record-into', 'recording',
];

function isTransferableKey(key: string): boolean {
    return !NOT_SETTINGS.includes(key) && !key.endsWith('-request') && !key.endsWith('-result');
}


/**
 * Screenshots are scaled by width, so on the 16:9 screen these names come from
 * the width is the resolution: 1280 across is what "720p" means. Stored as the
 * width itself, which is what the setting has always held.
 */
const SCALE_WIDTHS = ['854', '1280', '1920', '2560', '3840'] as const;

/**
 * Built when asked for, not held in a constant: gettext refuses to run while
 * this module is still being imported — it identifies the extension from the
 * call stack, and the object it would translate for does not exist yet — so a
 * top-level table of translated strings takes the whole window down with it.
 */
function scaleLabels(): Record<string, string> {
    return {
        '854': _('480p — 854 px wide'),
        '1280': _('720p — 1280 px wide'),
        '1920': _('1080p — 1920 px wide'),
        '2560': _('1440p — 2560 px wide'),
        '3840': _('4K — 3840 px wide'),
    };
}

/**
 * The nearest listed width that is not *smaller* than the stored one. Settings
 * written before this was a list hold arbitrary numbers, and rounding up keeps
 * answers at least as accurate as they were.
 */
function scaleWidthFor(width: number): typeof SCALE_WIDTHS[number] {
    return SCALE_WIDTHS.find(option => Number(option) >= width) ?? SCALE_WIDTHS[SCALE_WIDTHS.length - 1];
}

/** The nested step lists a container step owns, as the editor draws them. */
type BranchKind = 'body' | 'then' | 'else';

/**
 * A step reads as a line of a program, so it gets the same icon everywhere and
 * the icon carries the kind — leaving the title free for the actual parameters.
 */
const STEP_ICONS: Record<StepKind, string> = {
    click: 'input-mouse-symbolic',
    move: 'find-location-symbolic',
    scroll: 'view-sort-descending-symbolic',
    key: 'input-keyboard-symbolic',
    text: 'insert-text-symbolic',
    wait: 'alarm-symbolic',
    loop: 'media-playlist-repeat-symbolic',
    if: 'media-playlist-shuffle-symbolic',
    break: 'application-exit-symbolic',   // an arrow leaving: out of the loop, not the macro
    continue: 'media-skip-forward-symbolic',
    start: 'view-refresh-symbolic',       // start, and start again: the same request
    stop: 'process-stop-symbolic',
};

/** The buttons a click can use, in the order they are offered. */
const MOUSE_BUTTONS: MouseButton[] = ['left', 'right', 'middle', 'side', 'extra'];

/**
 * Built on demand, not at file scope: gettext is not ready when this module is
 * imported, and translating there fails the import outright.
 */
const mouseButtonLabels = (): Record<MouseButton, string> => ({
    left: _('Left'),
    right: _('Right'),
    middle: _('Middle'),
    side: _('Side'),
    extra: _('Extra'),
});

/** What a key step can do, in the order it is offered. */
const KEY_ACTIONS = ['tap', 'down', 'up'] as const;

/**
 * Built on demand, for the same reason mouseButtonLabels is. One word each,
 * where the old rows had a sentence: a dropdown is as wide as its longest
 * entry, and "Press and keep held" made every row in the window wider than it
 * had room for. The line these sit on already reads "Hold down ctrl+c", so the
 * sentence was being said twice; the tooltip keeps the long form.
 */
const keyActionLabels = (): Record<string, string> => ({
    tap: _('Press'),
    down: _('Hold'),
    up: _('Release'),
});

/**
 * The kinds worth a play button: one action each, over as soon as it is done.
 * A loop or an `if` would drag its whole body along, and an endless loop would
 * drag the session with it — from a window that has no Stop. `break` and the
 * rest only mean something inside a run, so on their own they do nothing.
 */
const RUNNABLE_ALONE: StepKind[] = ['click', 'move', 'scroll', 'key', 'text', 'wait'];

/**
 * Only `then` and `else` get a header row of their own — a loop has one body
 * and shows it in the loop's own row, so of `body` only the hint is used, on
 * that row.
 */
const BRANCH_STYLE: Record<BranchKind, { icon: string; title: string; hint: string }> = {
    body: {
        icon: 'media-playlist-repeat-symbolic',
        title: 'Body',
        hint: 'runs on every iteration',
    },
    then: {
        icon: 'object-select-symbolic',
        title: 'Yes',
        hint: 'runs when the check holds',
    },
    else: {
        icon: 'window-close-symbolic',
        title: 'No',
        hint: 'runs when it does not',
    },
};

/**
 * Nesting is the thing you have to be able to read at a glance, and stacked
 * expander rows on their own do not show it. Every body gets a coloured rail
 * down its left edge — one colour per branch — that spans everything inside it,
 * and the steps within are indented under that one rail. Exactly one rail per
 * level of nesting: giving the steps their own rail as well only drew the same
 * boundary twice, a hand's width apart. The running step and the loops it sits
 * in are lit up on top of that.
 *
 * Every rail is an inset box-shadow rather than a border. A border is part of
 * the box, so a row that gains one when you select it shoves its own text 4px
 * sideways — the whole page twitches as the selection moves. A shadow is
 * painted inside the box it already had, so nothing moves. It also means the
 * state rails simply overwrite the branch rail instead of stacking beside it.
 */
const EDITOR_CSS = `
.macroclickwerk-branch {
    box-shadow: inset 4px 0 0 alpha(@accent_bg_color, 0.85);
    background-color: alpha(@accent_bg_color, 0.06);
}
.macroclickwerk-branch-then {
    box-shadow: inset 4px 0 0 alpha(@success_color, 0.9);
    background-color: alpha(@success_color, 0.06);
}
.macroclickwerk-branch-else {
    box-shadow: inset 4px 0 0 alpha(@warning_color, 0.9);
    background-color: alpha(@warning_color, 0.06);
}

.macroclickwerk-running {
    background-color: alpha(@accent_bg_color, 0.28);
    box-shadow: inset 4px 0 0 @accent_bg_color;
}
.macroclickwerk-running-block { box-shadow: inset 4px 0 0 @accent_bg_color; }
.macroclickwerk-running-icon { color: @accent_bg_color; }
.macroclickwerk-running-parent-icon { color: alpha(@accent_bg_color, 0.7); }

/* Where recorded steps land. Faint while it is only a choice; unmistakable
   while the recording is actually running and the next click goes in here. A
   row that opens gets the rail only — a fill would run down everything inside
   it and read as though all of that were selected too. */
.macroclickwerk-record-target {
    background-color: alpha(@error_color, 0.10);
    box-shadow: inset 4px 0 0 alpha(@error_color, 0.55);
}
.macroclickwerk-record-target-block { box-shadow: inset 4px 0 0 alpha(@error_color, 0.55); }
.macroclickwerk-recording-now {
    background-color: alpha(@error_color, 0.28);
    box-shadow: inset 4px 0 0 @error_color;
}
.macroclickwerk-recording-now-block { box-shadow: inset 4px 0 0 @error_color; }
`;

/** How far a step inside a body sits in from the rail of that body. */
const INDENT_PX = 12;

/**
 * How long a rebuilt page is given to settle before the scroll position is left
 * alone again. Long enough for the frames that empty and refill it, short
 * enough that a later resize — an expander opening — is your doing, not ours.
 */
const SCROLL_SETTLE_MS = 400;

function debounce(fn: () => void, ms = 400): () => void {
    let sourceId = 0;
    return () => {
        if (sourceId) {
            GLib.source_remove(sourceId);
        }
        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            sourceId = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    };
}

/** Shared tail of entryRow and passwordRow: the initial text and a debounced commit. */
function commitOnChange(row: Adw.EntryRow, value: string, onChange: (text: string) => void): Adw.EntryRow {
    row.set_text(value);
    row.connect('changed', debounce(() => onChange(row.get_text() ?? '')));
    return row;
}

function entryRow(title: string, value: string, onChange: (text: string) => void): Adw.EntryRow {
    return commitOnChange(new Adw.EntryRow({ title }), value, onChange);
}

/** An entry that masks what is typed with dots, for secrets; the reveal eye is built in. */
function passwordRow(title: string, value: string, onChange: (text: string) => void): Adw.EntryRow {
    return commitOnChange(new Adw.PasswordEntryRow({ title }), value, onChange);
}

function spinRow(
    title: string,
    value: number,
    lower: number,
    upper: number,
    step: number,
    onChange: (value: number) => void,
): Adw.SpinRow {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({ lower, upper, stepIncrement: step, value }),
    });
    row.connect('notify::value', () => onChange(row.get_value()));
    return row;
}

function comboRow<T extends string>(
    title: string,
    options: readonly T[],
    labels: Record<string, string>,
    selected: T,
    onChange: (value: T) => void,
): Adw.ComboRow {
    const model = new Gtk.StringList();
    for (const option of options) {
        model.append(labels[option] ?? option);
    }
    const row = new Adw.ComboRow({
        title,
        model,
        selected: Math.max(0, options.indexOf(selected)),
    });
    // Tracked rather than compared against the initial value, so picking A, B, A
    // still reports the last change. The empty string is a real choice — "this
    // macro", "from the top" — so only out-of-range reads are dropped.
    let current = selected;
    row.connect('notify::selected', () => {
        const value = options[row.get_selected()];
        if (value !== undefined && value !== current) {
            current = value;
            onChange(value);
        }
    });
    return row;
}

/**
 * The number half of spinRow, without the row, for when it belongs beside
 * another setting instead of on a line of its own. Whole numbers only — every
 * one of these counts something: milliseconds, pixels, how far off a colour is.
 */
function spinSuffix(
    value: number,
    lower: number,
    upper: number,
    step: number,
    tooltip: string,
    onChange: (value: number) => void,
): Gtk.SpinButton {
    const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({
            lower, upper, stepIncrement: step, pageIncrement: step * 10, value,
        }),
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        numeric: true,
        // Sized to the largest number it can hold, plus a minus sign where
        // there can be one, but capped: a wait may run to an hour, and a field
        // sized for 3600000 is a wide field on every row that a wait is not.
        // Past the cap it scrolls — the value stays whole, only its widest end
        // is out of view, and that end is the rare one.
        width_chars: Math.min(5, Math.max(3, `${upper}`.length + (lower < 0 ? 1 : 0))),
    });
    spin.connect('value-changed', () => onChange(spin.get_value_as_int()));
    return spin;
}

/**
 * The chooser half of comboRow, without the row, for when it belongs beside
 * another setting instead of on a line of its own. Same change tracking.
 */
function chooser<T extends string>(
    options: readonly T[],
    labels: Record<string, string>,
    selected: T,
    tooltip: string,
    onChange: (value: T) => void,
): Gtk.DropDown {
    const model = new Gtk.StringList();
    for (const option of options) {
        model.append(labels[option] ?? option);
    }
    const dropdown = new Gtk.DropDown({
        model,
        selected: Math.max(0, options.indexOf(selected)),
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
    });
    let current = selected;
    dropdown.connect('notify::selected', () => {
        const value = options[dropdown.get_selected()];
        if (value !== undefined && value !== current) {
            current = value;
            onChange(value);
        }
    });
    return dropdown;
}

function iconButton(iconName: string, tooltip: string, onClick: () => void): Gtk.Button {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', onClick);
    return button;
}

/** The toggle sibling of `iconButton`: same flat row-suffix styling. */
function toggleButton(iconName: string, tooltip: string, active: boolean): Gtk.ToggleButton {
    return new Gtk.ToggleButton({
        icon_name: iconName,
        tooltip_text: tooltip,
        active,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
}

/** As tall as a popover is allowed to get before its text starts scrolling. */
const POPOVER_MAX_H = 420;

/**
 * A ⓘ that opens a popover. For guidance too long for a subtitle and too small
 * for documentation nobody opens, kept next to the field it is about.
 *
 * The text scrolls. A label alone cannot be made shorter than its own wrapped
 * height, so a long one gives the popover a minimum size it cannot meet next to
 * a row near the edge of the screen — and a popover with nowhere to go simply
 * does not appear, which reads as a dead button.
 */
function infoButton(tooltip: string, markup: string, width = 46): Gtk.MenuButton {
    const label = new Gtk.Label({
        label: markup,
        use_markup: true,
        wrap: true,
        xalign: 0,
        max_width_chars: width,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    const scroller = new Gtk.ScrolledWindow({
        child: label,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        propagate_natural_width: true,
        propagate_natural_height: true,
        max_content_height: POPOVER_MAX_H,
    });
    return new Gtk.MenuButton({
        icon_name: 'help-about-symbolic',
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        popover: new Gtk.Popover({ child: scroller }),
    });
}

/**
 * What actually decides whether a check works: advice first, then the wrapper
 * your words go into, word for word. The wrapper is built from the real thing
 * rather than described, so it cannot quietly stop being true — and having it
 * under the advice is what makes the advice obviously follow: the instruction
 * asks for true or false about one statement, so a statement lands and a
 * question invites prose.
 */
function promptHelp(): string {
    const instruction = buildInstruction(_('…your words go here…'));
    return [
        _('<b>Write a statement, not a question.</b>'),
        '',
        _('<b>Lands:</b>  the button on the left is green'),
        _('<b>Fragile:</b>  Is the button on the left green?'),
        '',
        _('• One visible fact at a time. “green and enabled” gives the model room to be half right.'),
        _('• Say where it is: “the button at the bottom right”.'),
        _('• Skip “not”. Set <b>Proceed when the answer is</b> to No instead.'),
        _('• Reading the reply is lenient: yes, YES, true, 1 and a JSON object are all understood, in any case. Only a reply with no yes or no anywhere in it counts as a failure, and then <b>If the request fails</b> decides what happens.'),
        '',
        _('A tight <b>Screen area</b> helps more than any wording.'),
        '',
        _('<b>Your words are not sent on their own.</b> Every check sends the screenshot together with this, your text on the STATEMENT line:'),
        '',
        `<tt>${GLib.markup_escape_text(instruction, -1)}</tt>`,
    ].join('\n');
}

/** What highlighting a running step needs to get at, per step id. */
interface StepRow {
    /** An expander when the step has settings of its own, a plain row when not. */
    row: Adw.ActionRow | Adw.ExpanderRow;
    icon: Gtk.Image;
    kindIcon: string;
    /** Loops and ifs get a rail rather than a fill: a fill would flood the body. */
    container: boolean;
    /** The Body/Then/Else headers that follow this row, lit up along with it. */
    branchRows: Adw.ExpanderRow[];
}

export default class MacroclickwerkPreferences extends ExtensionPreferences {
    private _settings!: Gio.Settings;
    private _store!: MacroStore;
    private _window?: Adw.PreferencesWindow;
    private _macrosPage!: Adw.PreferencesPage;
    private _macroGroups: Adw.PreferencesGroup[] = [];

    // Structural edits rebuild the whole page, which would otherwise collapse
    // every expander. Expansion is keyed by step id so it survives a rebuild.
    private _expanded = new Set<string>();
    private _collapsed = new Set<string>();
    private _rebuilding = false;
    private _rebuildScheduled = false;
    // Seeded from the clock, not 0: a reopened preferences window would otherwise
    // restart at 1 and could write a request identical to a previous one, which
    // GSettings does not signal.
    private _requestSerial = GLib.get_real_time();
    private _closed = false;

    // Rows the shell's running position is painted onto. Rebuilt with the page,
    // so highlighting can toggle style classes instead of rebuilding anything.
    private _stepRows = new Map<string, StepRow>();
    private _highlighted: string[] = [];
    private _runningChangedId = 0;
    /** The ▶/■ beside each macro's name, by macro id. */
    private _runButtons = new Map<string, Gtk.Button>();
    /** The Stop beside each ▶, shown only while that macro is running. */
    private _stopButtons = new Map<string, Gtk.Button>();

    // The selected row: click one and a recording goes there, and the macro
    // holding it continues from there. One across the whole page, in whichever
    // macro. Kept in settings rather than in a widget because the shell is what
    // acts on it, and because a rebuild of the page must not lose it.
    // "end:<macroId>" is the end of a macro, "after:<stepId>" a step,
    // "in:<stepId>:<branch>" a body.
    private _targetRows = new Map<string, Gtk.Widget>();
    private _recordControls: Gtk.Widget[] = [];
    /** Shared dropdown models: the choices never differ between rows. */
    private _stepKindsModel?: Gtk.StringList;
    private _recordChoicesModel?: Gtk.StringList;
    /** The row currently painted as the target, so it can be unpainted. */
    private _markedRow?: Gtk.Widget;
    private _targetChangedId = 0;
    private _recordingChangedId = 0;

    // The Body/Then/Else headers by "stepId:branch". Move up and down ask these
    // whether a container is open, because folded or not is a fact about the
    // window, not about the document.
    private _branchRows = new Map<string, Adw.ExpanderRow>();

    // Every page but Macros. Their rows read the settings once, when built, so
    // importing settings has to build them again to show what arrived.
    private _settingsPages: Adw.PreferencesPage[] = [];

    /**
     * One text field for a group of related numbers — a point, an offset, a
     * rectangle — instead of a stack of spin rows. `onShow`, when given, adds a
     * button that flashes the position on the actual screen, which is the only
     * thing that makes a raw coordinate meaningful.
     */
    private _numbersRow(
        title: string,
        values: number[],
        onChange: (values: number[]) => void,
        onShow?: (values: number[]) => void,
        /**
         * Turns a position picked off the screen into the whole row. Given the
         * point and what the row holds now, so a rectangle can keep its size and
         * move its corner. Adds a **Pick** button when supplied.
         */
        fromPoint?: (x: number, y: number, current: number[]) => number[],
    ): Adw.EntryRow {
        const row = new Adw.EntryRow({ title });
        row.set_text(values.join(', '));

        let current = [...values];
        const commit = debounce(() => {
            const parsed = parseNumbers(row.get_text() ?? '', values.length);
            if (parsed) {
                row.remove_css_class('error');
                current = parsed;
                onChange(parsed);
            } else {
                row.add_css_class('error');
            }
        });
        row.connect('changed', commit);

        if (fromPoint) {
            const pick = new Gtk.Button({
                label: _('Pick'),
                tooltip_text: _('Go to the spot and click: that position lands here'),
                valign: Gtk.Align.CENTER,
            });
            pick.connect('clicked', () => this._pickPointInto(point => {
                const parsed = parseNumbers(row.get_text() ?? '', values.length) ?? current;
                const next = fromPoint(point.x, point.y, parsed);
                // Through the row, so the same parse-and-commit path runs and
                // what you see is what was saved.
                row.set_text(next.join(', '));
            }));
            row.add_suffix(pick);
        }

        if (onShow) {
            const show = new Gtk.Button({
                label: _('Show'),
                tooltip_text: _('Flash this position on the screen for a couple of seconds'),
                valign: Gtk.Align.CENTER,
            });
            show.connect('clicked', () => {
                const parsed = parseNumbers(row.get_text() ?? '', values.length) ?? current;
                onShow(parsed);
            });
            row.add_suffix(show);
        }

        return row;
    }


    /**
     * A pair of numbers as a field on a row rather than a row of its own, so a
     * position can share one line with the buttons that act on it.
     */
    private _numbersEntry(values: number[], onChange: (values: number[]) => void): Gtk.Entry {
        const entry = new Gtk.Entry({
            text: values.join(', '),
            placeholder_text: 'x, y',
            width_chars: 10,
            max_width_chars: 12,
            valign: Gtk.Align.CENTER,
            xalign: 1,
        });
        const commit = debounce(() => {
            const parsed = parseNumbers(entry.get_text() ?? '', values.length);
            if (parsed) {
                entry.remove_css_class('error');
                onChange(parsed);
            } else {
                entry.add_css_class('error');
            }
        });
        entry.connect('changed', commit);
        return entry;
    }

    /**
     * Where a click or a move goes, in one row: the numbers, and buttons that
     * say whether they are used at all. It used to be two rows — a dropdown
     * naming a mode, and under it the coordinates the mode was about — which is
     * a line of prose and a line of numbers to say one thing.
     *
     * Three states, one row. Coordinates are a place on the screen, with
     * **Pick** and **Show** beside them. `onModeName` is the step's own
     * alternative — 'current' for a click, 'rel' for a move — described by
     * `on`. And either step can aim at 'prev', back to where the pointer was
     * before the last positioned step; that state reads the same on both, so
     * everything about it lives here rather than with the callers. A move can
     * additionally offer 'store' via `store` — remember the spot rather than
     * go anywhere — which is the other half of 'prev': one marks, one returns.
     */
    private _positionRow(opts: {
        step: ClickStep | MoveStep;
        toggleIcon: string;
        toggleTip: string;
        onModeName: 'current' | 'rel';
        off: { title: string; values: () => number[] };
        on: { title: string; subtitle?: string; values?: () => number[] };
        store?: { title: string; subtitle?: string };
        apply: (values: number[]) => void;
    }): Adw.ActionRow {
        type RowState = { title: string; subtitle?: string; values?: () => number[] };
        const prevState: RowState = {
            title: _('Position'),
            subtitle: _('Where the pointer was before the last positioned step'),
        };
        const storeState: RowState | null = opts.store ?? null;
        const row = new Adw.ActionRow();
        let mode: 'off' | 'on' | 'prev' | 'store' =
            opts.step.mode === 'prev' ? 'prev'
            : storeState && opts.step.mode === 'store' ? 'store'
            : opts.step.mode === opts.onModeName ? 'on' : 'off';
        const state = (): RowState =>
            mode === 'prev' ? prevState
            : mode === 'store' && storeState ? storeState
            : mode === 'on' ? opts.on : opts.off;

        const entry = this._numbersEntry(opts.off.values(), values => {
            opts.apply(values);
            this._refreshStepTitle(opts.step);
            this._save();
        });
        const point = (): [number, number] => {
            const parsed = parseNumbers(entry.get_text() ?? '', 2);
            return [parsed?.[0] ?? 0, parsed?.[1] ?? 0];
        };
        const pick = iconButton('find-location-symbolic',
            _('Go to the spot and click: that position lands here'),
            () => this._pickPointInto(({ x, y }) => entry.set_text(`${x}, ${y}`)));
        const show = iconButton('view-reveal-symbolic',
            _('Flash this position on the screen for a couple of seconds'),
            () => this._showMarker(...point()));

        const toggle = toggleButton(opts.toggleIcon, opts.toggleTip, mode === 'on');
        const storeBtn = storeState ? toggleButton('bookmark-new-symbolic',
            _('Remember where the pointer is now: from here on, “previous” returns to this spot'),
            mode === 'store') : null;
        const history = toggleButton('document-open-recent-symbolic',
            _('Go back to where the pointer was before the last positioned step'), mode === 'prev');

        const sync = () => {
            const now = state();
            const numbers = now.values;
            row.set_title(now.title);
            row.set_subtitle(now.subtitle ?? '');
            entry.set_visible(Boolean(numbers));
            // 'off' is the state that means a place on the screen, in both
            // rows: a click's coordinates, a move's destination.
            pick.set_visible(mode === 'off');
            show.set_visible(mode === 'off');
            if (numbers) {
                entry.set_text(numbers().join(', '));
            }
        };
        // The mode variable drives the buttons, not the other way round: a
        // press proposes a mode, setMode settles both buttons to it, and the
        // guard keeps those programmatic settles from proposing again. Synced
        // in place rather than rebuilt: a rebuild would take the button you
        // just pressed down with it.
        let settling = false;
        const setMode = (next: 'off' | 'on' | 'prev' | 'store') => {
            mode = next;
            settling = true;
            toggle.set_active(mode === 'on');
            storeBtn?.set_active(mode === 'store');
            history.set_active(mode === 'prev');
            settling = false;
            // The one place the row's vocabulary meets the step's. Cast because
            // a union field only accepts writes both members allow.
            (opts.step as { mode: string }).mode =
                mode === 'on' ? opts.onModeName
                : mode === 'prev' ? 'prev'
                : mode === 'store' ? 'store' : 'abs';
            sync();
            this._refreshStepTitle(opts.step);
            this._save();
        };
        toggle.connect('toggled', () => {
            if (!settling) {
                setMode(toggle.get_active() ? 'on' : 'off');
            }
        });
        storeBtn?.connect('toggled', () => {
            if (!settling) {
                setMode(storeBtn.get_active() ? 'store' : 'off');
            }
        });
        history.connect('toggled', () => {
            if (!settling) {
                setMode(history.get_active() ? 'prev' : 'off');
            }
        });
        sync();

        row.add_suffix(entry);
        row.add_suffix(pick);
        row.add_suffix(show);
        row.add_suffix(toggle);
        if (storeBtn) {
            row.add_suffix(storeBtn);
        }
        row.add_suffix(history);
        return row;
    }

    /**
     * `defaultExpanded` opens a row the first time it is seen — bodies use it, so
     * opening a loop shows what is inside it rather than another closed row.
     * Collapsing is remembered separately, or the default would undo it on the
     * next rebuild.
     */
    private _expander(
        key: string,
        props: Partial<Adw.ExpanderRow.ConstructorProps>,
        defaultExpanded = false,
    ): Adw.ExpanderRow {
        const expanded = this._collapsed.has(key)
            ? false
            : defaultExpanded || this._expanded.has(key);
        const row = new Adw.ExpanderRow({ ...props, expanded });
        row.connect('notify::expanded', () => {
            if (this._rebuilding) {
                return; // teardown, not a user action
            }
            if (row.get_expanded()) {
                this._expanded.add(key);
                this._collapsed.delete(key);
            } else {
                this._expanded.delete(key);
                this._collapsed.add(key);
            }
        });
        return row;
    }

    /** Load the editor's own style classes once, on top of whatever theme is set. */
    private _installCss(): void {
        const display = Gdk.Display.get_default();
        if (!display) {
            return;
        }
        try {
            const provider = new Gtk.CssProvider();
            provider.load_from_string(EDITOR_CSS);
            Gtk.StyleContext.add_provider_for_display(
                display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        } catch (error) {
            // Cosmetic only: an unparsable rule must not cost you the editor.
            log(`macroclickwerk: could not load editor styles: ${(error as Error).message}`);
        }
    }

    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        this._window = window;
        this._settings = this.getSettings();
        this._store = new MacroStore(this._settings);
        this._installCss();

        this._macrosPage = new Adw.PreferencesPage({
            title: _('Macros'),
            iconName: 'view-list-symbolic',
        });
        window.add(this._macrosPage);
        this._addSettingsPages();

        this._rebuildMacros();

        // The shell writes to the same document — after recording, for instance.
        // Every step object we are holding is stale at that point, so rebuild.
        const unsubscribe = this._store.onChanged(external => {
            if (external) {
                this._rebuildMacros();
            }
        });

        // Where the shell's runner currently is. Only style classes change, so
        // this can arrive several times a second without disturbing an edit.
        this._runningChangedId = this._settings.connect(
            'changed::running-steps', () => this._applyRunningHighlight());
        // Both are painted by the same pass: the target only reads as a target
        // once you can see whether it is live.
        this._targetChangedId = this._settings.connect(
            'changed::record-into', () => this._applyRecordTarget());
        this._recordingChangedId = this._settings.connect(
            'changed::recording', () => this._applyRecordTarget());

        window.connect('close-request', () => {
            this._closed = true;
            unsubscribe();
            if (this._runningChangedId) {
                this._settings.disconnect(this._runningChangedId);
                this._runningChangedId = 0;
            }
            if (this._targetChangedId) {
                this._settings.disconnect(this._targetChangedId);
                this._targetChangedId = 0;
            }
            if (this._recordingChangedId) {
                this._settings.disconnect(this._recordingChangedId);
                this._recordingChangedId = 0;
            }
            this._store.destroy();
            return false;
        });
    }

    private _save(): void {
        this._store.save();
    }

    /**
     * Most rebuilds are triggered from a widget's own signal handler, which would
     * mean destroying that widget mid-emission. Defer to an idle so the handler
     * returns first; the flag also collapses several edits into one rebuild.
     */
    private _saveAndRebuild(): void {
        this._store.save();
        if (this._rebuildScheduled) {
            return;
        }
        this._rebuildScheduled = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildScheduled = false;
            if (!this._closed) {
                this._rebuildMacros();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- macros page -------------------------------------------------------

    /** The scrolled window the macros page puts its own content in. */
    private _scroller(widget: Gtk.Widget | null = this._macrosPage): Gtk.ScrolledWindow | null {
        for (let child = widget?.get_first_child() ?? null; child; child = child.get_next_sibling()) {
            if (child instanceof Gtk.ScrolledWindow) {
                return child;
            }
            const found = this._scroller(child);
            if (found) {
                return found;
            }
        }
        return null;
    }

    /**
     * A rebuild throws away every row and builds new ones, and the view goes
     * back to the top with them — so adding a step deep in a macro used to take
     * you away from the place you were editing.
     *
     * Setting the offset once is not enough. At the moment the rebuild returns,
     * neither the removal nor the additions have reached the adjustment yet, so
     * the value looks like it took; a frame later the page is briefly empty,
     * GTK clamps against that, and the view is at the top again. So put it back
     * on every change of geometry until the layout settles.
     *
     * The other way back to the top is the keyboard focus: whatever it lands on
     * gets scrolled into view. The rebuild drops the focus rather than let GTK
     * choose, but a popover closing after the rebuild — the list of a dropdown
     * you just picked from — can still hand it somewhere. So watch that too,
     * and put the view back after it.
     */
    private _restoreScroll(offset: number): void {
        const adjustment = this._scroller()?.get_vadjustment();
        if (!adjustment || offset <= 0) {
            return;
        }
        const put = () => {
            const max = Math.max(adjustment.get_upper() - adjustment.get_page_size(), 0);
            adjustment.set_value(Math.min(offset, max));
        };
        put();

        const undo: Array<() => void> = [];
        const adjustmentId = adjustment.connect('changed', put);
        undo.push(() => adjustment.disconnect(adjustmentId));

        const window = this._window;
        if (window) {
            const focusId = window.connect('notify::focus-widget', () => {
                // After the scrolled window has had its say about the new
                // focus, not before it.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    put();
                    return GLib.SOURCE_REMOVE;
                });
            });
            undo.push(() => window.disconnect(focusId));
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_SETTLE_MS, () => {
            while (undo.length > 0) {
                undo.pop()?.();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    private _rebuildMacros(): void {
        const offset = this._scroller()?.get_vadjustment().get_value() ?? 0;
        // Whatever had the keyboard focus is about to be destroyed — a dropdown
        // you just picked from, say. GTK would hand the focus to some other row
        // and scroll that one into view, undoing the restore below. It is gone
        // either way, so let go of it here rather than let GTK choose.
        this._window?.set_focus(null);
        this._rebuilding = true;
        for (const group of this._macroGroups) {
            this._macrosPage.remove(group);
        }
        this._macroGroups = [];
        this._rebuilding = false;
        // Every row just went away, so nothing is highlighted any more either.
        this._stepRows.clear();
        this._targetRows.clear();
        this._markedRow = undefined;
        this._runButtons.clear();
        this._stopButtons.clear();
        this._recordControls = [];
        this._branchRows.clear();
        this._highlighted = [];

        const actions = new Adw.PreferencesGroup({
            title: _('Macros'),
            description: _('Steps run top to bottom. Loops and conditions nest.'),
        });

        const addButton = new Gtk.Button({
            label: _('Add macro'),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => {
            this._store.addMacro(newMacro(`Macro ${this._store.macros.length + 1}`));
            this._rebuildMacros();
        });
        actions.set_header_suffix(addButton);

        actions.add(this._transferRow());

        this._macrosPage.add(actions);
        this._macroGroups.push(actions);

        if (this._store.macros.length === 0) {
            const empty = new Adw.PreferencesGroup();
            empty.add(new Adw.ActionRow({
                title: _('No macros yet'),
                subtitle: _('Add one, then record into it'),
            }));
            this._macrosPage.add(empty);
            this._macroGroups.push(empty);
            return;
        }

        for (const macro of this._store.macros) {
            const group = this._buildMacroGroup(macro);
            this._macrosPage.add(group);
            this._macroGroups.push(group);
        }

        // A rebuild in the middle of a run — after a recording, say — must not
        // lose the marker on the step the runner is on.
        this._applyRunningHighlight();
        this._applyRecordTarget();
        this._restoreScroll(offset);
    }

    // --- running position --------------------------------------------------

    /**
     * The shell publishes the chain of steps its runner is inside. Light up the
     * last one, and mark the loops and ifs above it: those stay visible even when
     * the step itself is inside a collapsed body.
     */
    private _applyRunningHighlight(): void {
        for (const id of this._highlighted) {
            const entry = this._stepRows.get(id);
            if (entry) {
                this._setRunState(entry, 'idle');
            }
        }
        this._highlighted = [];

        const paths = this._runningPaths();
        for (const { steps } of paths) {
            steps.forEach((id, index) => {
                const entry = this._stepRows.get(id);
                if (!entry) {
                    return; // a step just deleted
                }
                this._setRunState(entry, index === steps.length - 1 ? 'active' : 'ancestor');
                this._highlighted.push(id);
            });
        }

        // The ▶ beside each macro is the other half of this: a macro whose steps
        // are all inside folded bodies would otherwise show nothing at all.
        const running = new Set(paths.map(entry => entry.macro));
        for (const [macroId, button] of this._runButtons) {
            this._setRunButton(button, running.has(macroId));
        }
        // Nothing to stop until something runs, so the button is not there to
        // be pressed — the same rule the panel's Stop item follows.
        for (const [macroId, button] of this._stopButtons) {
            button.set_visible(running.has(macroId));
        }
    }

    private _setRunButton(button: Gtk.Button, running: boolean): void {
        button.set_icon_name(running
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic');
        button.set_tooltip_text(running
            ? _('Pause — the next ▶ continues from where this got to')
            : _('Run this macro now'));
        if (running) {
            button.add_css_class('macroclickwerk-running-icon');
        } else {
            button.remove_css_class('macroclickwerk-running-icon');
        }
    }

    /** The line under a macro's name: what the switch beside it means. */
    private _macroHint(macro: Macro): string {
        return macroEnabled(macro)
            ? _('On — runs with the others when you press Run')
            : _('Off — only runs from its own ▶');
    }

    /**
     * Paint the list a recording goes into, and turn it red while one is
     * actually running — the point of showing it here at all is that the panel
     * icon is a long way from the body you chose.
     */
    private _applyRecordTarget(): void {
        for (const cls of ['macroclickwerk-record-target', 'macroclickwerk-recording-now']) {
            this._markedRow?.remove_css_class(cls);
            this._markedRow?.remove_css_class(`${cls}-block`);
        }

        // A selection nothing on the page answers to — none yet, or one left in a
        // macro that has since gone — falls back to the end of the macro being
        // worked on, which is where the shell would put a recording anyway.
        const target = this._settings.get_string('record-into');
        const row = this._targetRows.get(target)
            ?? this._targetRows.get(`end:${this._store.activeMacro?.id ?? ''}`);
        this._markedRow = row;

        const recording = this._settings.get_string('recording') !== '';
        if (row) {
            const base = recording ? 'macroclickwerk-recording-now' : 'macroclickwerk-record-target';
            row.add_css_class(row instanceof Adw.ExpanderRow ? `${base}-block` : base);
        }

        // The record controls cannot start anything else during a whole
        // recording, and go red rather than dead so the reason is visible.
        for (const control of this._recordControls) {
            if (recording) {
                control.add_css_class('destructive-action');
            } else {
                control.remove_css_class('destructive-action');
            }
        }
    }

    /**
     * Is this body open on screen? What move up and down mean depends on it.
     * A block hidden under a collapsed if is as closed as a folded one.
     */
    private _isBranchOpen(stepId: string, listKey: string): boolean {
        const row = this._branchRows.get(`${stepId}:${listKey}`);
        return !!row && row.get_visible() && row.get_expanded();
    }

    /**
     * Clicking a row selects it, and a recording goes there: after a step, or
     * into a body. The click is watched on the way down rather than on the way
     * up, and the sequence is never claimed, so the row still does whatever it
     * did before — a step still folds open, a button still fires. Rows nest, and
     * capture order runs outermost first, so the innermost row you actually
     * clicked is the one that has the last word.
     *
     * There is one selection across every macro, so selecting here also says
     * which macro is the one being worked on — the shell records into that one.
     */
    private _selectable(row: Gtk.Widget, target: string, macroId: string): void {
        const click = new Gtk.GestureClick();
        click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        click.connect('pressed', () => this._selectTarget(macroId, target));
        row.add_controller(click);
        this._targetRows.set(target, row);
    }

    /**
     * Make a row's spot the selection: which macro is being worked on, and
     * where recordings land. Written only on change, so re-selecting the same
     * row does not churn `changed::` signals.
     */
    private _selectTarget(macroId: string, target: string): void {
        if (this._store.activeMacroId !== macroId) {
            this._store.activeMacroId = macroId;
        }
        if (this._settings.get_string('record-into') !== target) {
            this._settings.set_string('record-into', target);
        }
    }

    /** What the shell publishes: one chain of step ids per running macro. */
    private _runningPaths(): { macro: string; steps: string[] }[] {
        try {
            const raw = this._settings.get_string('running-steps');
            if (!raw) {
                return [];
            }
            const parsed = JSON.parse(raw) as { running?: unknown };
            if (!Array.isArray(parsed.running)) {
                return [];
            }
            return parsed.running
                .filter((entry): entry is { macro: string; steps: string[] } =>
                    !!entry && typeof entry.macro === 'string' && Array.isArray(entry.steps))
                .map(entry => ({
                    macro: entry.macro,
                    steps: entry.steps.filter(id => typeof id === 'string'),
                }));
        } catch {
            return [];
        }
    }

    private _runningMacroIds(): string[] {
        return this._runningPaths().map(entry => entry.macro);
    }

    private _setRunState(entry: StepRow, state: 'idle' | 'active' | 'ancestor'): void {
        for (const cls of ['macroclickwerk-running', 'macroclickwerk-running-block']) {
            entry.row.remove_css_class(cls);
        }
        for (const cls of ['macroclickwerk-running-icon', 'macroclickwerk-running-parent-icon']) {
            entry.icon.remove_css_class(cls);
        }
        entry.icon.icon_name = entry.kindIcon;
        for (const branch of entry.branchRows) {
            branch.remove_css_class('macroclickwerk-running-block');
        }

        if (state === 'active') {
            entry.icon.icon_name = 'media-playback-start-symbolic';
            entry.icon.add_css_class('macroclickwerk-running-icon');
            entry.row.add_css_class(entry.container ? 'macroclickwerk-running-block' : 'macroclickwerk-running');
        } else if (state === 'ancestor') {
            entry.icon.add_css_class('macroclickwerk-running-parent-icon');
            entry.row.add_css_class('macroclickwerk-running-block');
        }
        if (state !== 'idle') {
            // The body headers sit beside the step now, not inside it, so they
            // need the same rail or the chain of rails breaks at every loop.
            for (const branch of entry.branchRows) {
                branch.add_css_class('macroclickwerk-running-block');
            }
        }
    }

    /**
     * A dropdown that is also the button: its first entry is the label, and
     * picking any of the others acts there and then. Two clicks instead of
     * three, and no button left sitting next to a dropdown whose value you
     * already chose. The selection snaps back to the label before the action
     * runs, so the action is free to rebuild the page from under the widget.
     * `model` is shared between rows — the choices never differ, so one list
     * serves every rebuild.
     */
    private _actionDropdown(model: Gtk.StringList, onPick: (choice: number) => void): Gtk.DropDown {
        const dropdown = new Gtk.DropDown({ model, valign: Gtk.Align.CENTER });
        dropdown.connect('notify::selected', () => {
            const index = dropdown.get_selected();
            if (index < 1 || this._rebuilding) {
                return;   // the label itself, or the page being torn down
            }
            dropdown.set_selected(0);
            onPick(index - 1);
        });
        return dropdown;
    }

    private _addStepDropdown(into: Step[]): Gtk.DropDown {
        if (!this._stepKindsModel) {
            this._stepKindsModel = new Gtk.StringList();
            this._stepKindsModel.append(_('Add step…'));
            for (const kind of STEP_KINDS) {
                this._stepKindsModel.append(STEP_KIND_LABELS[kind]);
            }
        }
        return this._actionDropdown(this._stepKindsModel, choice => {
            into.push(newStep(STEP_KINDS[choice]));
            this._saveAndRebuild();
        });
    }

    /**
     * The "Add step here" row that ends a macro and every nested block: the
     * dropdown that appends into `into`, and a Record dropdown that captures
     * one step there or starts a whole recording landing there. `stepId` and
     * `listKey` name the nested body the row sits in, null for the macro
     * itself — the selection target is derived from them here, so the two
     * ways of recording cannot disagree about the spot.
     */
    private _addStepRow(into: Step[], macroId: string, stepId: string | null, listKey: string | null): Adw.ActionRow {
        const target = stepId ? `in:${stepId}:${listKey}` : `end:${macroId}`;
        const row = new Adw.ActionRow({ title: _('Add step here') });
        row.add_suffix(this._addStepDropdown(into));

        if (!this._recordChoicesModel) {
            this._recordChoicesModel = new Gtk.StringList();
            for (const label of [_('Record…'), _('One step'), _('Multiple steps')]) {
                this._recordChoicesModel.append(label);
            }
        }
        const record = this._actionDropdown(this._recordChoicesModel, choice => {
            if (choice === 0) {
                this._captureStepInto(macroId, stepId, listKey);
            } else {
                this._recordInto(macroId, target);
            }
        });
        record.set_tooltip_text(_('One step: click anywhere on screen, or move the pointer and hold still. ' +
            'Multiple steps: everything until recording is stopped'));
        this._recordControls.push(record);
        row.add_suffix(record);
        return row;
    }

    private _buildMacroGroup(macro: Macro): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: macro.name,
            description: this._macroHint(macro),
        });

        // Its own ▶, whether it is switched on or not: the switch is about the
        // next press of Run, this is about now. It turns into a Pause while the
        // macro is going, which is also how the editor shows that it is — the
        // panel icon is a long way from the window you are looking at.
        const runButton = iconButton('media-playback-start-symbolic',
            _('Run this macro now'),
            () => this._runMacroNow(macro.id,
                this._runningMacroIds().includes(macro.id) ? 'pause' : 'run'));
        this._runButtons.set(macro.id, runButton);

        // Beside it only while there is something to stop. Both end the run;
        // the difference is where the next ▶ begins — here, or at the top —
        // and that is a choice worth two buttons rather than one that guesses.
        const stopButton = iconButton('media-playback-stop-symbolic',
            _('Stop — the next ▶ starts from the top'),
            () => this._runMacroNow(macro.id, 'stop'));
        stopButton.set_visible(this._runningMacroIds().includes(macro.id));
        this._stopButtons.set(macro.id, stopButton);

        const enabled = new Gtk.Switch({
            active: macroEnabled(macro),
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Include this macro when you press Run'),
        });
        enabled.connect('notify::active', () => {
            macro.enabled = enabled.get_active();
            group.set_description(this._macroHint(macro));
            this._save();
        });

        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Delete this macro'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        remove.connect('clicked', () => {
            this._store.removeMacro(macro.id);
            this._rebuildMacros();
        });

        const header = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
        header.append(runButton);
        header.append(stopButton);
        header.append(enabled);
        header.append(remove);
        group.set_header_suffix(header);

        group.add(entryRow(_('Name'), macro.name, text => {
            macro.name = text;
            this._save();
        }));

        const addRow = this._addStepRow(macro.body, macro.id, null, null);
        this._selectable(addRow, `end:${macro.id}`, macro.id);

        for (const step of macro.body) {
            for (const widget of this._buildStepWidgets(macro, step)) {
                group.add(widget);
            }
        }
        // Under the steps, where what it adds will appear.
        group.add(addRow);

        return group;
    }

    /**
     * A step's title. Steps that name another macro say its name rather than
     * its id, so a renamed macro reads correctly everywhere it is referred to —
     * and likewise for the step a start begins at. Ids are unique across the
     * document, so the step is looked for in every macro rather than threading
     * through which one the caller is editing.
     */
    private _describe(step: Step): string {
        return describeStep(step, id => this._store.getMacro(id)?.name, stepId => {
            for (const macro of this._store.macros) {
                const loc = findStep(macro.body, stepId);
                if (loc) {
                    return describeStep(loc.step, id => this._store.getMacro(id)?.name);
                }
            }
            return undefined;
        });
    }

    /**
     * The title says what the step does, so a setting that changes that has to
     * put it right — a click that now goes somewhere else must not still be
     * headed "Click left @ 100,200". Updated in place: rebuilding would take the
     * field you are typing in with it.
     */
    private _refreshStepTitle(step: Step): void {
        this._stepRows.get(step.id)?.row.set_title(this._describe(step));
    }

    /** "3 steps", "empty" — the same phrasing wherever a body is counted. */
    private _countLabel(count: number): string {
        if (count === 0) {
            return _('empty');
        }
        return `${count} ${count === 1 ? _('step') : _('steps')}`;
    }

    /**
     * What a step says under its title: only what the title cannot, so a
     * collapsed loop still tells you it holds four steps. Everything else about
     * the step is already in the title, and a second line of grey saying it
     * again is a second line of grey.
     */
    private _stepSubtitle(step: Step): string {
        const parts: string[] = [];
        if (step.kind === 'loop') {
            // The body hangs off this row rather than off a header of its own,
            // so this line is the one that has to say what is in it.
            parts.push(`${this._countLabel(step.body.length)} — ${_(BRANCH_STYLE.body.hint)}`);
        } else if (step.kind === 'if') {
            // No first, in the order the two blocks are drawn below it.
            parts.push(`${this._countLabel((step.else ?? []).length)} ${_('else')}, ` +
                `${this._countLabel(step.then.length)} ${_('then')}`);
        }
        return parts.join(' — ');
    }

    /**
     * One step, followed by its Body/Then/Else blocks as sibling rows rather
     * than rows inside it — folding a loop shut to get at its settings must not
     * take its body off the screen with it.
     *
     * `indent` is how far in this row sits within whatever contains it. The rail
     * belongs to the enclosing body, not to the step, so a step draws none of
     * its own — the indent alone puts it under the right one.
     */
    private _buildStepWidgets(
        macro: Macro,
        step: Step,
        indent = 0,
    ): Gtk.Widget[] {
        const stepKey = `step:${step.id}`;
        const children = childLists(step);
        // A loop has one body and nothing to choose between, so it holds that
        // body itself instead of putting a "Body" header under it: the header
        // said what the "Repeat" row above it already said, and cost a row and a
        // level of indent for it. An `if` keeps its Yes and No headers — there
        // the header is the only thing saying which of the two you are reading.
        const inline = children.length === 1 && children[0].key === 'body';
        // A card that opens onto nothing is a card that should not open. Steps
        // with settings of their own keep the expander; the rest — a break, a
        // stop — are one line, and clicking them only selects them.
        const fields = this._buildStepFields(macro, step);
        const props = { title: this._describe(step), subtitle: this._stepSubtitle(step) };
        const row: Adw.ActionRow | Adw.ExpanderRow = fields.length > 0 || inline
            ? this._expander(stepKey, props,
                inline ? children[0].steps.length > 0 : children.length > 0)
            : new Adw.ActionRow(props);
        const widgets: Gtk.Widget[] = [row];
        const branchRows: Adw.ExpanderRow[] = [];

        row.set_margin_start(indent);

        const kindIcon = STEP_ICONS[step.kind];
        const icon = new Gtk.Image({ icon_name: kindIcon, valign: Gtk.Align.CENTER });

        // Affixes go in boxes of our own rather than one add_prefix/add_suffix
        // call each: AdwActionRow and AdwExpanderRow pack them in opposite
        // directions, so the same code produced mirrored rows depending on
        // whether the step had settings to fold open.
        const prefixes = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
        const suffixes = new Gtk.Box({ spacing: 0, valign: Gtk.Align.CENTER });
        prefixes.append(icon);
        row.add_prefix(prefixes);
        row.add_suffix(suffixes);
        this._stepRows.set(step.id, {
            row,
            icon,
            kindIcon,
            container: children.length > 0,
            branchRows,
        });

        // Settings small enough to read as part of the step's own sentence sit
        // on its line rather than behind a fold — "Repeat 10×", "Click left @
        // 840,512", "Press ctrl+c" — and the line says what they are, so they
        // need no titles of their own. What is left folded is what needs room:
        // coordinates with a Pick button, text, a list of modifiers.
        //
        // The title is the sentence these controls are words of, so it is
        // rewritten in place rather than by rebuilding the page — a rebuild
        // would close the dropdown you are still looking at.
        const retitle = () => row.set_title(this._describe(step));
        switch (step.kind) {
        // A repeat has exactly one setting, so it lives on the row rather than
        // behind a fold: the count, and a toggle for having no count at all.
        case 'loop': {
            // Not the loop's own kind icon, which already sits on this row:
            // repeat-song is the "keep going" variant of the same family.
            const forever = toggleButton('media-playlist-repeat-song-symbolic',
                _('Repeat without a limit'), step.count === 'forever');
            const count = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({
                    lower: 1, upper: 1000000, step_increment: 1, page_increment: 10,
                    value: typeof step.count === 'number' ? step.count : 10,
                }),
                tooltip_text: _('How many times to go round'),
                valign: Gtk.Align.CENTER,
                visible: step.count !== 'forever',
                numeric: true,
                width_chars: 3,
            });
            forever.connect('toggled', () => {
                step.count = forever.get_active() ? 'forever' : count.get_value_as_int();
                count.set_visible(!forever.get_active());
                retitle();
                this._save();
            });
            count.connect('value-changed', () => {
                if (forever.get_active()) {
                    return;
                }
                step.count = count.get_value_as_int();
                retitle();
                this._save();
            });
            suffixes.append(forever);
            suffixes.append(count);
            break;
        }

        // Same bargain the loop's count makes: a click is a button and a hold,
        // two small controls that are shorter than the fold they were hiding
        // behind, and they read as the line they sit on.
        case 'click':
            suffixes.append(chooser(MOUSE_BUTTONS, mouseButtonLabels(), step.button,
                _('Which mouse button'), value => {
                    step.button = value;
                    retitle();
                    this._save();
                }));
            suffixes.append(spinSuffix(step.holdMs ?? 20, 0, 10000, 5,
                _('How long the button stays down, in milliseconds'), value => {
                    step.holdMs = value;
                    this._save();
                }));
            break;

        // The same two words a click has, for the same reason: which, and for
        // how long — "Press ctrl+c", "Hold down shift".
        case 'key':
            suffixes.append(chooser(KEY_ACTIONS, keyActionLabels(), step.action,
                _('Whether to press, hold down, or release'), value => {
                    step.action = value;
                    retitle();
                    this._save();
                }));
            suffixes.append(spinSuffix(step.holdMs ?? 20, 0, 10000, 5,
                _('How long the key stays down, in milliseconds'), value => {
                    step.holdMs = value;
                    this._save();
                }));
            break;

        case 'text':
            suffixes.append(spinSuffix(step.delayMs ?? 12, 0, 1000, 1,
                _('Delay between keys, in milliseconds'), value => {
                    step.delayMs = value;
                    this._save();
                }));
            break;

        // Both numbers, and the line already reads "Wait 1s ±200ms", so the
        // card had nothing left to open onto.
        case 'wait':
            suffixes.append(spinSuffix(step.ms, 0, 3600000, 100,
                _('How long to wait, in milliseconds'), value => {
                    step.ms = value;
                    retitle();
                    this._save();
                }));
            suffixes.append(spinSuffix(step.jitterMs ?? 0, 0, 600000, 50,
                _('Vary each wait by up to this much, either way, in milliseconds'), value => {
                    step.jitterMs = value;
                    retitle();
                    this._save();
                }));
            break;

        case 'scroll':
            suffixes.append(spinSuffix(step.dx, -1000, 1000, 1,
                _('Horizontal scroll clicks'), value => {
                    step.dx = value;
                    retitle();
                    this._save();
                }));
            suffixes.append(spinSuffix(step.dy, -1000, 1000, 1,
                _('Vertical scroll clicks'), value => {
                    step.dy = value;
                    retitle();
                    this._save();
                }));
            break;

        default:
            break;
        }

        if (RUNNABLE_ALONE.includes(step.kind)) {
            suffixes.append(iconButton('media-playback-start-symbolic',
                _('Do this one step now, on the real screen'),
                () => this._runStepNow(macro.id, step)));
        }

        // Folded loops and ifs are passed over; open ones are moved into. What
        // you see is what a press does, which is why the editor decides and the
        // model only asks.
        const open = (stepId: string, listKey: string) => this._isBranchOpen(stepId, listKey);
        suffixes.append(iconButton('go-up-symbolic',
            _('Move up — into an open body above, or past a folded one'), () => {
                if (moveStepNested(macro.body, step.id, -1, open)) {
                    this._saveAndRebuild();
                }
            }));
        suffixes.append(iconButton('go-down-symbolic',
            _('Move down — into an open body below, or past a folded one'), () => {
                if (moveStepNested(macro.body, step.id, 1, open)) {
                    this._saveAndRebuild();
                }
            }));
        suffixes.append(iconButton('user-trash-symbolic', _('Delete'), () => {
            removeStep(macro.body, step.id);
            this._saveAndRebuild();
        }));

        this._selectable(row, `after:${step.id}`, macro.id);

        if (row instanceof Adw.ExpanderRow) {
            for (const child of fields) {
                row.add_row(child);
            }
        }

        // Nested bodies. Each is its own block: coloured rail, own icon, and the
        // steps inside it indented one step further under that rail. A loop's
        // body is the step's own row (see `inline`); everything below is written
        // against whichever row is holding the steps.
        for (const list of children) {
            const kind: BranchKind =
                list.key === 'then' || list.key === 'else' ? list.key : 'body';
            const style = BRANCH_STYLE[kind];
            let nested: Adw.ExpanderRow;
            if (inline) {
                nested = row as Adw.ExpanderRow;
            } else {
                nested = this._expander(`${stepKey}:${list.key}`, {
                    title: _(style.title),
                    subtitle: `${this._countLabel(list.steps.length)} — ${_(style.hint)}`,
                }, list.steps.length > 0);
                nested.set_margin_start(indent + INDENT_PX);
                nested.add_prefix(new Gtk.Image({
                    icon_name: style.icon,
                    valign: Gtk.Align.CENTER,
                }));
                branchRows.push(nested);
                widgets.push(nested);
                // The step row is already selectable as "after this step"; a
                // block of its own gets a selection of its own.
                this._selectable(nested, `in:${step.id}:${list.key}`, macro.id);
            }
            nested.add_css_class('macroclickwerk-branch');
            nested.add_css_class(`macroclickwerk-branch-${kind}`);
            this._branchRows.set(`${step.id}:${list.key}`, nested);

            const addNested = this._addStepRow(list.steps, macro.id, step.id, list.key);
            addNested.set_margin_start(INDENT_PX);   // lines up with the steps below it
            addNested.add_prefix(new Gtk.Image({
                icon_name: 'list-add-symbolic',
                valign: Gtk.Align.CENTER,
            }));
            if (inline) {
                this._selectable(addNested, `in:${step.id}:${list.key}`, macro.id);
            }

            for (const child of list.steps) {
                for (const widget of this._buildStepWidgets(macro, child, INDENT_PX)) {
                    nested.add_row(widget);
                }
            }
            // Last, because that is where what it adds ends up.
            nested.add_row(addNested);
        }

        // An if's blocks sit beside its row, not inside it (that is how the
        // rails line up), so its chevron would fold only the condition editor
        // and leave both blocks standing. Have them follow it by hand.
        if (branchRows.length > 0 && row instanceof Adw.ExpanderRow) {
            const follow = () => {
                for (const branch of branchRows) {
                    branch.set_visible(row.get_expanded());
                }
            };
            row.connect('notify::expanded', follow);
            follow();
        }

        return widgets;
    }

    private _buildStepFields(macro: Macro, step: Step): Gtk.Widget[] {
        const condKey = `step:${step.id}:cond`;
        const rows: Gtk.Widget[] = [];
        const save = () => this._save();
        const rebuild = () => this._saveAndRebuild();

        switch (step.kind) {
            case 'click':
                // Button is not here either: which button and how long it is
                // held both sit on the step's own line, where the title already
                // says "Click left @ …" and the controls can finish the sentence.
                rows.push(this._positionRow({
                    step,
                    // The toggles are the whole of the old Position dropdown: one
                    // down means there are no coordinates to have.
                    toggleIcon: 'input-mouse-symbolic',
                    toggleTip: _('Click wherever the pointer already is'),
                    onModeName: 'current',
                    off: { title: _('Position'), values: () => [step.x ?? 0, step.y ?? 0] },
                    on: { title: _('Position'), subtitle: _('Wherever the pointer already is') },
                    apply: ([x, y]) => {
                        step.x = x;
                        step.y = y;
                    },
                }));
                // Hold is not here: it sits on the step's own line, beside the
                // click it belongs to.
                break;

            case 'move':
                rows.push(this._positionRow({
                    step,
                    toggleIcon: 'go-jump-symbolic',
                    toggleTip: _('Move by an offset instead of to a position'),
                    onModeName: 'rel',
                    off: { title: _('Position'), values: () => [step.x ?? 0, step.y ?? 0] },
                    // An offset is numbers too — they just are not a place, so
                    // there is nothing to point at or flash on the screen.
                    on: { title: _('Offset'), values: () => [step.dx ?? 0, step.dy ?? 0] },
                    store: {
                        title: _('Position'),
                        subtitle: _('Remember where the pointer is now; “previous” returns here'),
                    },
                    apply: ([a, b]) => {
                        if (step.mode === 'rel') {
                            step.dx = a;
                            step.dy = b;
                        } else {
                            step.x = a;
                            step.y = b;
                        }
                    },
                }));
                break;

            // No rows: both numbers sit on the step's own line, which already
            // reads "Scroll 3 vertically".
            case 'scroll':
                break;

            case 'key':
                // Action and hold are not here: they sit on the step's own
                // line, the way a click's button and hold do.
                rows.push(entryRow(_('Key (evdev name, e.g. KEY_E)'), step.code, text => {
                    const upper = text.trim().toUpperCase();
                    step.code = upper.startsWith('KEY_') ? upper : `KEY_${upper}`;
                    save();
                }));
                rows.push(entryRow(_('Modifiers (space separated)'), (step.mods ?? []).join(' '), text => {
                    step.mods = text.split(/[\s,+]+/).filter(Boolean).map(name => {
                        const upper = name.toUpperCase();
                        return upper.startsWith('KEY_') ? upper : `KEY_${upper}`;
                    });
                    save();
                }));
                break;

            case 'text':
                // Delay is not here: it sits on the step's own line.
                rows.push(entryRow(_('Text'), step.value, text => {
                    step.value = text;
                    save();
                }));
                break;

            // No rows: the wait and its variation are both on the step's own
            // line, which already reads "Wait 1s ±200ms".
            case 'wait':
                break;

            // No rows: a repeat's count sits on the row itself, which is what
            // keeps the card from opening onto a single setting.
            case 'loop':
                break;

            case 'if':
                rows.push(...this._buildConditionSection(_('Condition'), step.cond, next => {
                    step.cond = next;
                    this._saveAndRebuild();
                }, condKey));
                break;

            case 'start':
            case 'stop': {
                // Every macro but this one, and "this one" as the first choice —
                // a start pointing here is a restart, a stop pointing here ends
                // the run, and both are worth having without picking a name.
                const others = this._store.macros.filter(other => other.id !== macro.id);
                // A macro that has since been deleted is not a choice any more,
                // so the step falls back to meaning itself rather than naming a
                // macro that is not there.
                if (step.macro && !others.some(other => other.id === step.macro)) {
                    step.macro = '';
                }
                const options = ['', ...others.map(other => other.id)];
                // "From the top" used to live in this label; the At step row
                // says it now, and can say otherwise.
                const labels: Record<string, string> = {
                    '': _('This macro'),
                };
                for (const other of others) {
                    labels[other.id] = other.name;
                }
                rows.push(comboRow(_('Which macro'), options, labels, step.macro ?? '', value => {
                    step.macro = value;
                    // Whatever step was chosen belonged to the previous macro.
                    step.at = '';
                    // The title says which macro, so it has to be redrawn.
                    rebuild();
                }));

                if (step.kind === 'start') {
                    // The steps of whichever macro is being started, indented
                    // the way the editor nests them, so the list reads as the
                    // macro does.
                    const target = step.macro
                        ? others.find(other => other.id === step.macro)
                        : macro;
                    const stepIds = [''];
                    const stepLabels: Record<string, string> = { '': _('From the top') };
                    walk(target?.body ?? [], loc => {
                        // Not this step itself: starting at it would only run it
                        // again, and again.
                        if (loc.step.id === step.id) {
                            return;
                        }
                        stepIds.push(loc.step.id);
                        stepLabels[loc.step.id] = `${'    '.repeat(loc.depth)}${this._describe(loc.step)}`;
                    });
                    // A step that has since been deleted is not a choice any
                    // more; the top is the fallback the runner uses anyway.
                    if (step.at && !stepIds.includes(step.at)) {
                        step.at = '';
                    }
                    rows.push(comboRow(_('At step'), stepIds, stepLabels, step.at ?? '', value => {
                        step.at = value;
                        // The title names the step, so it has to be redrawn.
                        rebuild();
                    }));
                }
                break;
            }

            default:
                break;
        }

        return rows;
    }

    private _buildConditionSection(
        title: string,
        condition: Condition,
        replace: (next: Condition) => void,
        key: string,
    ): Gtk.Widget[] {
        const rows = this._buildConditionRows(condition, replace, key);
        const pick = chooser(
            CONDITION_TYPES, CONDITION_TYPE_LABELS, condition.type,
            _('What this condition checks'),
            type => replace(newCondition(type)),
        );

        // A group's rows are its children, and this line is the one thing that
        // holds them together — it says how many there are and stays put.
        const group = condition.type === 'and' || condition.type === 'or'
            ? condition.of : null;

        // Otherwise the type and the setting that qualifies it are one sentence
        // — ask the LLM, about this prompt — so the chooser joins that setting
        // rather than spending a line above it saying only its own name.
        // Conditions that lead with a fold (not) or show nothing at all
        // (always) keep the row: there is no line there to share.
        const headline = rows[0];
        if (!group && (headline instanceof Adw.ActionRow || headline instanceof Adw.EntryRow)) {
            headline.add_suffix(pick);
            return rows;
        }

        const row = new Adw.ActionRow({ title });
        if (group) {
            row.set_subtitle(
                `${group.length} ${group.length === 1 ? _('condition') : _('conditions')}`);
        }
        row.add_suffix(pick);
        return [row, ...rows];
    }

    private _buildConditionRows(
        condition: Condition,
        replace: (next: Condition) => void,
        key: string,
    ): Gtk.Widget[] {
        const rows: Gtk.Widget[] = [];
        const save = () => this._save();
        const rebuild = () => this._saveAndRebuild();

        switch (condition.type) {
            case 'always':
                break;

            case 'llm': {
                const promptRow = entryRow(_('Prompt'), condition.prompt, text => {
                    condition.prompt = text;
                    save();
                });
                promptRow.add_suffix(infoButton(
                    _('How to word this, and what is actually sent'), promptHelp(), 64));
                rows.push(promptRow);

                const areaRow = new Adw.ActionRow({
                    title: _('Screen area'),
                    subtitle: condition.region
                        ? `${condition.region.w}×${condition.region.h} at ${condition.region.x},${condition.region.y}`
                        : _('The whole screen'),
                });
                const pick = new Gtk.Button({
                    label: _('Pick'),
                    tooltip_text: _('Drag a rectangle over the screen to select the area'),
                    valign: Gtk.Align.CENTER,
                });
                pick.connect('clicked', () => this._pickRegionFor(condition));
                areaRow.add_suffix(pick);
                if (condition.region) {
                    const region = condition.region;
                    const show = new Gtk.Button({ label: _('Show'), valign: Gtk.Align.CENTER });
                    show.connect('clicked', () => this._showMarker(region.x, region.y, region.w, region.h));
                    areaRow.add_suffix(show);
                    const clear = new Gtk.Button({
                        label: _('Screen'),
                        tooltip_text: _('Check the whole screen instead'),
                        valign: Gtk.Align.CENTER,
                    });
                    clear.connect('clicked', () => {
                        condition.region = null;
                        rebuild();
                    });
                    areaRow.add_suffix(clear);
                }
                const flash = new Gtk.ToggleButton({
                    label: _('Flash'),
                    active: condition.flash === true,
                    tooltip_text: _('Flash a green outline over the checked area for a second whenever this check runs'),
                    valign: Gtk.Align.CENTER,
                });
                flash.connect('toggled', () => {
                    condition.flash = flash.get_active();
                    save();
                });
                areaRow.add_suffix(flash);
                rows.push(areaRow);

                break;
            }

            case 'color':
                rows.push(this._numbersRow(_('Area (x, y, width, height)'),
                    [condition.x, condition.y, condition.w, condition.h],
                    ([x, y, w, h]) => {
                        condition.x = x;
                        condition.y = y;
                        condition.w = Math.max(1, w);
                        condition.h = Math.max(1, h);
                        rebuild();
                    },
                    ([x, y, w, h]) => this._showMarker(x, y, Math.max(1, w), Math.max(1, h)),
                    // The size stays: what you are pointing at is which pixel to
                    // look at, not how big a patch of it to take.
                    (x, y, [, , w, h]) => [x, y, w, h]));
                {
                    // Tolerance sits on the colour it is a tolerance of: on its
                    // own line the number said nothing about what it measured.
                    const colourRow = entryRow(_('Colour (#rrggbb)'), condition.color, text => {
                        condition.color = text.trim();
                        save();
                    });
                    colourRow.add_suffix(spinSuffix(condition.tolerance, 0, 442, 1,
                        _('Tolerance: how far off this colour a pixel may be and still count'),
                        value => {
                            condition.tolerance = value;
                            save();
                        }));
                    rows.push(colourRow);
                }
                // Coverage is meaningless for a single pixel, which is the
                // default shape, so it only appears once there is an area.
                if (condition.w * condition.h > 1) {
                    rows.push(spinRow(_('Required coverage (%)'), Math.round(condition.coverage * 100), 1, 100, 1, value => {
                        condition.coverage = value / 100;
                        save();
                    }));
                }
                break;

            case 'not': {
                const nested = this._expander(`${key}:not`, {
                    title: _('Inverted condition'),
                    subtitle: describeCondition(condition.of),
                });
                for (const child of this._buildConditionSection(_('Type'), condition.of, next => {
                    condition.of = next;
                    rebuild();
                }, `${key}:not`)) {
                    nested.add_row(child);
                }
                rows.push(nested);
                break;
            }

            case 'and':
            case 'or': {
                // No fold of its own: the line above already says "all of" or
                // "any of" and carries the count, so a second line saying the
                // same thing only bought a level of indentation. The children
                // sit directly under it, each still folding on its own.
                const addRow = new Adw.ActionRow({ title: _('Add a sub-condition') });
                const model = new Gtk.StringList();
                const addable = CONDITION_TYPES.filter(type => type !== 'always');
                for (const type of addable) {
                    model.append(CONDITION_TYPE_LABELS[type]);
                }
                const dropdown = new Gtk.DropDown({ model, valign: Gtk.Align.CENTER });
                const addButton = new Gtk.Button({ label: _('Add'), valign: Gtk.Align.CENTER });
                addButton.connect('clicked', () => {
                    condition.of.push(newCondition(addable[dropdown.get_selected()]));
                    rebuild();
                });
                addRow.add_suffix(dropdown);
                addRow.add_suffix(addButton);
                rows.push(addRow);

                condition.of.forEach((child, index) => {
                    const childRow = this._expander(`${key}:${index}`, {
                        title: `${index + 1}. ${describeCondition(child)}`,
                    });
                    childRow.add_suffix(iconButton('user-trash-symbolic', _('Remove'), () => {
                        condition.of.splice(index, 1);
                        rebuild();
                    }));
                    for (const widget of this._buildConditionSection(_('Type'), child, next => {
                        condition.of[index] = next;
                        rebuild();
                    }, `${key}:${index}`)) {
                        childRow.add_row(widget);
                    }
                    rows.push(childRow);
                });

                break;
            }
        }

        void replace;
        return rows;
    }

    // --- import / export ---------------------------------------------------

    /**
     * Export and Import over both files, on one row. Each is a menu rather than
     * a button because there are two things to move — the steps, and the machine
     * they run on — and four buttons in a row is a row nobody reads.
     */
    private _transferRow(): Adw.ActionRow {
        const row = new Adw.ActionRow({
            title: _('Backup'),
            subtitle: _('Macros are the steps; settings are everything else'),
        });
        row.add_suffix(this._transferButton(_('Export'), [
            { label: _('Macros'), run: () => this._exportDocument() },
            { label: _('Settings'), run: () => this._exportSettings() },
        ]));
        row.add_suffix(this._transferButton(_('Import'), [
            { label: _('Macros'), run: () => this._importDocument() },
            { label: _('Settings'), run: () => this._importSettings() },
        ]));
        return row;
    }

    private _transferButton(
        label: string,
        choices: { label: string; run: () => void }[],
    ): Gtk.MenuButton {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        const popover = new Gtk.Popover({ child: box });
        for (const choice of choices) {
            const button = new Gtk.Button({ label: choice.label, css_classes: ['flat'] });
            button.connect('clicked', () => {
                // Down before the file dialog goes up, or the popover is left
                // hanging over it.
                popover.popdown();
                choice.run();
            });
            box.append(button);
        }
        return new Gtk.MenuButton({ label, popover, valign: Gtk.Align.CENTER });
    }

    /**
     * Ask for a file, and hand its path back. The window is the parent, so the
     * dialog is modal to the editor rather than to the whole session; cancelling
     * throws out of `*_finish`, which is not a failure and says nothing.
     */
    private _chooseFile(
        mode: 'open' | 'save',
        suggestedName: string,
        onChosen: (path: string) => void,
    ): void {
        const json = new Gtk.FileFilter({ name: _('JSON files') });
        json.add_suffix('json');
        const any = new Gtk.FileFilter({ name: _('All files') });
        any.add_pattern('*');
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
        filters.append(json);
        filters.append(any);

        const dialog = new Gtk.FileDialog({
            title: mode === 'save' ? _('Export to…') : _('Import from…'),
            modal: true,
            filters,
            default_filter: json,
            initial_folder: Gio.File.new_for_path(GLib.get_home_dir()),
        });
        if (mode === 'save') {
            dialog.set_initial_name(suggestedName);
        }

        const done = (result: Gio.AsyncResult) => {
            let file: Gio.File | null = null;
            try {
                file = mode === 'save' ? dialog.save_finish(result) : dialog.open_finish(result);
            } catch {
                return;   // dismissed
            }
            const path = file?.get_path();
            if (path) {
                onChosen(path);
            }
        };
        if (mode === 'save') {
            dialog.save(this._window ?? null, null, (_source, result) => done(result));
        } else {
            dialog.open(this._window ?? null, null, (_source, result) => done(result));
        }
    }

    private _exportDocument(): void {
        this._chooseFile('save', MACROS_FILE, path => {
            const json = stringifyDocument(this._store.document);
            try {
                GLib.file_set_contents(path, JSON.stringify(JSON.parse(json), null, 2));
                this._toast(`Exported ${this._store.macros.length} macros to ${path}`);
            } catch (error) {
                this._toast(`Export failed: ${(error as Error).message}`);
            }
        });
    }

    private _importDocument(): void {
        this._chooseFile('open', MACROS_FILE, path => {
            try {
                const [ok, contents] = GLib.file_get_contents(path);
                if (!ok) {
                    throw new Error('could not read the file');
                }
                const doc = parseDocument(new TextDecoder().decode(contents));
                this._store.replaceDocument(doc.macros.length > 0 ? doc : emptyDocument());
                this._rebuildMacros();
                this._toast(`Imported ${doc.macros.length} macros from ${path}`);
            } catch (error) {
                this._toast(`Import failed: ${(error as Error).message}`);
            }
        });
    }

    /**
     * Everything on the other three pages. Values are written in GVariant text
     * form — `'a string'`, `1280`, `['<Control>r']` — which is one notation that
     * covers every type in the schema and can be checked against it on the way
     * back in, so a hand-edited file cannot put a bad value into dconf.
     */
    private _exportSettings(): void {
        this._chooseFile('save', SETTINGS_FILE, path => {
            const values: Record<string, string> = {};
            for (const key of this._settings.settings_schema.list_keys()) {
                if (isTransferableKey(key)) {
                    values[key] = this._settings.get_value(key).print(false);
                }
            }
            try {
                const file = { type: 'macroclickwerk-settings', version: 1, settings: values };
                GLib.file_set_contents(path, `${JSON.stringify(file, null, 2)}\n`);
                this._toast(`Exported ${Object.keys(values).length} settings to ${path}`);
            } catch (error) {
                this._toast(`Settings export failed: ${(error as Error).message}`);
            }
        });
    }

    private _importSettings(): void {
        this._chooseFile('open', SETTINGS_FILE, path => this._applySettingsFile(path));
    }

    private _applySettingsFile(path: string): void {
        try {
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok) {
                throw new Error('could not read the file');
            }
            const parsed = JSON.parse(new TextDecoder().decode(contents)) as {
                settings?: Record<string, string>;
            };
            if (!parsed.settings || typeof parsed.settings !== 'object') {
                throw new Error('no settings in the file');
            }

            const schema = this._settings.settings_schema;
            const skipped: string[] = [];
            let applied = 0;
            for (const [key, text] of Object.entries(parsed.settings)) {
                if (!isTransferableKey(key) || !schema.has_key(key)) {
                    skipped.push(key);   // from another version, or not ours to write
                    continue;
                }
                const schemaKey = schema.get_key(key);
                let value: GLib.Variant;
                try {
                    value = GLib.Variant.parse(schemaKey.get_value_type(), text, null, null);
                } catch {
                    skipped.push(key);
                    continue;
                }
                // Out-of-range values are a hard error inside GSettings, so they
                // are dropped here rather than taking the whole import down.
                if (!schemaKey.range_check(value)) {
                    skipped.push(key);
                    continue;
                }
                this._settings.set_value(key, value);
                applied++;
            }

            this._addSettingsPages();
            const ignored = skipped.length > 0 ? `, ignored ${skipped.join(', ')}` : '';
            this._toast(`Imported ${applied} settings from ${path}${ignored}`);
        } catch (error) {
            this._toast(`Settings import failed: ${(error as Error).message}`);
        }
    }

    /** Build the non-macro pages, replacing them if they are already there. */
    private _addSettingsPages(): void {
        const window = this._window;
        if (!window) {
            return;
        }
        for (const page of this._settingsPages) {
            window.remove(page);
        }
        this._settingsPages = [this._buildLlmPage(), this._buildInputPage(), this._buildShortcutsPage()];
        for (const page of this._settingsPages) {
            window.add(page);
        }
    }

    /** Adwaita's own toast where the window has one, the journal either way. */
    private _toast(message: string): void {
        log(`macroclickwerk: ${message}`);
        const window = this._window as unknown as { add_toast?: (toast: object) => void } | undefined;
        if (typeof window?.add_toast === 'function') {
            window.add_toast(new Adw.Toast({ title: message, timeout: 5 }));
        }
    }

    /**
     * Preferences runs in its own process and cannot see or draw on the screen,
     * so anything screen-related is a request to the shell: write a serialled
     * payload to one settings key, wait for the matching answer on another.
     * `minimize` gets the window out of the way for requests you have to look
     * at the screen to satisfy.
     */
    private _askShell(
        name: string,
        payload: object,
        options: {
            minimize?: boolean;
            /** With `minimize`, whether this answer brings the window back; default yes. */
            presentOn?: (answer: Record<string, any>) => boolean;
            onResult?: (answer: Record<string, any>) => void;
        } = {},
    ): void {
        const settings = this._settings;
        const serial = ++this._requestSerial;

        if (options.onResult) {
            const resultKey = `${name}-result`;
            let handlerId = 0;
            handlerId = settings.connect(`changed::${resultKey}`, () => {
                let answer: Record<string, any> | null = null;
                try {
                    answer = JSON.parse(settings.get_string(resultKey));
                } catch {
                    answer = null;
                }
                if (!answer || typeof answer.serial !== 'number' || answer.serial < serial) {
                    return; // unreadable, or an exchange older than ours
                }
                // Ours, or a newer one — done either way. Without the newer
                // case, an exchange the shell never answered would leave this
                // handler parsing every future result on the key forever.
                settings.disconnect(handlerId);
                if (answer.serial > serial) {
                    return; // a newer exchange overtook this one; its handler answers
                }
                if (options.minimize && (options.presentOn?.(answer) ?? true)) {
                    this._window?.present();
                }
                options.onResult!(answer);
            });
        }

        if (options.minimize) {
            this._window?.minimize();
        }
        settings.set_string(`${name}-request`, JSON.stringify({ serial, ...payload }));
    }

    /**
     * Start a whole recording landing at `target` — the row it was asked from,
     * made the selection first so the shell agrees on the spot. The window
     * stays away while the answer is "recording": what is being recorded is
     * the real screen. It comes back on failure, and when this same control
     * stopped a recording that was already going.
     */
    private _recordInto(macroId: string, target: string): void {
        this._selectTarget(macroId, target);
        this._askShell('record', {}, {
            minimize: true,
            presentOn: answer => !(answer.ok && answer.recording),
            onResult: answer => {
                if (!answer.ok) {
                    this._toast(`recording failed: ${answer.message ?? 'unknown reason'}`);
                }
            },
        });
    }

    /** Watch for one click or move and append it as a step. */
    private _captureStepInto(macroId: string, parentStepId: string | null, listKey: string | null): void {
        this._askShell('capture-step', { macroId, parentStepId, listKey }, {
            minimize: true,
            onResult: answer => {
                if (!answer.ok) {
                    this._toast(`capture failed: ${answer.message ?? 'unknown reason'}`);
                }
                // A successful capture lands in `macros`, which rebuilds us anyway.
            },
        });
    }

    /**
     * Do one step on the real screen, right now. The window gets out of the way
     * first for anything aimed at a position, or the click would land on this
     * window instead of on whatever you are pointing it at; a wait has nothing
     * to look at, so it does not bother.
     */
    private _runStepNow(macroId: string, step: Step): void {
        this._save();   // the shell runs what is in the document, not what is on screen
        this._askShell('run-step', { macroId, stepId: step.id }, {
            minimize: step.kind !== 'wait',
            onResult: answer => {
                if (!answer.ok) {
                    this._toast(`${this._describe(step)}: ${answer.message ?? _('it did not run')}`);
                    return;
                }
                // Stepping through a macro: the insertion point moves past what
                // just ran, so anything recorded next goes on from there rather
                // than back where the selection happened to be.
                this._settings.set_string('record-into', `after:${step.id}`);
            },
        });
    }

    /**
     * Start or stop one macro from the button beside its name. The window gets
     * out of the way first, the same as for a single step: whatever the macro
     * clicks on, it is not meant to be this window. It comes back only if the
     * shell says no, because a message behind a minimised window is no message.
     */
    private _runMacroNow(macroId: string, action: 'run' | 'pause' | 'stop'): void {
        this._save();   // the shell runs what is in the document, not what is on screen
        if (action === 'run') {
            this._window?.minimize();
        }
        this._askShell('run-macro', { macroId, action }, {
            onResult: answer => {
                if (!answer.ok) {
                    this._window?.present();
                    this._toast(answer.message ?? _('it did not run'));
                }
            },
        });
    }

    /** Drag a rectangle on the real screen to set an LLM condition's area. */
    /**
     * Get out of the way, wait for a click on the real screen, and hand back
     * where it landed. The window comes back either way; a pick that caught
     * nothing says so rather than leaving the field looking picked.
     */
    private _pickPointInto(onPoint: (point: { x: number; y: number }) => void): void {
        this._askShell('pick-point', {}, {
            minimize: true,
            onResult: answer => {
                if (answer.ok && typeof answer.x === 'number' && typeof answer.y === 'number') {
                    onPoint({ x: answer.x, y: answer.y });
                } else {
                    this._toast(`${_('nothing was picked')}: ${answer.message ?? _('it timed out')}`);
                }
            },
        });
    }

    private _pickRegionFor(condition: LlmCondition): void {
        this._askShell('pick-region', {}, {
            minimize: true,
            onResult: answer => {
                if (answer.region) {
                    condition.region = answer.region as Region;
                    this._saveAndRebuild();
                }
            },
        });
    }

    /** Flash an X, or a rectangle, at these coordinates. */
    private _showMarker(x: number, y: number, w?: number, h?: number): void {
        this._askShell('show-marker', { x, y, w, h });
    }

    // --- other pages -------------------------------------------------------

    private _buildLlmPage(): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Model'),
            iconName: 'view-reveal-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Local vision model'),
            description: _('Any OpenAI-compatible endpoint: llama.cpp-server, LM Studio, vLLM, or Ollama on /v1.'),
        });

        const endpoint = new Adw.EntryRow({ title: _('Endpoint') });
        endpoint.set_text(this._settings.get_string('llm-endpoint'));
        const commitEndpoint = debounce(() => {
            this._settings.set_string('llm-endpoint', endpoint.get_text() ?? '');
        });
        endpoint.connect('changed', commitEndpoint);
        group.add(endpoint);

        const model = entryRow(_('Model'), this._settings.get_string('llm-model'), text => {
            this._settings.set_string('llm-model', text);
        });
        group.add(model);
        const apiKey = passwordRow(_('API key (usually empty locally)'), this._settings.get_string('llm-api-key'), text => {
            this._settings.set_string('llm-api-key', text);
        });
        group.add(apiKey);
        group.add(spinRow(_('Timeout (ms)'), this._settings.get_int('llm-timeout-ms'), 1000, 300000, 1000, value => {
            this._settings.set_int('llm-timeout-ms', Math.round(value));
        }));

        const testRow = new Adw.ActionRow({
            title: _('Test the connection'),
            subtitle: _('Sends one small picture'),
        });
        const testButton = new Gtk.Button({ label: _('Test'), valign: Gtk.Align.CENTER });
        testRow.add_suffix(testButton);
        testButton.connect('clicked', () => {
            for (const style of ['error', 'warning', 'success']) {
                testRow.remove_css_class(style);
            }
            testButton.sensitive = false;
            testRow.subtitle = _('Asking the model…');

            // Read straight off the rows, not out of settings: their writes are
            // debounced, and testing what is on screen is what you meant.
            void testConnection({
                endpoint: endpoint.get_text() ?? '',
                model: model.get_text() ?? '',
                apiKey: apiKey.get_text() ?? '',
                timeoutMs: this._settings.get_int('llm-timeout-ms'),
            }).then(result => {
                testButton.sensitive = true;
                if (!result.ok) {
                    testRow.add_css_class('error');
                    testRow.subtitle = result.message;
                } else if (result.sawImage) {
                    testRow.add_css_class('success');
                    testRow.subtitle = `Answered in ${result.latencyMs} ms — “${result.message}”`;
                } else {
                    // Reachable and talking, but blind: almost always a model
                    // name that is not the vision one.
                    testRow.add_css_class('warning');
                    testRow.subtitle = `Answered in ${result.latencyMs} ms, but called a plain red ` +
                        `picture something else — check that “${model.get_text()}” can see images`;
                }
            });
        });
        group.add(testRow);
        page.add(group);

        const imageGroup = new Adw.PreferencesGroup({
            title: _('Screenshots'),
            description: _('Sent as PNG, so text stays sharp. A tight screen area helps more than scaling.'),
        });
        const scale = scaleWidthFor(this._settings.get_int('llm-max-width'));
        if (Number(scale) !== this._settings.get_int('llm-max-width')) {
            this._settings.set_int('llm-max-width', Number(scale));   // so the row is not lying
        }
        imageGroup.add(comboRow(_('Scale down to'), SCALE_WIDTHS, scaleLabels(), scale, value => {
            this._settings.set_int('llm-max-width', Number(value));
        }));
        page.add(imageGroup);

        return page;
    }

    private _buildInputPage(): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Input'),
            iconName: 'input-keyboard-symbolic',
        });

        const daemon = new Adw.PreferencesGroup({
            title: _('Daemon'),
            description: _('Injects and observes events. Start it with: sudo systemctl start macroclickwerk'),
        });
        daemon.add(entryRow(_('Control socket'), this._settings.get_string('control-socket'), text => {
            this._settings.set_string('control-socket', text);
        }));
        daemon.add(entryRow(_('Event socket'), this._settings.get_string('event-socket'), text => {
            this._settings.set_string('event-socket', text);
        }));
        page.add(daemon);

        const recording = new Adw.PreferencesGroup({ title: _('Recording') });
        recording.add(spinRow(
            _('Pauses longer than this become waits (ms, 0 = never)'),
            this._settings.get_int('record-gap-ms'), 0, 60000, 10,
            value => this._settings.set_int('record-gap-ms', Math.round(value)),
        ));
        page.add(recording);

        return page;
    }

    private _buildShortcutsPage(): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Shortcuts'),
            iconName: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('GTK accelerator syntax, for example &lt;Control&gt;&lt;Shift&gt;F5'),
        });

        const shortcuts: [string, string][] = [
            ['run-macro', _('Run or stop the selected macro')],
            ['record-toggle', _('Start or stop recording')],
            ['capture-step', _('Capture one click or move as a step')],
            ['panic-stop', _('Emergency stop')],
        ];

        for (const [key, title] of shortcuts) {
            const current = this._settings.get_strv(key)[0] ?? '';
            const row = new Adw.EntryRow({ title });
            row.set_text(current);
            const commit = debounce(() => {
                const text = (row.get_text() ?? '').trim();
                if (text === '') {
                    this._settings.set_strv(key, []);
                    row.remove_css_class('error');
                    return;
                }
                const [ok] = Gtk.accelerator_parse(text);
                if (ok) {
                    row.remove_css_class('error');
                    this._settings.set_strv(key, [text]);
                } else {
                    row.add_css_class('error');
                }
            });
            row.connect('changed', commit);
            group.add(row);
        }

        page.add(group);
        return page;
    }
}
