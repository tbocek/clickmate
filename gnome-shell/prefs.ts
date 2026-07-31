// The full macro editor. Runs in its own process, so it can use GTK4/Adwaita
// widgets and cannot block the compositor.

import Adw from 'gi://Adw';
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
    childLists,
    cloneStep,
    describeCondition,
    describeStep,
    emptyDocument,
    insertStep,
    moveStep,
    newCondition,
    newMacro,
    newStep,
    parseDocument,
    parseNumbers,
    removeStep,
    stringifyDocument,
} from './src/model.js';
import { MacroStore, isLoopbackEndpoint } from './src/store.js';

const CONDITION_TYPES: ConditionType[] = ['always', 'llm', 'color', 'and', 'or', 'not'];

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

function switchRow(title: string, subtitle: string, value: boolean, onChange: (value: boolean) => void): Adw.SwitchRow {
    const row = new Adw.SwitchRow({ title, subtitle, active: value });
    row.connect('notify::active', () => onChange(row.get_active()));
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

export default class ClickmatePreferences extends ExtensionPreferences {
    private _settings!: Gio.Settings;
    private _store!: MacroStore;
    private _window?: Adw.PreferencesWindow;
    private _macrosPage!: Adw.PreferencesPage;
    private _macroGroups: Adw.PreferencesGroup[] = [];

    // Structural edits rebuild the whole page, which would otherwise collapse
    // every expander. Expansion is keyed by step id so it survives a rebuild.
    private _expanded = new Set<string>();
    private _rebuilding = false;
    private _rebuildScheduled = false;
    // Seeded from the clock, not 0: a reopened preferences window would otherwise
    // restart at 1 and could write a request identical to a previous one, which
    // GSettings does not signal.
    private _requestSerial = GLib.get_real_time();
    private _closed = false;

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


    private _expander(key: string, props: Partial<Adw.ExpanderRow.ConstructorProps>): Adw.ExpanderRow {
        const row = new Adw.ExpanderRow({ ...props, expanded: this._expanded.has(key) });
        row.connect('notify::expanded', () => {
            if (this._rebuilding) {
                return; // teardown, not a user action
            }
            if (row.get_expanded()) {
                this._expanded.add(key);
            } else {
                this._expanded.delete(key);
            }
        });
        return row;
    }

    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        this._window = window;
        this._settings = this.getSettings();
        this._store = new MacroStore(this._settings);

        this._macrosPage = new Adw.PreferencesPage({
            title: _('Macros'),
            iconName: 'view-list-symbolic',
        });
        window.add(this._macrosPage);
        window.add(this._buildLlmPage());
        window.add(this._buildInputPage());
        window.add(this._buildShortcutsPage());

        this._rebuildMacros();

        // The shell writes to the same document — after recording, for instance.
        // Every step object we are holding is stale at that point, so rebuild.
        const unsubscribe = this._store.onChanged(external => {
            if (external) {
                this._rebuildMacros();
            }
        });

        window.connect('close-request', () => {
            this._closed = true;
            unsubscribe();
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
                    this._store.activeMacroId = id;
                }
            });
            actions.add(selector);
        }

        const importExport = new Adw.ActionRow({
            title: _('Import / export'),
            subtitle: _('Move macros between machines as JSON'),
        });
        const exportButton = new Gtk.Button({ label: _('Export'), valign: Gtk.Align.CENTER });
        exportButton.connect('clicked', () => this._exportDocument());
        const importButton = new Gtk.Button({ label: _('Import'), valign: Gtk.Align.CENTER });
        importButton.connect('clicked', () => this._importDocument());
        importExport.add_suffix(exportButton);
        importExport.add_suffix(importButton);
        actions.add(importExport);

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

        const addRow = new Adw.ActionRow({ title: _('Add a step') });
        const kindModel = new Gtk.StringList();
        for (const kind of STEP_KINDS) {
            kindModel.append(STEP_KIND_LABELS[kind]);
        }
        const kindDropdown = new Gtk.DropDown({ model: kindModel, valign: Gtk.Align.CENTER });
        const addStepButton = new Gtk.Button({ label: _('Add'), valign: Gtk.Align.CENTER });
        addStepButton.connect('clicked', () => {
            macro.body.push(newStep(STEP_KINDS[kindDropdown.get_selected()]));
            this._saveAndRebuild();
        });
        const recordButton = new Gtk.Button({
            label: _('Record'),
            tooltip_text: _('Click anywhere on screen, or move the pointer and hold still, to add that as a step'),
            valign: Gtk.Align.CENTER,
        });
        recordButton.connect('clicked', () => this._captureStepInto(macro.id, null, null));

        addRow.add_suffix(kindDropdown);
        addRow.add_suffix(addStepButton);
        addRow.add_suffix(recordButton);
        group.add(addRow);

        for (const step of macro.body) {
            group.add(this._buildStepRow(macro, step));
        }

        return group;
    }

    private _buildStepRow(macro: Macro, step: Step): Adw.ExpanderRow {
        const stepKey = `step:${step.id}`;
        const row = this._expander(stepKey, {
            title: describeStep(step),
            subtitle: step.note ?? '',
        });

        const enabled = new Gtk.Switch({
            active: step.enabled !== false,
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Disable without deleting'),
        });
        enabled.connect('notify::active', () => {
            step.enabled = enabled.get_active();
            this._save();
        });
        row.add_prefix(enabled);

        row.add_suffix(iconButton('go-up-symbolic', _('Move up'), () => {
            if (moveStep(macro.body, step.id, -1)) {
                this._saveAndRebuild();
            }
        }));
        row.add_suffix(iconButton('go-down-symbolic', _('Move down'), () => {
            if (moveStep(macro.body, step.id, 1)) {
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

        row.add_row(entryRow(_('Note'), step.note ?? '', text => {
            step.note = text;
            this._save();
        }));

        for (const child of this._buildStepFields(macro, step)) {
            row.add_row(child);
        }

        // Nested bodies.
        for (const list of childLists(step)) {
            const nested = this._expander(`${stepKey}:${list.key}`, {
                title: list.key === 'else' ? _('Else') : list.key === 'then' ? _('Then') : _('Body'),
                subtitle: `${list.steps.length} ${list.steps.length === 1 ? _('step') : _('steps')}`,
            });

            const addNested = new Adw.ActionRow({ title: _('Add a step here') });
            const nestedModel = new Gtk.StringList();
            for (const kind of STEP_KINDS) {
                nestedModel.append(STEP_KIND_LABELS[kind]);
            }
            const nestedDropdown = new Gtk.DropDown({ model: nestedModel, valign: Gtk.Align.CENTER });
            const nestedAdd = new Gtk.Button({ label: _('Add'), valign: Gtk.Align.CENTER });
            nestedAdd.connect('clicked', () => {
                list.steps.push(newStep(STEP_KINDS[nestedDropdown.get_selected()]));
                this._saveAndRebuild();
            });
            const nestedRecord = new Gtk.Button({
                label: _('Record'),
                tooltip_text: _('Click anywhere on screen, or move the pointer and hold still, to add that as a step'),
                valign: Gtk.Align.CENTER,
            });
            nestedRecord.connect('clicked', () => this._captureStepInto(macro.id, step.id, list.key));

            addNested.add_suffix(nestedDropdown);
            addNested.add_suffix(nestedAdd);
            addNested.add_suffix(nestedRecord);
            nested.add_row(addNested);

            for (const child of list.steps) {
                nested.add_row(this._buildStepRow(macro, child));
            }
            row.add_row(nested);
        }

        return row;
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

            case 'loop': {
                const forever = step.count === 'forever';
                rows.push(switchRow(
                    _('No iteration limit'),
                    _('Otherwise stop after a fixed number of times'),
                    forever,
                    value => {
                        step.count = value ? 'forever' : 10;
                        rebuild();
                    },
                ));
                if (!forever) {
                    rows.push(spinRow(_('Maximum iterations'), step.count as number, 1, 1000000, 1, value => {
                        step.count = Math.round(value);
                        save();
                    }));
                }
                break;
            }

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
                rows.push(entryRow(_('Prompt'), condition.prompt, text => {
                    condition.prompt = text;
                    save();
                }));
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

    private _exportDocument(): void {
        const path = GLib.build_filenamev([GLib.get_home_dir(), 'clickmate-macros.json']);
        const json = stringifyDocument(this._store.document);
        try {
            GLib.file_set_contents(path, JSON.stringify(JSON.parse(json), null, 2));
            this._toast(`Exported to ${path}`);
        } catch (error) {
            this._toast(`Export failed: ${(error as Error).message}`);
        }
    }

    private _importDocument(): void {
        const path = GLib.build_filenamev([GLib.get_home_dir(), 'clickmate-macros.json']);
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

    private _toast(message: string): void {
        log(`clickmate: ${message}`);
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
        const warning = new Adw.ActionRow({
            title: _('This endpoint is not on this machine'),
            subtitle: _('Every check uploads a picture of your screen to it.'),
            css_classes: ['error'],
        });
        const updateWarning = () => {
            warning.visible = !isLoopbackEndpoint(endpoint.get_text() ?? '');
        };
        const commitEndpoint = debounce(() => {
            this._settings.set_string('llm-endpoint', endpoint.get_text() ?? '');
            updateWarning();
        });
        endpoint.connect('changed', commitEndpoint);
        group.add(endpoint);
        group.add(warning);
        updateWarning();

        group.add(entryRow(_('Model'), this._settings.get_string('llm-model'), text => {
            this._settings.set_string('llm-model', text);
        }));
        group.add(entryRow(_('API key (usually empty locally)'), this._settings.get_string('llm-api-key'), text => {
            this._settings.set_string('llm-api-key', text);
        }));
        group.add(spinRow(_('Timeout (ms)'), this._settings.get_int('llm-timeout-ms'), 1000, 300000, 1000, value => {
            this._settings.set_int('llm-timeout-ms', Math.round(value));
        }));
        page.add(group);

        const imageGroup = new Adw.PreferencesGroup({
            title: _('Screenshots'),
            description: _('Smaller images mean faster answers. Restricting a condition to a screen area helps more than either setting.'),
        });
        imageGroup.add(spinRow(_('Maximum width (px)'), this._settings.get_int('llm-max-width'), 128, 4096, 64, value => {
            this._settings.set_int('llm-max-width', Math.round(value));
        }));
        imageGroup.add(spinRow(_('JPEG quality'), this._settings.get_int('llm-jpeg-quality'), 30, 100, 5, value => {
            this._settings.set_int('llm-jpeg-quality', Math.round(value));
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
        recording.add(switchRow(
            _('Record pointer movement'),
            _('Adds a move step wherever the pointer comes to rest. A move that ends in a click is left out, since the click already carries that position.'),
            this._settings.get_boolean('record-motion'),
            value => this._settings.set_boolean('record-motion', value),
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
