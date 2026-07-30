// The in-shell macro popup: run, record and edit without leaving the screen you
// are automating. Deep editing (nested conditions, every field) lives in the
// preferences window; everything you reach for repeatedly is here.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    CONDITION_TYPE_LABELS,
    STEP_KIND_LABELS,
    type ClickStep,
    type Condition,
    type GateAction,
    type GateStep,
    type IfStep,
    type KeyStep,
    type LlmCondition,
    type Macro,
    type MoveStep,
    type PixelCondition,
    type RepeatStep,
    type ScrollStep,
    type Step,
    type StepKind,
    type TextStep,
    type WaitStep,
    type WhileStep,
    childLists,
    cloneStep,
    describeStep,
    insertStep,
    isContainer,
    moveStep,
    newMacro,
    newStep,
    removeStep,
    walk,
} from '../src/model.js';
import type { MacroStore } from '../src/store.js';
import type { StepState } from '../src/runner.js';

export interface PopupDeps {
    store: MacroStore;
    isRunning: () => boolean;
    isRecording: () => boolean;
    onRun: () => void;
    onStop: () => void;
    onToggleRecord: () => void;
    onRunStep: (step: Step) => void;
    onTestCondition: (condition: Condition) => void;
    onPickRegion: (apply: (region: { x: number; y: number; w: number; h: number }) => void) => void;
    onOpenPreferences: () => void;
}

const QUICK_ADD_KINDS: StepKind[] = [
    'click', 'key', 'text', 'wait', 'move', 'scroll', 'raw',
    'repeat', 'while', 'if', 'gate', 'break', 'continue', 'stop',
];

function labelledEntry(
    label: string,
    value: string,
    onCommit: (text: string) => void,
    width = 90,
): St.BoxLayout {
    const box = new St.BoxLayout({ style_class: 'clickmate-field' });
    box.add_child(new St.Label({ text: label, style_class: 'clickmate-field-label' }));

    const entry = new St.Entry({
        text: value,
        style_class: 'clickmate-field-entry',
        can_focus: true,
    });
    entry.set_width(width);

    const commit = () => onCommit(entry.get_text() ?? '');
    entry.clutter_text.connect('activate', commit);
    entry.clutter_text.connect('key-focus-out', commit);

    box.add_child(entry);
    return box;
}

function smallButton(label: string, onClick: () => void, styleClass = 'clickmate-small-button'): St.Button {
    const button = new St.Button({ label, style_class: styleClass, can_focus: true });
    button.connect('clicked', () => onClick());
    return button;
}

function toNumber(text: string, fallback: number): number {
    const value = Number.parseFloat(text.trim());
    return Number.isFinite(value) ? value : fallback;
}

export class MacroPopup {
    private _deps: PopupDeps;
    private _root: St.BoxLayout;
    private _headerLabel: St.Label;
    private _runButton: St.Button;
    private _recordButton: St.Button;
    private _macroListBox: St.BoxLayout;
    private _addBox: St.BoxLayout;
    private _stepsBox: St.BoxLayout;
    private _editorBox: St.BoxLayout;
    private _statusLabel: St.Label;
    private _detailLabel: St.Label;

    private _selectedId: string | null = null;
    private _showMacroList = false;
    private _showAddPicker = false;
    private _stepStates = new Map<string, StepState>();
    private _rowsById = new Map<string, St.BoxLayout>();

    constructor(deps: PopupDeps) {
        this._deps = deps;

        this._root = new St.BoxLayout({ vertical: true, style_class: 'clickmate-popup' });

        // Header: which macro, and the macro switcher.
        const header = new St.BoxLayout({ style_class: 'clickmate-header' });
        this._headerLabel = new St.Label({ text: 'No macro', style_class: 'clickmate-title', x_expand: true });
        header.add_child(this._headerLabel);
        header.add_child(smallButton('Macros ▾', () => {
            this._showMacroList = !this._showMacroList;
            this.refresh();
        }));
        header.add_child(smallButton('Edit…', () => this._deps.onOpenPreferences()));
        this._root.add_child(header);

        this._macroListBox = new St.BoxLayout({ vertical: true, style_class: 'clickmate-macro-list' });
        this._root.add_child(this._macroListBox);

        // Controls.
        const controls = new St.BoxLayout({ style_class: 'clickmate-controls' });
        this._runButton = smallButton('▶ Run', () => {
            if (this._deps.isRunning()) {
                this._deps.onStop();
            } else {
                this._deps.onRun();
            }
        }, 'clickmate-primary-button');
        this._recordButton = smallButton('● Record', () => this._deps.onToggleRecord(), 'clickmate-small-button');
        controls.add_child(this._runButton);
        controls.add_child(this._recordButton);
        controls.add_child(smallButton('+ Step', () => {
            this._showAddPicker = !this._showAddPicker;
            this.refresh();
        }));
        this._root.add_child(controls);

        this._addBox = new St.BoxLayout({ vertical: true, style_class: 'clickmate-add-picker' });
        this._root.add_child(this._addBox);

        // Step list.
        const scroll = new St.ScrollView({ style_class: 'clickmate-steps-scroll', y_expand: true });
        this._stepsBox = new St.BoxLayout({ vertical: true, style_class: 'clickmate-steps' });
        scroll.set_child(this._stepsBox);
        this._root.add_child(scroll);

        // Inline editor for the selected step.
        this._editorBox = new St.BoxLayout({ vertical: true, style_class: 'clickmate-editor' });
        this._root.add_child(this._editorBox);

        // Status.
        this._statusLabel = new St.Label({ text: '', style_class: 'clickmate-status' });
        this._detailLabel = new St.Label({ text: '', style_class: 'clickmate-detail' });
        this._root.add_child(this._statusLabel);
        this._root.add_child(this._detailLabel);
    }

    /** Add the popup to a panel menu as one non-activating item. */
    addTo(menu: PopupMenu.PopupMenu): void {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        item.add_child(this._root);
        menu.addMenuItem(item);
    }

    destroy(): void {
        this._root.destroy();
    }

    // --- external state ----------------------------------------------------

    setStatus(text: string): void {
        this._statusLabel.text = text;
    }

    setDetail(text: string): void {
        this._detailLabel.text = text;
        this._detailLabel.visible = text !== '';
    }

    setStepState(stepId: string, state: StepState): void {
        this._stepStates.set(stepId, state);
        const row = this._rowsById.get(stepId);
        if (row) {
            this._applyRowState(row, state);
        }
    }

    clearStepStates(): void {
        this._stepStates.clear();
        for (const [, row] of this._rowsById) {
            this._applyRowState(row, null);
        }
    }

    private _applyRowState(row: St.BoxLayout, state: StepState | null): void {
        for (const name of ['is-running', 'is-ok', 'is-skipped', 'is-failed']) {
            row.remove_style_class_name(name);
        }
        if (state) {
            row.add_style_class_name(`is-${state}`);
        }
    }

    // --- rendering ---------------------------------------------------------

    refresh(): void {
        const macro = this._deps.store.activeMacro;

        this._headerLabel.text = macro ? macro.name : 'No macro yet';
        this._runButton.label = this._deps.isRunning() ? '■ Stop' : '▶ Run';
        this._recordButton.label = this._deps.isRecording() ? '■ Recording' : '● Record';

        this._renderMacroList();
        this._renderAddPicker(macro);
        this._renderSteps(macro);
        this._renderEditor(macro);
    }

    private _renderMacroList(): void {
        this._macroListBox.destroy_all_children();
        this._macroListBox.visible = this._showMacroList;
        if (!this._showMacroList) {
            return;
        }

        const store = this._deps.store;
        for (const macro of store.macros) {
            const row = new St.BoxLayout({ style_class: 'clickmate-macro-row' });
            const isActive = store.activeMacro?.id === macro.id;
            const select = smallButton(
                `${isActive ? '● ' : '   '}${macro.name}`,
                () => {
                    store.activeMacroId = macro.id;
                    this._selectedId = null;
                    this._showMacroList = false;
                    this.refresh();
                },
                'clickmate-macro-select',
            );
            select.x_expand = true;
            row.add_child(select);
            row.add_child(smallButton('✕', () => {
                store.removeMacro(macro.id);
                this.refresh();
            }));
            this._macroListBox.add_child(row);
        }

        this._macroListBox.add_child(smallButton('+ New macro', () => {
            const macro = newMacro(`Macro ${this._deps.store.macros.length + 1}`);
            this._deps.store.addMacro(macro);
            this._deps.store.activeMacroId = macro.id;
            this._showMacroList = false;
            this.refresh();
        }));
    }

    private _renderAddPicker(macro: Macro | null): void {
        this._addBox.destroy_all_children();
        this._addBox.visible = this._showAddPicker;
        if (!this._showAddPicker) {
            return;
        }

        this._addBox.add_child(new St.Label({
            text: this._selectedId ? 'Insert after the selected step' : 'Append to the end',
            style_class: 'clickmate-hint',
        }));

        let row = new St.BoxLayout({ style_class: 'clickmate-add-row' });
        QUICK_ADD_KINDS.forEach((kind, index) => {
            if (index > 0 && index % 4 === 0) {
                this._addBox.add_child(row);
                row = new St.BoxLayout({ style_class: 'clickmate-add-row' });
            }
            row.add_child(smallButton(STEP_KIND_LABELS[kind], () => {
                if (!macro) {
                    return;
                }
                const step = newStep(kind);
                insertStep(macro.body, step, this._selectedId);
                this._selectedId = step.id;
                this._showAddPicker = false;
                this._deps.store.save();
                this.refresh();
            }));
        });
        this._addBox.add_child(row);
    }

    private _renderSteps(macro: Macro | null): void {
        this._stepsBox.destroy_all_children();
        this._rowsById.clear();

        if (!macro) {
            this._stepsBox.add_child(new St.Label({
                text: 'Create a macro to get started.',
                style_class: 'clickmate-hint',
            }));
            return;
        }
        if (macro.body.length === 0) {
            this._stepsBox.add_child(new St.Label({
                text: 'Empty. Record something, or add a step.',
                style_class: 'clickmate-hint',
            }));
            return;
        }

        walk(macro.body, ({ step, depth }) => {
            this._stepsBox.add_child(this._buildStepRow(macro, step, depth));
        });
    }

    private _buildStepRow(macro: Macro, step: Step, depth: number): St.BoxLayout {
        const row = new St.BoxLayout({ style_class: 'clickmate-step-row' });
        if (step.id === this._selectedId) {
            row.add_style_class_name('is-selected');
        }
        if (step.enabled === false) {
            row.add_style_class_name('is-disabled');
        }

        if (depth > 0) {
            const indent = new St.Widget({ style_class: 'clickmate-indent' });
            indent.set_width(depth * 16);
            row.add_child(indent);
        }

        // Enable/disable rather than delete, so a macro can be bisected.
        row.add_child(smallButton(step.enabled === false ? '☐' : '☑', () => {
            step.enabled = step.enabled === false;
            this._deps.store.save();
            this.refresh();
        }, 'clickmate-toggle-button'));

        const summary = smallButton(describeStep(step), () => {
            this._selectedId = this._selectedId === step.id ? null : step.id;
            this.refresh();
        }, 'clickmate-step-summary');
        summary.x_expand = true;
        summary.get_child_at_index(0)?.set({ x_align: Clutter.ActorAlign.START });
        row.add_child(summary);

        row.add_child(smallButton('▶', () => this._deps.onRunStep(step), 'clickmate-icon-button'));
        row.add_child(smallButton('▲', () => {
            if (moveStep(macro.body, step.id, -1)) {
                this._deps.store.save();
                this.refresh();
            }
        }, 'clickmate-icon-button'));
        row.add_child(smallButton('▼', () => {
            if (moveStep(macro.body, step.id, 1)) {
                this._deps.store.save();
                this.refresh();
            }
        }, 'clickmate-icon-button'));
        row.add_child(smallButton('✕', () => {
            removeStep(macro.body, step.id);
            if (this._selectedId === step.id) {
                this._selectedId = null;
            }
            this._deps.store.save();
            this.refresh();
        }, 'clickmate-icon-button'));

        this._rowsById.set(step.id, row);
        const state = this._stepStates.get(step.id);
        this._applyRowState(row, state ?? null);
        return row;
    }

    // --- inline editor -----------------------------------------------------

    private _renderEditor(macro: Macro | null): void {
        this._editorBox.destroy_all_children();

        const step = macro && this._selectedId
            ? this._findStep(macro, this._selectedId)
            : null;

        this._editorBox.visible = step !== null;
        if (!macro || !step) {
            return;
        }

        const save = () => {
            this._deps.store.save();
            this.refresh();
        };

        const title = new St.BoxLayout({ style_class: 'clickmate-editor-title' });
        title.add_child(new St.Label({
            text: STEP_KIND_LABELS[step.kind],
            style_class: 'clickmate-editor-heading',
            x_expand: true,
        }));
        title.add_child(smallButton('Duplicate', () => {
            insertStep(macro.body, cloneStep(step), step.id);
            save();
        }));
        if (!isContainer(step)) {
            title.add_child(smallButton('Wrap in loop', () => {
                const wrapper = newStep('repeat');
                const target = childLists(wrapper)[0];
                const removed = removeStep(macro.body, step.id);
                if (removed && target) {
                    target.steps.push(removed);
                    macro.body.push(wrapper);
                    this._selectedId = wrapper.id;
                }
                save();
            }));
        }
        this._editorBox.add_child(title);

        this._editorBox.add_child(this._buildFields(step, save));

        // Inline guard: the "run this step only if…" prompt.
        this._editorBox.add_child(this._buildGuardRow(step, save));
    }

    private _findStep(macro: Macro, id: string): Step | null {
        let found: Step | null = null;
        walk(macro.body, ({ step }) => {
            if (!found && step.id === id) {
                found = step;
            }
        });
        return found;
    }

    private _buildFields(step: Step, save: () => void): St.BoxLayout {
        const box = new St.BoxLayout({ vertical: true, style_class: 'clickmate-fields' });
        const row = () => {
            const line = new St.BoxLayout({ style_class: 'clickmate-field-row' });
            box.add_child(line);
            return line;
        };

        switch (step.kind) {
            case 'click': {
                const click = step as ClickStep;
                const line = row();
                line.add_child(labelledEntry('x', String(click.x ?? 0), text => {
                    click.x = Math.round(toNumber(text, click.x ?? 0));
                    save();
                }, 70));
                line.add_child(labelledEntry('y', String(click.y ?? 0), text => {
                    click.y = Math.round(toNumber(text, click.y ?? 0));
                    save();
                }, 70));
                line.add_child(smallButton('Use pointer', () => {
                    const [x, y] = global.get_pointer();
                    click.x = Math.round(x);
                    click.y = Math.round(y);
                    click.mode = 'abs';
                    save();
                }));
                const line2 = row();
                line2.add_child(smallButton(`Button: ${click.button}`, () => {
                    const order: ClickStep['button'][] = ['left', 'right', 'middle', 'side', 'extra'];
                    click.button = order[(order.indexOf(click.button) + 1) % order.length];
                    save();
                }));
                line2.add_child(smallButton(`Where: ${click.mode === 'abs' ? 'at x,y' : 'at pointer'}`, () => {
                    click.mode = click.mode === 'abs' ? 'current' : 'abs';
                    save();
                }));
                line2.add_child(labelledEntry('hold ms', String(click.holdMs ?? 20), text => {
                    click.holdMs = Math.round(toNumber(text, click.holdMs ?? 20));
                    save();
                }, 60));
                break;
            }

            case 'move': {
                const move = step as MoveStep;
                const line = row();
                line.add_child(smallButton(`Mode: ${move.mode}`, () => {
                    move.mode = move.mode === 'abs' ? 'rel' : 'abs';
                    save();
                }));
                if (move.mode === 'abs') {
                    line.add_child(labelledEntry('x', String(move.x ?? 0), text => {
                        move.x = Math.round(toNumber(text, move.x ?? 0));
                        save();
                    }, 70));
                    line.add_child(labelledEntry('y', String(move.y ?? 0), text => {
                        move.y = Math.round(toNumber(text, move.y ?? 0));
                        save();
                    }, 70));
                    line.add_child(smallButton('Use pointer', () => {
                        const [x, y] = global.get_pointer();
                        move.x = Math.round(x);
                        move.y = Math.round(y);
                        save();
                    }));
                } else {
                    line.add_child(labelledEntry('dx', String(move.dx ?? 0), text => {
                        move.dx = Math.round(toNumber(text, move.dx ?? 0));
                        save();
                    }, 70));
                    line.add_child(labelledEntry('dy', String(move.dy ?? 0), text => {
                        move.dy = Math.round(toNumber(text, move.dy ?? 0));
                        save();
                    }, 70));
                }
                break;
            }

            case 'scroll': {
                const scroll = step as ScrollStep;
                const line = row();
                line.add_child(labelledEntry('horizontal', String(scroll.dx), text => {
                    scroll.dx = Math.round(toNumber(text, scroll.dx));
                    save();
                }, 60));
                line.add_child(labelledEntry('vertical', String(scroll.dy), text => {
                    scroll.dy = Math.round(toNumber(text, scroll.dy));
                    save();
                }, 60));
                break;
            }

            case 'key': {
                const key = step as KeyStep;
                const line = row();
                line.add_child(labelledEntry('key', key.code, text => {
                    key.code = text.trim().toUpperCase().startsWith('KEY_')
                        ? text.trim().toUpperCase()
                        : `KEY_${text.trim().toUpperCase()}`;
                    save();
                }, 120));
                line.add_child(smallButton(`Action: ${key.action}`, () => {
                    const order: KeyStep['action'][] = ['tap', 'down', 'up'];
                    key.action = order[(order.indexOf(key.action) + 1) % order.length];
                    save();
                }));
                line.add_child(labelledEntry('modifiers', (key.mods ?? []).join(' '), text => {
                    key.mods = text.split(/[\s,+]+/).filter(Boolean).map(name => {
                        const upper = name.toUpperCase();
                        return upper.startsWith('KEY_') ? upper : `KEY_${upper}`;
                    });
                    save();
                }, 160));
                break;
            }

            case 'text': {
                const text = step as TextStep;
                row().add_child(labelledEntry('text', text.value, value => {
                    text.value = value;
                    save();
                }, 260));
                break;
            }

            case 'wait': {
                const wait = step as WaitStep;
                const line = row();
                line.add_child(labelledEntry('ms', String(wait.ms), value => {
                    wait.ms = Math.max(0, Math.round(toNumber(value, wait.ms)));
                    save();
                }, 80));
                line.add_child(labelledEntry('± ms', String(wait.jitterMs ?? 0), value => {
                    wait.jitterMs = Math.max(0, Math.round(toNumber(value, wait.jitterMs ?? 0)));
                    save();
                }, 70));
                break;
            }

            case 'repeat': {
                const repeat = step as RepeatStep;
                const line = row();
                line.add_child(labelledEntry(
                    'count',
                    repeat.count === 'forever' ? 'forever' : String(repeat.count),
                    value => {
                        const trimmed = value.trim().toLowerCase();
                        repeat.count = trimmed === 'forever' || trimmed === ''
                            ? 'forever'
                            : Math.max(1, Math.round(toNumber(trimmed, 1)));
                        save();
                    },
                    90,
                ));
                line.add_child(new St.Label({
                    text: 'use "forever" or a number',
                    style_class: 'clickmate-hint',
                }));
                break;
            }

            case 'while': {
                const loop = step as WhileStep;
                box.add_child(this._buildConditionEditor(loop.cond, next => {
                    loop.cond = next;
                    save();
                }, save));
                row().add_child(labelledEntry('max iterations (0 = unlimited)', String(loop.maxIterations ?? 0), value => {
                    loop.maxIterations = Math.max(0, Math.round(toNumber(value, 0)));
                    save();
                }, 70));
                break;
            }

            case 'if': {
                const branch = step as IfStep;
                box.add_child(this._buildConditionEditor(branch.cond, next => {
                    branch.cond = next;
                    save();
                }, save));
                break;
            }

            case 'gate': {
                const gate = step as GateStep;
                box.add_child(this._buildConditionEditor(gate.cond, next => {
                    gate.cond = next;
                    save();
                }, save));
                const line = row();
                line.add_child(smallButton(`Otherwise: ${gate.onFalse}`, () => {
                    const order: GateAction[] = ['skip-rest', 'retry', 'break', 'continue', 'abort'];
                    gate.onFalse = order[(order.indexOf(gate.onFalse) + 1) % order.length];
                    save();
                }));
                if (gate.onFalse === 'retry') {
                    line.add_child(labelledEntry('re-check after ms', String(gate.retryMs ?? 1000), value => {
                        gate.retryMs = Math.max(50, Math.round(toNumber(value, 1000)));
                        save();
                    }, 80));
                }
                break;
            }

            case 'raw':
                row().add_child(new St.Label({
                    text: `${step.events.length} recorded events — replayed verbatim`,
                    style_class: 'clickmate-hint',
                }));
                break;

            default:
                break;
        }

        return box;
    }

    private _buildGuardRow(step: Step, save: () => void): St.BoxLayout {
        const box = new St.BoxLayout({ vertical: true, style_class: 'clickmate-guard' });
        const header = new St.BoxLayout();
        header.add_child(new St.Label({
            text: step.when ? 'Only run this step when:' : 'Runs unconditionally',
            style_class: 'clickmate-field-label',
            x_expand: true,
        }));
        header.add_child(smallButton(step.when ? 'Remove condition' : 'Add condition', () => {
            step.when = step.when ? null : { type: 'llm', prompt: '', expect: true, onError: 'false' };
            save();
        }));
        box.add_child(header);

        if (step.when) {
            box.add_child(this._buildConditionEditor(step.when, next => {
                step.when = next;
                save();
            }, save));
        }
        return box;
    }

    /**
     * Inline condition editing for the two types worth tweaking mid-flow. Nested
     * and/or/not trees are edited in the preferences window.
     */
    private _buildConditionEditor(
        condition: Condition,
        replace: (next: Condition) => void,
        save: () => void,
    ): St.BoxLayout {
        const box = new St.BoxLayout({ vertical: true, style_class: 'clickmate-condition' });

        const header = new St.BoxLayout();
        header.add_child(smallButton(`Check: ${CONDITION_TYPE_LABELS[condition.type]}`, () => {
            const order: Condition['type'][] = ['llm', 'pixel', 'regionColor', 'always'];
            const index = order.indexOf(condition.type);
            const next = order[(index + 1) % order.length];
            if (next === condition.type) {
                return;
            }
            replace(this._convertCondition(next));
        }));
        header.add_child(smallButton('Test now', () => this._deps.onTestCondition(condition)));
        box.add_child(header);

        if (condition.type === 'llm') {
            const llm = condition as LlmCondition;
            box.add_child(labelledEntry('prompt', llm.prompt, text => {
                llm.prompt = text;
                save();
            }, 300));

            const options = new St.BoxLayout({ style_class: 'clickmate-field-row' });
            options.add_child(smallButton(
                llm.region ? `Area: ${llm.region.w}×${llm.region.h} @ ${llm.region.x},${llm.region.y}` : 'Area: whole screen',
                () => this._deps.onPickRegion(region => {
                    llm.region = region;
                    save();
                }),
            ));
            if (llm.region) {
                options.add_child(smallButton('Whole screen', () => {
                    llm.region = null;
                    save();
                }));
            }
            options.add_child(smallButton(`Proceed on: ${llm.expect === false ? 'no' : 'yes'}`, () => {
                llm.expect = llm.expect === false;
                save();
            }));
            box.add_child(options);
        } else if (condition.type === 'pixel') {
            const pixel = condition as PixelCondition;
            const line = new St.BoxLayout({ style_class: 'clickmate-field-row' });
            line.add_child(labelledEntry('x', String(pixel.x), text => {
                pixel.x = Math.round(toNumber(text, pixel.x));
                save();
            }, 60));
            line.add_child(labelledEntry('y', String(pixel.y), text => {
                pixel.y = Math.round(toNumber(text, pixel.y));
                save();
            }, 60));
            line.add_child(smallButton('Use pointer', () => {
                const [x, y] = global.get_pointer();
                pixel.x = Math.round(x);
                pixel.y = Math.round(y);
                save();
            }));
            box.add_child(line);

            const line2 = new St.BoxLayout({ style_class: 'clickmate-field-row' });
            line2.add_child(labelledEntry('colour', pixel.color, text => {
                pixel.color = text.trim();
                save();
            }, 90));
            line2.add_child(labelledEntry('tolerance', String(pixel.tolerance), text => {
                pixel.tolerance = Math.max(0, Math.round(toNumber(text, pixel.tolerance)));
                save();
            }, 60));
            box.add_child(line2);
        } else if (condition.type === 'regionColor') {
            box.add_child(new St.Label({
                text: 'Region colour checks are edited in the preferences window.',
                style_class: 'clickmate-hint',
            }));
        }

        return box;
    }

    private _convertCondition(type: Condition['type']): Condition {
        switch (type) {
            case 'llm':
                return { type: 'llm', prompt: '', expect: true, onError: 'false', region: null };
            case 'pixel': {
                const [x, y] = global.get_pointer();
                return { type: 'pixel', x: Math.round(x), y: Math.round(y), color: '#22aa33', tolerance: 24 };
            }
            case 'regionColor':
                return { type: 'regionColor', x: 0, y: 0, w: 40, h: 40, color: '#22aa33', tolerance: 24, coverage: 0.6 };
            default:
                return { type: 'always' };
        }
    }
}
