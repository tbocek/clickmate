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
    type Condition,
    type ConditionType,
    type LlmCondition,
    type Macro,
    type Region,
    type Step,
    type StepKind,
    childLists,
    cloneStep,
    describeCondition,
    describeStep,
    emptyDocument,
    insertStep,
    moveStepNested,
    newCondition,
    newMacro,
    newStep,
    parseDocument,
    parseNumbers,
    removeStep,
    stringifyDocument,
} from './src/model.js';
import { MacroStore } from './src/store.js';
import { buildInstruction, testConnection } from './src/llm.js';

const CONDITION_TYPES: ConditionType[] = ['always', 'llm', 'color', 'and', 'or', 'not'];

const MACROS_FILE = 'clickmate-macros.json';
const SETTINGS_FILE = 'clickmate-settings.json';

/**
 * Keys the settings file leaves alone. The macros live in their own export, and
 * the rest is live state — what is running, and the request/answer keys
 * preferences uses to talk to the shell. Importing any of those would either
 * clobber the other export or replay a stale request.
 */
const NOT_SETTINGS = [
    'macros', 'active-macro-id', 'running-steps', 'resume-step', 'record-into', 'recording',
];

function isTransferableKey(key: string): boolean {
    return !NOT_SETTINGS.includes(key) && !key.endsWith('-request') && !key.endsWith('-result');
}

function homeFile(name: string): string {
    return GLib.build_filenamev([GLib.get_home_dir(), name]);
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
    break: 'media-playback-stop-symbolic',
    continue: 'media-skip-forward-symbolic',
    stop: 'process-stop-symbolic',
};

const BRANCH_STYLE: Record<BranchKind, { icon: string; title: string; hint: string }> = {
    body: {
        icon: 'media-playlist-repeat-symbolic',
        title: 'Body',
        hint: 'runs on every iteration',
    },
    then: {
        icon: 'object-select-symbolic',
        title: 'Then',
        hint: 'runs when the condition holds',
    },
    else: {
        icon: 'window-close-symbolic',
        title: 'Else',
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
 */
const EDITOR_CSS = `
.clickmate-branch {
    border-left: 4px solid alpha(@accent_bg_color, 0.85);
    background-color: alpha(@accent_bg_color, 0.06);
}
.clickmate-branch-then {
    border-left-color: alpha(@success_color, 0.9);
    background-color: alpha(@success_color, 0.06);
}
.clickmate-branch-else {
    border-left-color: alpha(@warning_color, 0.9);
    background-color: alpha(@warning_color, 0.06);
}

.clickmate-running {
    background-color: alpha(@accent_bg_color, 0.28);
    border-left: 4px solid @accent_bg_color;
}
.clickmate-running-block { border-left: 4px solid @accent_bg_color; }
.clickmate-running-icon { color: @accent_bg_color; }
.clickmate-running-parent-icon { color: alpha(@accent_bg_color, 0.7); }

/* Where the next run starts. Deliberately not the running colour: this one is
   about a run that is not happening. */
.clickmate-resume {
    background-color: alpha(@warning_color, 0.22);
    border-left: 4px solid @warning_color;
}

/* Where recorded steps land. Faint while it is only a choice; unmistakable
   while the recording is actually running and the next click goes in here. A
   row that opens gets the rail only — a fill would run down everything inside
   it and read as though all of that were selected too. */
.clickmate-record-target {
    background-color: alpha(@error_color, 0.10);
    border-left: 4px solid alpha(@error_color, 0.55);
}
.clickmate-record-target-block { border-left: 4px solid alpha(@error_color, 0.55); }
.clickmate-recording-now {
    background-color: alpha(@error_color, 0.28);
    border-left: 4px solid @error_color;
}
.clickmate-recording-now-block { border-left: 4px solid @error_color; }
`;

/** How far a step inside a body sits in from the rail of that body. */
const INDENT_PX = 12;

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

function entryRow(title: string, value: string, onChange: (text: string) => void): Adw.EntryRow {
    const row = new Adw.EntryRow({ title });
    row.set_text(value);
    const commit = debounce(() => onChange(row.get_text() ?? ''));
    row.connect('changed', commit);
    return row;
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
    // still reports the last change.
    let current = selected;
    row.connect('notify::selected', () => {
        const value = options[row.get_selected()];
        if (value && value !== current) {
            current = value;
            onChange(value);
        }
    });
    return row;
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

/**
 * A ⓘ that opens a popover. For guidance too long for a subtitle and too small
 * for documentation nobody opens, kept next to the field it is about.
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
    return new Gtk.MenuButton({
        icon_name: 'help-about-symbolic',
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        popover: new Gtk.Popover({ child: label }),
    });
}

/**
 * What actually decides whether a check works. The instruction sent with the
 * picture asks for true or false about these words, so a statement lands and a
 * question invites prose — which is the failure people hit first.
 */
const PROMPT_HELP = [
    '<b>Write a statement, not a question.</b>',
    '',
    'The screenshot is sent with instructions to answer nothing but true or false about the words you put here.',
    '',
    '<b>Lands:</b>  the button on the left is green',
    '<b>Fragile:</b>  Is the button on the left green?',
    '',
    '• One visible fact at a time. “green and enabled” gives the model room to be half right.',
    '• Say where it is: “the button at the bottom right”.',
    '• Skip “not”. Set <b>Proceed when the answer is</b> to No instead.',
    '• Reading the reply is lenient: yes, YES, true, 1 and a JSON object are all understood, in any case. Only a reply with no yes or no anywhere in it counts as a failure, and then <b>If the request fails</b> decides what happens.',
    '',
    'A tight <b>Screen area</b> helps more than any wording.',
].join('\n');

/**
 * The wrapper, shown word for word. Built from the real thing rather than
 * described, so it cannot quietly stop being true; the placeholder stands in for
 * whatever is typed in the field.
 */
function sentPromptHelp(): string {
    const instruction = buildInstruction(_('…your words go here…'));
    return [
        _('<b>Your words are not sent on their own.</b>'),
        '',
        _('Every check sends the screenshot together with this, your text on the STATEMENT line — which is why a statement works and a question does not:'),
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

export default class ClickmatePreferences extends ExtensionPreferences {
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

    // The step the next run continues from — at most one, so the buttons behave
    // like radio buttons that happen to be spread across the whole page.
    private _resumeButtons = new Map<string, Gtk.ToggleButton>();
    private _resumeMarked = '';
    private _updatingResume = false;
    private _resumeChangedId = 0;

    // The selected row: click one and a recording goes there. Kept in settings
    // rather than in a widget because the shell is what acts on it, and because
    // a rebuild of the page must not lose the selection. '' is the end of the
    // macro, "after:<stepId>" a step, "in:<stepId>:<branch>" a body.
    private _targetRows = new Map<string, Gtk.Widget>();
    private _recordButtons: Gtk.Button[] = [];
    private _markedTarget = '';
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
            log(`clickmate: could not load editor styles: ${(error as Error).message}`);
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
        this._resumeChangedId = this._settings.connect(
            'changed::resume-step', () => this._applyResumeMark());
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
            if (this._resumeChangedId) {
                this._settings.disconnect(this._resumeChangedId);
                this._resumeChangedId = 0;
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

    private _rebuildMacros(): void {
        this._rebuilding = true;
        for (const group of this._macroGroups) {
            this._macrosPage.remove(group);
        }
        this._macroGroups = [];
        this._rebuilding = false;
        // Every row just went away, so nothing is highlighted any more either.
        this._stepRows.clear();
        this._resumeButtons.clear();
        this._targetRows.clear();
        this._recordButtons = [];
        this._branchRows.clear();
        this._highlighted = [];

        const actions = new Adw.PreferencesGroup({
            title: _('Macros'),
            description: _('Each macro is a list of steps. Loops and conditions nest inside each other.'),
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

        // The panel switch and the shortcuts act on one macro; this is where you
        // choose which, now that the popup itself is just a switch.
        if (this._store.macros.length > 0) {
            const ids = this._store.macros.map(macro => macro.id);
            const model = new Gtk.StringList();
            for (const macro of this._store.macros) {
                model.append(macro.name);
            }
            const activeId = this._store.activeMacro?.id ?? ids[0];
            const selector = new Adw.ComboRow({
                title: _('Selected macro'),
                subtitle: _('The one the panel switch and the shortcuts run'),
                model,
                selected: Math.max(0, ids.indexOf(activeId)),
            });
            selector.connect('notify::selected', () => {
                const id = ids[selector.get_selected()];
                if (id && id !== this._store.activeMacroId) {
                    // The chosen body belongs to the macro being left behind.
                    this._settings.set_string('record-into', '');
                    this._store.activeMacroId = id;
                }
            });
            actions.add(selector);
        }

        // Two files, because they move for different reasons: the steps are the
        // work, the settings are the machine they run on.
        actions.add(this._transferRow(
            _('Macros'),
            `${_('The recorded steps')} — ~/${MACROS_FILE}`,
            () => this._exportDocument(),
            () => this._importDocument(),
        ));
        actions.add(this._transferRow(
            _('Settings'),
            `${_('Endpoint, model, sockets and shortcuts')} — ~/${SETTINGS_FILE}`,
            () => this._exportSettings(),
            () => this._importSettings(),
        ));

        this._macrosPage.add(actions);
        this._macroGroups.push(actions);

        if (this._store.macros.length === 0) {
            const empty = new Adw.PreferencesGroup();
            empty.add(new Adw.ActionRow({
                title: _('No macros yet'),
                subtitle: _('Add one, then record into it from the panel menu.'),
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
        this._applyResumeMark();
        this._applyRecordTarget();
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

        const ids = this._runningStepIds();
        ids.forEach((id, index) => {
            const entry = this._stepRows.get(id);
            if (!entry) {
                return; // a step from another macro, or one just deleted
            }
            this._setRunState(entry, index === ids.length - 1 ? 'active' : 'ancestor');
            this._highlighted.push(id);
        });
    }

    /**
     * Paint the step the next run starts at, and put the matching button in.
     * Driven off the setting rather than off the button that was clicked: the
     * shell writes to the same key when a run is paused or fails, and this way
     * that shows up in the editor with no extra plumbing.
     */
    private _applyResumeMark(): void {
        const id = this._settings.get_string('resume-step');

        this._updatingResume = true;
        for (const [stepId, button] of this._resumeButtons) {
            button.set_active(stepId === id);
        }
        this._updatingResume = false;

        this._stepRows.get(this._resumeMarked)?.row.remove_css_class('clickmate-resume');
        this._resumeMarked = id;
        this._stepRows.get(id)?.row.add_css_class('clickmate-resume');
    }

    /**
     * Paint the list a recording goes into, and turn it red while one is
     * actually running — the point of showing it here at all is that the panel
     * icon is a long way from the body you chose.
     */
    private _applyRecordTarget(): void {
        const target = this._settings.get_string('record-into');

        const marked = this._targetRows.get(this._markedTarget);
        for (const cls of ['clickmate-record-target', 'clickmate-recording-now']) {
            marked?.remove_css_class(cls);
            marked?.remove_css_class(`${cls}-block`);
        }
        this._markedTarget = target;

        const recording = this._settings.get_string('recording') !== '';
        const row = this._targetRows.get(target);
        if (row) {
            const base = recording ? 'clickmate-recording-now' : 'clickmate-record-target';
            row.add_css_class(row instanceof Adw.ExpanderRow ? `${base}-block` : base);
        }

        // The buttons that ask for one captured click cannot work during a whole
        // recording, and go red rather than dead so the reason is visible.
        for (const button of this._recordButtons) {
            if (recording) {
                button.add_css_class('destructive-action');
            } else {
                button.remove_css_class('destructive-action');
            }
        }
    }

    /** Is this body open on screen? What move up and down mean depends on it. */
    private _isBranchOpen(stepId: string, listKey: string): boolean {
        return this._branchRows.get(`${stepId}:${listKey}`)?.get_expanded() ?? false;
    }

    /**
     * Clicking a row selects it, and a recording goes there: after a step, or
     * into a body. The click is watched on the way down rather than on the way
     * up, and the sequence is never claimed, so the row still does whatever it
     * did before — a step still folds open, a button still fires. Rows nest, and
     * capture order runs outermost first, so the innermost row you actually
     * clicked is the one that has the last word.
     */
    private _selectable(row: Gtk.Widget, target: string): void {
        const click = new Gtk.GestureClick();
        click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        click.connect('pressed', () => {
            if (this._settings.get_string('record-into') !== target) {
                this._settings.set_string('record-into', target);
            }
        });
        row.add_controller(click);
        this._targetRows.set(target, row);
    }

    private _runningStepIds(): string[] {
        try {
            const raw = this._settings.get_string('running-steps');
            if (!raw) {
                return [];
            }
            const parsed = JSON.parse(raw) as { steps?: unknown };
            return Array.isArray(parsed.steps) ? parsed.steps.filter(id => typeof id === 'string') : [];
        } catch {
            return [];
        }
    }

    private _setRunState(entry: StepRow, state: 'idle' | 'active' | 'ancestor'): void {
        for (const cls of ['clickmate-running', 'clickmate-running-block']) {
            entry.row.remove_css_class(cls);
        }
        for (const cls of ['clickmate-running-icon', 'clickmate-running-parent-icon']) {
            entry.icon.remove_css_class(cls);
        }
        entry.icon.icon_name = entry.kindIcon;
        for (const branch of entry.branchRows) {
            branch.remove_css_class('clickmate-running-block');
        }

        if (state === 'active') {
            entry.icon.icon_name = 'media-playback-start-symbolic';
            entry.icon.add_css_class('clickmate-running-icon');
            entry.row.add_css_class(entry.container ? 'clickmate-running-block' : 'clickmate-running');
        } else if (state === 'ancestor') {
            entry.icon.add_css_class('clickmate-running-parent-icon');
            entry.row.add_css_class('clickmate-running-block');
        }
        if (state !== 'idle') {
            // The body headers sit beside the step now, not inside it, so they
            // need the same rail or the chain of rails breaks at every loop.
            for (const branch of entry.branchRows) {
                branch.add_css_class('clickmate-running-block');
            }
        }
    }

    /**
     * A dropdown that is also the button: its first entry is the label, and
     * picking any of the others adds that step there and then. Two clicks for a
     * step instead of three, and no Add button left sitting next to a dropdown
     * whose value you already chose.
     */
    private _addStepDropdown(into: Step[]): Gtk.DropDown {
        const model = new Gtk.StringList();
        model.append(_('Add a step…'));
        for (const kind of STEP_KINDS) {
            model.append(STEP_KIND_LABELS[kind]);
        }
        const dropdown = new Gtk.DropDown({ model, valign: Gtk.Align.CENTER });
        dropdown.connect('notify::selected', () => {
            const index = dropdown.get_selected();
            if (index < 1 || index > STEP_KINDS.length || this._rebuilding) {
                return;   // the title itself, or the page being torn down
            }
            into.push(newStep(STEP_KINDS[index - 1]));
            // The rebuild replaces this widget anyway; reset in case it does not
            // get that far, so the title is what a returning eye sees.
            dropdown.set_selected(0);
            this._saveAndRebuild();
        });
        return dropdown;
    }

    private _buildMacroGroup(macro: Macro): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: macro.name });

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
        group.set_header_suffix(remove);

        group.add(entryRow(_('Name'), macro.name, text => {
            macro.name = text;
            this._save();
        }));

        const addRow = new Adw.ActionRow({
            title: _('The end of the macro'),
            subtitle: _('Add a step here, or send a recording here'),
        });
        const recordButton = new Gtk.Button({
            label: _('Record one'),
            tooltip_text: _('Click anywhere on screen, or move the pointer and hold still, to add that as a step'),
            valign: Gtk.Align.CENTER,
        });
        recordButton.connect('clicked', () => this._captureStepInto(macro.id, null, null));
        this._recordButtons.push(recordButton);

        // Only the selected macro is ever recorded into, so only its rows are
        // selectable — a highlight on a macro nothing records into would lie.
        if (macro.id === this._store.activeMacroId) {
            this._selectable(addRow, '');
        }
        addRow.add_suffix(this._addStepDropdown(macro.body));
        addRow.add_suffix(recordButton);
        group.add(addRow);

        for (const step of macro.body) {
            for (const widget of this._buildStepWidgets(macro, step)) {
                group.add(widget);
            }
        }

        return group;
    }

    /** "3 steps", "empty" — the same phrasing wherever a body is counted. */
    private _countLabel(count: number): string {
        if (count === 0) {
            return _('empty');
        }
        return `${count} ${count === 1 ? _('step') : _('steps')}`;
    }

    /**
     * What a step says when it is closed: your own note first, then what it
     * contains, so a collapsed loop still tells you it holds four steps.
     */
    private _stepSubtitle(step: Step): string {
        const parts: string[] = [];
        if (step.note) {
            parts.push(step.note);
        }
        if (step.kind === 'loop') {
            parts.push(`${this._countLabel(step.body.length)} ${_('in the body')}`);
        } else if (step.kind === 'if') {
            parts.push(`${this._countLabel(step.then.length)} ${_('then')}, ` +
                `${this._countLabel((step.else ?? []).length)} ${_('else')}`);
        }
        if (step.enabled === false) {
            parts.push(_('disabled'));
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
        // A card that opens onto nothing is a card that should not open. Steps
        // with settings of their own keep the expander; the rest — a repeat, a
        // break — are one line, and clicking them only selects them.
        const fields = this._buildStepFields(macro, step);
        const props = { title: describeStep(step), subtitle: this._stepSubtitle(step) };
        const row: Adw.ActionRow | Adw.ExpanderRow = fields.length > 0
            ? this._expander(stepKey, props)
            : new Adw.ActionRow(props);
        const widgets: Gtk.Widget[] = [row];
        const branchRows: Adw.ExpanderRow[] = [];

        row.set_margin_start(indent);
        if (step.enabled === false) {
            row.add_css_class('dim-label');
        }

        const kindIcon = STEP_ICONS[step.kind];
        const icon = new Gtk.Image({ icon_name: kindIcon, valign: Gtk.Align.CENTER });
        row.add_prefix(icon);
        this._stepRows.set(step.id, {
            row,
            icon,
            kindIcon,
            container: children.length > 0,
            branchRows,
        });

        const enabled = new Gtk.Switch({
            active: step.enabled !== false,
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Disable without deleting'),
        });
        enabled.connect('notify::active', () => {
            step.enabled = enabled.get_active();
            // Updated in place rather than rebuilt: a rebuild here would tear
            // down the switch you just flicked.
            if (step.enabled) {
                row.remove_css_class('dim-label');
            } else {
                row.add_css_class('dim-label');
            }
            row.set_subtitle(this._stepSubtitle(step));
            this._save();
        });
        row.add_prefix(enabled);

        // A repeat has exactly one setting, so it lives on the row rather than
        // behind a fold: the count, and a toggle for having no count at all.
        if (step.kind === 'loop') {
            const forever = new Gtk.ToggleButton({
                icon_name: 'media-playlist-repeat-symbolic',
                tooltip_text: _('Repeat without a limit'),
                active: step.count === 'forever',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
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
                row.set_title(describeStep(step));
                this._save();
            });
            count.connect('value-changed', () => {
                if (forever.get_active()) {
                    return;
                }
                step.count = count.get_value_as_int();
                row.set_title(describeStep(step));
                this._save();
            });
            row.add_suffix(count);
            row.add_suffix(forever);
        }

        // Marks where the next run picks up. At most one step in the document
        // carries it, so turning this one on turns any other one off — through
        // the setting, which is what the shell reads.
        const resume = new Gtk.ToggleButton({
            icon_name: 'go-jump-symbolic',
            tooltip_text: _('Start the next run here instead of at the top'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        resume.connect('toggled', () => {
            if (this._updatingResume) {
                return; // we are the ones setting it, from the setting itself
            }
            this._settings.set_string('resume-step', resume.get_active() ? step.id : '');
        });
        this._resumeButtons.set(step.id, resume);
        row.add_suffix(resume);

        // Folded loops and ifs are passed over; open ones are moved into. What
        // you see is what a press does, which is why the editor decides and the
        // model only asks.
        const open = (stepId: string, listKey: string) => this._isBranchOpen(stepId, listKey);
        row.add_suffix(iconButton('go-up-symbolic',
            _('Move up — into an open body above, or past a folded one'), () => {
                if (moveStepNested(macro.body, step.id, -1, open)) {
                    this._saveAndRebuild();
                }
            }));
        row.add_suffix(iconButton('go-down-symbolic',
            _('Move down — into an open body below, or past a folded one'), () => {
                if (moveStepNested(macro.body, step.id, 1, open)) {
                    this._saveAndRebuild();
                }
            }));
        row.add_suffix(iconButton('edit-copy-symbolic', _('Duplicate'), () => {
            insertStep(macro.body, cloneStep(step), step.id);
            this._saveAndRebuild();
        }));
        row.add_suffix(iconButton('user-trash-symbolic', _('Delete'), () => {
            removeStep(macro.body, step.id);
            this._saveAndRebuild();
        }));

        if (macro.id === this._store.activeMacroId) {
            this._selectable(row, `after:${step.id}`);
        }

        if (row instanceof Adw.ExpanderRow) {
            for (const child of fields) {
                row.add_row(child);
            }
        }

        // Nested bodies. Each is its own block: coloured rail, own icon, and the
        // steps inside it indented one step further under that rail.
        for (const list of children) {
            const kind: BranchKind =
                list.key === 'then' || list.key === 'else' ? list.key : 'body';
            const style = BRANCH_STYLE[kind];
            const nested = this._expander(`${stepKey}:${list.key}`, {
                title: _(style.title),
                subtitle: `${this._countLabel(list.steps.length)} — ${_(style.hint)}`,
            }, list.steps.length > 0);
            nested.set_margin_start(indent + INDENT_PX);
            nested.add_css_class('clickmate-branch');
            nested.add_css_class(`clickmate-branch-${kind}`);
            nested.add_prefix(new Gtk.Image({
                icon_name: style.icon,
                valign: Gtk.Align.CENTER,
            }));
            branchRows.push(nested);
            this._branchRows.set(`${step.id}:${list.key}`, nested);
            widgets.push(nested);

            if (macro.id === this._store.activeMacroId) {
                this._selectable(nested, `in:${step.id}:${list.key}`);
            }

            const addNested = new Adw.ActionRow({ title: _('Add a step here') });
            addNested.set_margin_start(INDENT_PX);   // lines up with the steps below it
            addNested.add_prefix(new Gtk.Image({
                icon_name: 'list-add-symbolic',
                valign: Gtk.Align.CENTER,
            }));
            const nestedRecord = new Gtk.Button({
                label: _('Record one'),
                tooltip_text: _('Click anywhere on screen, or move the pointer and hold still, to add that as a step'),
                valign: Gtk.Align.CENTER,
            });
            nestedRecord.connect('clicked', () => this._captureStepInto(macro.id, step.id, list.key));
            this._recordButtons.push(nestedRecord);

            addNested.add_suffix(this._addStepDropdown(list.steps));
            addNested.add_suffix(nestedRecord);
            nested.add_row(addNested);

            for (const child of list.steps) {
                for (const widget of this._buildStepWidgets(macro, child, INDENT_PX)) {
                    nested.add_row(widget);
                }
            }
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
                rows.push(comboRow(_('Button'), ['left', 'right', 'middle', 'side', 'extra'] as const,
                    { left: _('Left'), right: _('Right'), middle: _('Middle'), side: _('Side'), extra: _('Extra') },
                    step.button, value => {
                        step.button = value;
                        rebuild();
                    }));
                rows.push(comboRow(_('Position'), ['abs', 'current'] as const,
                    { abs: _('At the coordinates below'), current: _('Wherever the pointer already is') },
                    step.mode, value => {
                        step.mode = value;
                        rebuild();
                    }));
                if (step.mode === 'abs') {
                    rows.push(this._numbersRow(_('Position (x, y)'), [step.x ?? 0, step.y ?? 0],
                        ([x, y]) => {
                            step.x = x;
                            step.y = y;
                            save();
                        },
                        ([x, y]) => this._showMarker(x, y)));
                }
                rows.push(spinRow(_('Hold (ms)'), step.holdMs ?? 20, 0, 10000, 5, value => {
                    step.holdMs = Math.round(value);
                    save();
                }));
                break;

            case 'move':
                rows.push(comboRow(_('Mode'), ['abs', 'rel'] as const,
                    { abs: _('Move to a screen position'), rel: _('Move by an offset') },
                    step.mode, value => {
                        step.mode = value;
                        rebuild();
                    }));
                if (step.mode === 'abs') {
                    rows.push(this._numbersRow(_('Position (x, y)'), [step.x ?? 0, step.y ?? 0],
                        ([x, y]) => {
                            step.x = x;
                            step.y = y;
                            save();
                        },
                        ([x, y]) => this._showMarker(x, y)));
                } else {
                    rows.push(this._numbersRow(_('Offset (dx, dy)'), [step.dx ?? 0, step.dy ?? 0], ([dx, dy]) => {
                        step.dx = dx;
                        step.dy = dy;
                        save();
                    }));
                }
                break;

            case 'scroll':
                rows.push(this._numbersRow(_('Clicks (horizontal, vertical)'), [step.dx, step.dy], ([dx, dy]) => {
                    step.dx = dx;
                    step.dy = dy;
                    save();
                }));
                break;

            case 'key':
                rows.push(entryRow(_('Key (evdev name, e.g. KEY_E)'), step.code, text => {
                    const upper = text.trim().toUpperCase();
                    step.code = upper.startsWith('KEY_') ? upper : `KEY_${upper}`;
                    save();
                }));
                rows.push(comboRow(_('Action'), ['tap', 'down', 'up'] as const,
                    { tap: _('Press and release'), down: _('Press and keep held'), up: _('Release') },
                    step.action, value => {
                        step.action = value;
                        rebuild();
                    }));
                rows.push(entryRow(_('Modifiers (space separated)'), (step.mods ?? []).join(' '), text => {
                    step.mods = text.split(/[\s,+]+/).filter(Boolean).map(name => {
                        const upper = name.toUpperCase();
                        return upper.startsWith('KEY_') ? upper : `KEY_${upper}`;
                    });
                    save();
                }));
                rows.push(spinRow(_('Hold (ms)'), step.holdMs ?? 20, 0, 10000, 5, value => {
                    step.holdMs = Math.round(value);
                    save();
                }));
                break;

            case 'text':
                rows.push(entryRow(_('Text'), step.value, text => {
                    step.value = text;
                    save();
                }));
                rows.push(spinRow(_('Delay between keys (ms)'), step.delayMs ?? 12, 0, 1000, 1, value => {
                    step.delayMs = Math.round(value);
                    save();
                }));
                break;

            case 'wait':
                rows.push(spinRow(_('Wait (ms)'), step.ms, 0, 3600000, 100, value => {
                    step.ms = Math.round(value);
                    save();
                }));
                rows.push(spinRow(_('Random variation (± ms)'), step.jitterMs ?? 0, 0, 600000, 50, value => {
                    step.jitterMs = Math.round(value);
                    save();
                }));
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

            default:
                break;
        }

        void macro;
        return rows;
    }

    private _buildConditionSection(
        title: string,
        condition: Condition,
        replace: (next: Condition) => void,
        key: string,
    ): Gtk.Widget[] {
        const rows: Gtk.Widget[] = [];
        rows.push(comboRow(title, CONDITION_TYPES, CONDITION_TYPE_LABELS, condition.type, type => {
            replace(newCondition(type));
        }));
        rows.push(...this._buildConditionRows(condition, replace, key));
        return rows;
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
                promptRow.add_suffix(infoButton(_('What is actually sent'), sentPromptHelp(), 64));
                promptRow.add_suffix(infoButton(_('How to word this'), PROMPT_HELP));
                rows.push(promptRow);
                rows.push(comboRow(_('Proceed when the answer is'), ['yes', 'no'] as const,
                    { yes: _('Yes'), no: _('No') },
                    condition.expect === false ? 'no' : 'yes', value => {
                        condition.expect = value === 'yes';
                        rebuild();
                    }));

                const areaRow = new Adw.ActionRow({
                    title: _('Screen area'),
                    subtitle: condition.region
                        ? `${condition.region.w}×${condition.region.h} at ${condition.region.x},${condition.region.y}`
                        : _('The whole screen — narrowing it down makes answers faster and more reliable'),
                });
                const pick = new Gtk.Button({ label: _('Pick area…'), valign: Gtk.Align.CENTER });
                pick.connect('clicked', () => this._pickRegionFor(condition));
                areaRow.add_suffix(pick);
                if (condition.region) {
                    const region = condition.region;
                    const show = new Gtk.Button({ label: _('Show'), valign: Gtk.Align.CENTER });
                    show.connect('clicked', () => this._showMarker(region.x, region.y, region.w, region.h));
                    areaRow.add_suffix(show);
                }
                if (condition.region) {
                    const clear = new Gtk.Button({ label: _('Whole screen'), valign: Gtk.Align.CENTER });
                    clear.connect('clicked', () => {
                        condition.region = null;
                        rebuild();
                    });
                    areaRow.add_suffix(clear);
                }
                rows.push(areaRow);

                rows.push(comboRow(_('If the request fails'), ['false', 'true', 'abort'] as const, {
                    'false': _('Treat as no'),
                    'true': _('Treat as yes'),
                    'abort': _('Stop the macro'),
                }, condition.onError ?? 'false', value => {
                    condition.onError = value;
                    rebuild();
                }));
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
                    ([x, y, w, h]) => this._showMarker(x, y, Math.max(1, w), Math.max(1, h))));
                rows.push(entryRow(_('Colour (#rrggbb)'), condition.color, text => {
                    condition.color = text.trim();
                    save();
                }));
                rows.push(spinRow(_('Tolerance'), condition.tolerance, 0, 442, 1, value => {
                    condition.tolerance = Math.round(value);
                    save();
                }));
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
                const container = this._expander(`${key}:group`, {
                    title: condition.type === 'and' ? _('All of these must hold') : _('Any of these must hold'),
                    subtitle: `${condition.of.length} ${condition.of.length === 1 ? _('condition') : _('conditions')}`,
                });

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
                container.add_row(addRow);

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
                    container.add_row(childRow);
                });

                rows.push(container);
                break;
            }
        }

        void replace;
        return rows;
    }

    // --- import / export ---------------------------------------------------

    /** An Export / Import pair over one file. */
    private _transferRow(
        title: string, subtitle: string, onExport: () => void, onImport: () => void,
    ): Adw.ActionRow {
        const row = new Adw.ActionRow({ title, subtitle });
        const exportButton = new Gtk.Button({ label: _('Export'), valign: Gtk.Align.CENTER });
        exportButton.connect('clicked', onExport);
        const importButton = new Gtk.Button({ label: _('Import'), valign: Gtk.Align.CENTER });
        importButton.connect('clicked', onImport);
        row.add_suffix(exportButton);
        row.add_suffix(importButton);
        return row;
    }

    private _exportDocument(): void {
        const path = homeFile(MACROS_FILE);
        const json = stringifyDocument(this._store.document);
        try {
            GLib.file_set_contents(path, JSON.stringify(JSON.parse(json), null, 2));
            this._toast(`Exported ${this._store.macros.length} macros to ${path}`);
        } catch (error) {
            this._toast(`Export failed: ${(error as Error).message}`);
        }
    }

    private _importDocument(): void {
        const path = homeFile(MACROS_FILE);
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
    }

    /**
     * Everything on the other three pages. Values are written in GVariant text
     * form — `'a string'`, `1280`, `['<Control>r']` — which is one notation that
     * covers every type in the schema and can be checked against it on the way
     * back in, so a hand-edited file cannot put a bad value into dconf.
     */
    private _exportSettings(): void {
        const path = homeFile(SETTINGS_FILE);
        const values: Record<string, string> = {};
        for (const key of this._settings.settings_schema.list_keys()) {
            if (isTransferableKey(key)) {
                values[key] = this._settings.get_value(key).print(false);
            }
        }
        try {
            const file = { type: 'clickmate-settings', version: 1, settings: values };
            GLib.file_set_contents(path, `${JSON.stringify(file, null, 2)}\n`);
            this._toast(`Exported ${Object.keys(values).length} settings to ${path}`);
        } catch (error) {
            this._toast(`Settings export failed: ${(error as Error).message}`);
        }
    }

    private _importSettings(): void {
        const path = homeFile(SETTINGS_FILE);
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
        log(`clickmate: ${message}`);
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
        options: { minimize?: boolean; onResult?: (answer: Record<string, any>) => void } = {},
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
                if (!answer || answer.serial !== serial) {
                    return; // an older exchange, or someone else's
                }
                settings.disconnect(handlerId);
                if (options.minimize) {
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

    /** Drag a rectangle on the real screen to set an LLM condition's area. */
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
            description: _('Any OpenAI-compatible chat completions endpoint: llama.cpp-server, LM Studio, vLLM, or Ollama on /v1.'),
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
        const apiKey = entryRow(_('API key (usually empty locally)'), this._settings.get_string('llm-api-key'), text => {
            this._settings.set_string('llm-api-key', text);
        });
        group.add(apiKey);
        group.add(spinRow(_('Timeout (ms)'), this._settings.get_int('llm-timeout-ms'), 1000, 300000, 1000, value => {
            this._settings.set_int('llm-timeout-ms', Math.round(value));
        }));

        const testRow = new Adw.ActionRow({
            title: _('Test the connection'),
            subtitle: _('Sends one small picture and reports what comes back'),
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
            description: _('Sent as PNG, so text stays sharp. Smaller images mean faster answers, and restricting a condition to a screen area helps more than scaling does.'),
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
            description: _('The clickmate service injects and observes events. Start it with sudo systemctl start clickmate.'),
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
            _('Turn pauses longer than this into waits (ms, 0 = never)'),
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
            ['open-popup', _('Open the popup')],
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
