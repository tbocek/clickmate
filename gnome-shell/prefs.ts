// The full macro editor. Runs in its own process, so it can use GTK4/Adwaita
// widgets and cannot block the compositor.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    CONDITION_TYPE_LABELS,
    STEP_KIND_LABELS,
    type Condition,
    type ConditionType,
    type GateAction,
    type Macro,
    type Step,
    type StepKind,
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
    removeStep,
    stringifyDocument,
} from './src/model.js';
import { MacroStore, isLoopbackEndpoint } from './src/store.js';

const STEP_KINDS: StepKind[] = [
    'click', 'move', 'scroll', 'key', 'text', 'raw', 'wait',
    'repeat', 'while', 'if', 'gate', 'break', 'continue', 'stop',
];

const CONDITION_TYPES: ConditionType[] = ['always', 'llm', 'pixel', 'regionColor', 'and', 'or', 'not'];

const GATE_ACTIONS: GateAction[] = ['skip-rest', 'retry', 'break', 'continue', 'abort'];

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
    row.connect('notify::selected', () => {
        const value = options[row.get_selected()];
        if (value && value !== selected) {
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
    private _macrosPage!: Adw.PreferencesPage;
    private _macroGroups: Adw.PreferencesGroup[] = [];

    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
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
            unsubscribe();
            this._store.destroy();
            return false;
        });
    }

    private _save(): void {
        this._store.save();
    }

    private _saveAndRebuild(): void {
        this._store.save();
        this._rebuildMacros();
    }

    // --- macros page -------------------------------------------------------

    private _rebuildMacros(): void {
        for (const group of this._macroGroups) {
            this._macrosPage.remove(group);
        }
        this._macroGroups = [];

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

        group.add(switchRow(
            _('Take exclusive control of input'),
            _('Drop physical mouse and keyboard input while this macro runs'),
            macro.suppressInput ?? false,
            value => {
                macro.suppressInput = value;
                this._save();
            },
        ));

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
        addRow.add_suffix(kindDropdown);
        addRow.add_suffix(addStepButton);
        group.add(addRow);

        for (const step of macro.body) {
            group.add(this._buildStepRow(macro, step));
        }

        return group;
    }

    private _buildStepRow(macro: Macro, step: Step): Adw.ExpanderRow {
        const row = new Adw.ExpanderRow({
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

        // Inline guard.
        const guardType = step.when ? step.when.type : 'always';
        row.add_row(comboRow(_('Run this step only when'), CONDITION_TYPES, CONDITION_TYPE_LABELS, guardType, type => {
            step.when = type === 'always' ? null : newCondition(type);
            this._saveAndRebuild();
        }));
        if (step.when) {
            for (const child of this._buildConditionRows(step.when, next => {
                step.when = next;
                this._saveAndRebuild();
            })) {
                row.add_row(child);
            }
        }

        // Nested bodies.
        for (const list of childLists(step)) {
            const nested = new Adw.ExpanderRow({
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
            addNested.add_suffix(nestedDropdown);
            addNested.add_suffix(nestedAdd);
            nested.add_row(addNested);

            for (const child of list.steps) {
                nested.add_row(this._buildStepRow(macro, child));
            }
            row.add_row(nested);
        }

        return row;
    }

    private _buildStepFields(macro: Macro, step: Step): Gtk.Widget[] {
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
                    rows.push(spinRow(_('X'), step.x ?? 0, 0, 32768, 1, value => {
                        step.x = Math.round(value);
                        save();
                    }));
                    rows.push(spinRow(_('Y'), step.y ?? 0, 0, 32768, 1, value => {
                        step.y = Math.round(value);
                        save();
                    }));
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
                    rows.push(spinRow(_('X'), step.x ?? 0, 0, 32768, 1, value => {
                        step.x = Math.round(value);
                        save();
                    }));
                    rows.push(spinRow(_('Y'), step.y ?? 0, 0, 32768, 1, value => {
                        step.y = Math.round(value);
                        save();
                    }));
                } else {
                    rows.push(spinRow(_('Δ X'), step.dx ?? 0, -32768, 32768, 1, value => {
                        step.dx = Math.round(value);
                        save();
                    }));
                    rows.push(spinRow(_('Δ Y'), step.dy ?? 0, -32768, 32768, 1, value => {
                        step.dy = Math.round(value);
                        save();
                    }));
                }
                break;

            case 'scroll':
                rows.push(spinRow(_('Horizontal clicks'), step.dx, -100, 100, 1, value => {
                    step.dx = Math.round(value);
                    save();
                }));
                rows.push(spinRow(_('Vertical clicks'), step.dy, -100, 100, 1, value => {
                    step.dy = Math.round(value);
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

            case 'raw': {
                rows.push(entryRow(_('Label'), step.label ?? '', text => {
                    step.label = text;
                    save();
                }));
                const info = new Adw.ActionRow({
                    title: _('Recorded events'),
                    subtitle: `${step.events.length}`,
                });
                const clear = new Gtk.Button({ label: _('Clear'), valign: Gtk.Align.CENTER });
                clear.connect('clicked', () => {
                    step.events = [];
                    rebuild();
                });
                info.add_suffix(clear);
                rows.push(info);
                break;
            }

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

            case 'repeat': {
                const forever = step.count === 'forever';
                rows.push(switchRow(_('Repeat forever'), _('Otherwise repeat a fixed number of times'), forever, value => {
                    step.count = value ? 'forever' : 10;
                    rebuild();
                }));
                if (!forever) {
                    rows.push(spinRow(_('Iterations'), step.count as number, 1, 1000000, 1, value => {
                        step.count = Math.round(value);
                        save();
                    }));
                }
                break;
            }

            case 'while':
                rows.push(...this._buildConditionSection(_('Keep looping while'), step.cond, next => {
                    step.cond = next;
                    this._saveAndRebuild();
                }));
                rows.push(spinRow(_('Maximum iterations (0 = unlimited)'), step.maxIterations ?? 0, 0, 1000000, 1, value => {
                    step.maxIterations = Math.round(value);
                    save();
                }));
                break;

            case 'if':
                rows.push(...this._buildConditionSection(_('Condition'), step.cond, next => {
                    step.cond = next;
                    this._saveAndRebuild();
                }));
                break;

            case 'gate':
                rows.push(...this._buildConditionSection(_('Only continue when'), step.cond, next => {
                    step.cond = next;
                    this._saveAndRebuild();
                }));
                rows.push(comboRow(_('Otherwise'), GATE_ACTIONS, {
                    'skip-rest': _('Skip the rest of this loop iteration'),
                    'retry': _('Wait and check again'),
                    'break': _('Leave the loop'),
                    'continue': _('Jump to the next iteration'),
                    'abort': _('Stop the whole macro'),
                }, step.onFalse, value => {
                    step.onFalse = value;
                    rebuild();
                }));
                if (step.onFalse === 'retry') {
                    rows.push(spinRow(_('Re-check after (ms)'), step.retryMs ?? 1000, 50, 600000, 100, value => {
                        step.retryMs = Math.round(value);
                        save();
                    }));
                }
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
    ): Gtk.Widget[] {
        const rows: Gtk.Widget[] = [];
        rows.push(comboRow(title, CONDITION_TYPES, CONDITION_TYPE_LABELS, condition.type, type => {
            replace(newCondition(type));
        }));
        rows.push(...this._buildConditionRows(condition, replace));
        return rows;
    }

    private _buildConditionRows(condition: Condition, replace: (next: Condition) => void): Gtk.Widget[] {
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
                        : _('The whole screen — pick an area from the panel menu for faster, more reliable answers'),
                });
                if (condition.region) {
                    const clear = new Gtk.Button({ label: _('Use whole screen'), valign: Gtk.Align.CENTER });
                    clear.connect('clicked', () => {
                        condition.region = null;
                        rebuild();
                    });
                    areaRow.add_suffix(clear);
                }
                rows.push(areaRow);

                rows.push(entryRow(_('Model override (optional)'), condition.model ?? '', text => {
                    condition.model = text.trim();
                    save();
                }));
                rows.push(spinRow(_('Timeout (ms)'), condition.timeoutMs ?? 20000, 1000, 300000, 1000, value => {
                    condition.timeoutMs = Math.round(value);
                    save();
                }));
                rows.push(spinRow(_('Reuse the answer for (ms)'), condition.cacheMs ?? 0, 0, 600000, 500, value => {
                    condition.cacheMs = Math.round(value);
                    save();
                }));
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

            case 'pixel':
                rows.push(spinRow(_('X'), condition.x, 0, 32768, 1, value => {
                    condition.x = Math.round(value);
                    save();
                }));
                rows.push(spinRow(_('Y'), condition.y, 0, 32768, 1, value => {
                    condition.y = Math.round(value);
                    save();
                }));
                rows.push(entryRow(_('Colour (#rrggbb)'), condition.color, text => {
                    condition.color = text.trim();
                    save();
                }));
                rows.push(spinRow(_('Tolerance'), condition.tolerance, 0, 442, 1, value => {
                    condition.tolerance = Math.round(value);
                    save();
                }));
                break;

            case 'regionColor':
                rows.push(spinRow(_('X'), condition.x, 0, 32768, 1, value => {
                    condition.x = Math.round(value);
                    save();
                }));
                rows.push(spinRow(_('Y'), condition.y, 0, 32768, 1, value => {
                    condition.y = Math.round(value);
                    save();
                }));
                rows.push(spinRow(_('Width'), condition.w, 1, 32768, 1, value => {
                    condition.w = Math.round(value);
                    save();
                }));
                rows.push(spinRow(_('Height'), condition.h, 1, 32768, 1, value => {
                    condition.h = Math.round(value);
                    save();
                }));
                rows.push(entryRow(_('Colour (#rrggbb)'), condition.color, text => {
                    condition.color = text.trim();
                    save();
                }));
                rows.push(spinRow(_('Tolerance'), condition.tolerance, 0, 442, 1, value => {
                    condition.tolerance = Math.round(value);
                    save();
                }));
                rows.push(spinRow(_('Required coverage (%)'), Math.round(condition.coverage * 100), 1, 100, 1, value => {
                    condition.coverage = value / 100;
                    save();
                }));
                break;

            case 'not': {
                const nested = new Adw.ExpanderRow({
                    title: _('Inverted condition'),
                    subtitle: describeCondition(condition.of),
                });
                for (const child of this._buildConditionSection(_('Type'), condition.of, next => {
                    condition.of = next;
                    rebuild();
                })) {
                    nested.add_row(child);
                }
                rows.push(nested);
                break;
            }

            case 'and':
            case 'or': {
                const container = new Adw.ExpanderRow({
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
                    const childRow = new Adw.ExpanderRow({
                        title: `${index + 1}. ${describeCondition(child)}`,
                    });
                    childRow.add_suffix(iconButton('user-trash-symbolic', _('Remove'), () => {
                        condition.of.splice(index, 1);
                        rebuild();
                    }));
                    for (const widget of this._buildConditionSection(_('Type'), child, next => {
                        condition.of[index] = next;
                        rebuild();
                    })) {
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
        daemon.add(switchRow(
            _('Flatten pointer acceleration while playing'),
            _('Makes clicks at fixed coordinates land exactly; the previous setting is restored afterwards'),
            this._settings.get_boolean('neutralize-pointer-accel'),
            value => this._settings.set_boolean('neutralize-pointer-accel', value),
        ));
        page.add(daemon);

        const recording = new Adw.PreferencesGroup({ title: _('Recording') });
        recording.add(switchRow(
            _('Record pauses'),
            _('Turn idle gaps into wait steps so playback keeps your rhythm'),
            this._settings.get_boolean('record-delays'),
            value => this._settings.set_boolean('record-delays', value),
        ));
        recording.add(spinRow(_('Pause threshold (ms)'), this._settings.get_int('record-gap-ms'), 20, 60000, 10, value => {
            this._settings.set_int('record-gap-ms', Math.round(value));
        }));
        recording.add(switchRow(
            _('Record pointer movement'),
            _('Off by default: clicks already carry their own coordinates'),
            this._settings.get_boolean('record-motion'),
            value => this._settings.set_boolean('record-motion', value),
        ));
        recording.add(switchRow(
            _('Record verbatim'),
            _('Store the untouched event train instead of readable steps — needed for games that grab the pointer'),
            this._settings.get_boolean('record-raw'),
            value => this._settings.set_boolean('record-raw', value),
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
            ['pick-point', _('Capture the pointer position')],
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
