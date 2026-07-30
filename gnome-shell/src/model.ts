// The macro document model. Pure data + helpers, no GNOME Shell imports, so it
// can be used from both the shell process and the preferences process.

import GLib from 'gi://GLib';

export const DOCUMENT_VERSION = 1;

// --- conditions ------------------------------------------------------------

export interface Region {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface AlwaysCondition {
    type: 'always';
}

export interface LlmCondition {
    type: 'llm';
    prompt: string;
    /** null/undefined means "the whole screen". */
    region?: Region | null;
    /** Overrides the globally configured model when set. */
    model?: string;
    timeoutMs?: number;
    /** Invert the answer: expect:false means "proceed when the answer is NO". */
    expect?: boolean;
    /** Reuse a verdict this many ms instead of asking again. 0 disables. */
    cacheMs?: number;
    /** What to do when the request fails or times out. */
    onError?: 'false' | 'true' | 'abort';
}

export interface PixelCondition {
    type: 'pixel';
    x: number;
    y: number;
    color: string;
    tolerance: number;
}

export interface RegionColorCondition {
    type: 'regionColor';
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    tolerance: number;
    /** Fraction of pixels that must match, 0..1. */
    coverage: number;
}

export interface AndCondition {
    type: 'and';
    of: Condition[];
}

export interface OrCondition {
    type: 'or';
    of: Condition[];
}

export interface NotCondition {
    type: 'not';
    of: Condition;
}

export type Condition =
    | AlwaysCondition
    | LlmCondition
    | PixelCondition
    | RegionColorCondition
    | AndCondition
    | OrCondition
    | NotCondition;

export type ConditionType = Condition['type'];

// --- steps -----------------------------------------------------------------

export type MouseButton = 'left' | 'right' | 'middle' | 'side' | 'extra';

export interface RawEvent {
    /** Microseconds to wait before this event. */
    dt: number;
    type: number;
    code: number;
    value: number;
    /**
     * Whether the daemon appends SYN_REPORT after this event. Defaults to true;
     * set false to group several events into one input report, e.g. the X and Y
     * halves of a single pointer move.
     */
    syn?: boolean;
}

interface StepCommon {
    id: string;
    enabled?: boolean;
    note?: string;
    /** Inline guard: the step only runs when this evaluates true. */
    when?: Condition | null;
}

export type ClickStep = StepCommon & {
    kind: 'click';
    button: MouseButton;
    /** 'abs' moves to x/y first, 'current' clicks wherever the pointer is. */
    mode: 'abs' | 'current';
    x?: number;
    y?: number;
    holdMs?: number;
};

export type MoveStep = StepCommon & {
    kind: 'move';
    mode: 'abs' | 'rel';
    x?: number;
    y?: number;
    dx?: number;
    dy?: number;
};

export type ScrollStep = StepCommon & {
    kind: 'scroll';
    dx: number;
    dy: number;
};

export type KeyStep = StepCommon & {
    kind: 'key';
    /** evdev key name, e.g. KEY_E. */
    code: string;
    action: 'tap' | 'down' | 'up';
    /** Modifier key names held around the key, e.g. ['KEY_LEFTCTRL']. */
    mods?: string[];
    holdMs?: number;
};

export type TextStep = StepCommon & {
    kind: 'text';
    value: string;
    /** Delay between characters. */
    delayMs?: number;
};

export type RawStep = StepCommon & {
    kind: 'raw';
    label?: string;
    events: RawEvent[];
};

export type WaitStep = StepCommon & {
    kind: 'wait';
    ms: number;
    jitterMs?: number;
};

export type RepeatStep = StepCommon & {
    kind: 'repeat';
    count: number | 'forever';
    body: Step[];
};

export type WhileStep = StepCommon & {
    kind: 'while';
    cond: Condition;
    maxIterations?: number;
    body: Step[];
};

export type IfStep = StepCommon & {
    kind: 'if';
    cond: Condition;
    then: Step[];
    else?: Step[];
};

export type GateAction = 'skip-rest' | 'break' | 'continue' | 'abort' | 'retry';

export type GateStep = StepCommon & {
    kind: 'gate';
    cond: Condition;
    onFalse: GateAction;
    /** For onFalse: 'retry' — how long to wait before re-evaluating. */
    retryMs?: number;
};

export type FlowStep = StepCommon & {
    kind: 'break' | 'continue' | 'stop';
};

export type Step =
    | ClickStep
    | MoveStep
    | ScrollStep
    | KeyStep
    | TextStep
    | RawStep
    | WaitStep
    | RepeatStep
    | WhileStep
    | IfStep
    | GateStep
    | FlowStep;

export type StepKind = Step['kind'];

export interface Macro {
    id: string;
    name: string;
    /** GTK accelerator string, e.g. '<Control><Shift>F5'. Empty for none. */
    shortcut?: string;
    /** Drop physical input while this macro runs. */
    suppressInput?: boolean;
    body: Step[];
}

export interface MacroDocument {
    version: number;
    macros: Macro[];
}

// --- construction ----------------------------------------------------------

export function newId(): string {
    return GLib.uuid_string_random();
}

export function emptyDocument(): MacroDocument {
    return { version: DOCUMENT_VERSION, macros: [] };
}

export function newMacro(name = 'New macro'): Macro {
    return { id: newId(), name, shortcut: '', suppressInput: false, body: [] };
}

export function newCondition(type: ConditionType): Condition {
    switch (type) {
        case 'llm':
            return {
                type: 'llm',
                prompt: 'Is the button on the left green?',
                region: null,
                expect: true,
                timeoutMs: 20000,
                cacheMs: 0,
                onError: 'false',
            };
        case 'pixel':
            return { type: 'pixel', x: 0, y: 0, color: '#22aa33', tolerance: 24 };
        case 'regionColor':
            return {
                type: 'regionColor',
                x: 0, y: 0, w: 40, h: 40,
                color: '#22aa33', tolerance: 24, coverage: 0.6,
            };
        case 'and':
            return { type: 'and', of: [] };
        case 'or':
            return { type: 'or', of: [] };
        case 'not':
            return { type: 'not', of: { type: 'always' } };
        case 'always':
        default:
            return { type: 'always' };
    }
}

export function newStep(kind: StepKind): Step {
    const id = newId();
    switch (kind) {
        case 'click':
            return { id, kind: 'click', button: 'left', mode: 'abs', x: 0, y: 0, holdMs: 20 };
        case 'move':
            return { id, kind: 'move', mode: 'abs', x: 0, y: 0 };
        case 'scroll':
            return { id, kind: 'scroll', dx: 0, dy: -1 };
        case 'key':
            return { id, kind: 'key', code: 'KEY_E', action: 'tap', mods: [], holdMs: 20 };
        case 'text':
            return { id, kind: 'text', value: '', delayMs: 12 };
        case 'raw':
            return { id, kind: 'raw', label: 'Recorded', events: [] };
        case 'wait':
            return { id, kind: 'wait', ms: 1000, jitterMs: 0 };
        case 'repeat':
            return { id, kind: 'repeat', count: 'forever', body: [] };
        case 'while':
            return { id, kind: 'while', cond: newCondition('llm'), maxIterations: 0, body: [] };
        case 'if':
            return { id, kind: 'if', cond: newCondition('pixel'), then: [], else: [] };
        case 'gate':
            return { id, kind: 'gate', cond: newCondition('llm'), onFalse: 'skip-rest', retryMs: 1000 };
        case 'break':
        case 'continue':
        case 'stop':
            return { id, kind };
    }
}

/** The kinds that hold nested step lists, in the order the UI should show them. */
export function childLists(step: Step): { key: string; steps: Step[] }[] {
    switch (step.kind) {
        case 'repeat':
            return [{ key: 'body', steps: step.body }];
        case 'while':
            return [{ key: 'body', steps: step.body }];
        case 'if':
            return [
                { key: 'then', steps: step.then },
                { key: 'else', steps: step.else ?? [] },
            ];
        default:
            return [];
    }
}

export function isContainer(step: Step): boolean {
    return step.kind === 'repeat' || step.kind === 'while' || step.kind === 'if';
}

// --- tree operations -------------------------------------------------------

export interface StepLocation {
    /** The list the step lives in (mutable reference into the document). */
    list: Step[];
    index: number;
    step: Step;
    depth: number;
}

/** Depth-first walk over every step in a list, including nested bodies. */
export function walk(
    list: Step[],
    visit: (loc: StepLocation) => void,
    depth = 0,
): void {
    list.forEach((step, index) => {
        visit({ list, index, step, depth });
        for (const child of childLists(step)) {
            walk(child.steps, visit, depth + 1);
        }
    });
}

export function findStep(list: Step[], id: string): StepLocation | null {
    let found: StepLocation | null = null;
    walk(list, loc => {
        if (!found && loc.step.id === id) {
            found = loc;
        }
    });
    return found;
}

export function removeStep(list: Step[], id: string): Step | null {
    const loc = findStep(list, id);
    if (!loc) {
        return null;
    }
    return loc.list.splice(loc.index, 1)[0] ?? null;
}

/** Move a step within its own list only, so reordering never changes nesting. */
export function moveStep(list: Step[], id: string, delta: number): boolean {
    const loc = findStep(list, id);
    if (!loc) {
        return false;
    }
    const target = loc.index + delta;
    if (target < 0 || target >= loc.list.length) {
        return false;
    }
    const [step] = loc.list.splice(loc.index, 1);
    loc.list.splice(target, 0, step);
    return true;
}

/**
 * Insert `step` after the step with id `afterId`. When that step is an empty
 * container the new step goes inside it, which is what you almost always want
 * right after adding a loop.
 */
export function insertStep(list: Step[], step: Step, afterId?: string | null): void {
    if (!afterId) {
        list.push(step);
        return;
    }
    const loc = findStep(list, afterId);
    if (!loc) {
        list.push(step);
        return;
    }
    const children = childLists(loc.step);
    if (children.length > 0 && children[0].steps.length === 0) {
        children[0].steps.push(step);
        return;
    }
    loc.list.splice(loc.index + 1, 0, step);
}

/** Wrap a step in a new container step, in place. */
export function wrapStep(list: Step[], id: string, kind: 'repeat' | 'while' | 'if'): Step | null {
    const loc = findStep(list, id);
    if (!loc) {
        return null;
    }
    const wrapper = newStep(kind);
    const target = childLists(wrapper)[0];
    if (!target) {
        return null;
    }
    target.steps.push(loc.step);
    loc.list.splice(loc.index, 1, wrapper);
    return wrapper;
}

/** Deep copy with fresh ids, for duplicating a step. */
export function cloneStep(step: Step): Step {
    const copy = JSON.parse(JSON.stringify(step)) as Step;
    const reid = (s: Step) => {
        s.id = newId();
        for (const child of childLists(s)) {
            child.steps.forEach(reid);
        }
    };
    reid(copy);
    return copy;
}

// --- serialisation ---------------------------------------------------------

export function parseDocument(json: string): MacroDocument {
    if (!json || json.trim() === '') {
        return emptyDocument();
    }
    try {
        const raw = JSON.parse(json) as Partial<MacroDocument>;
        if (!raw || !Array.isArray(raw.macros)) {
            return emptyDocument();
        }
        // Repair anything that lost an id, so the UI never deals with undefined.
        const macros = raw.macros.map(macro => {
            const fixed: Macro = {
                id: macro.id || newId(),
                name: macro.name || 'Unnamed macro',
                shortcut: macro.shortcut ?? '',
                suppressInput: macro.suppressInput ?? false,
                body: Array.isArray(macro.body) ? macro.body : [],
            };
            walk(fixed.body, loc => {
                if (!loc.step.id) {
                    loc.step.id = newId();
                }
            });
            return fixed;
        });
        return { version: raw.version ?? DOCUMENT_VERSION, macros };
    } catch (error) {
        logError(error as Error, 'clickmate: failed to parse macro document');
        return emptyDocument();
    }
}

export function stringifyDocument(doc: MacroDocument): string {
    return JSON.stringify(doc);
}

// --- human readable summaries ---------------------------------------------

function truncate(text: string, max = 42): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function describeCondition(cond: Condition | null | undefined): string {
    if (!cond) {
        return 'always';
    }
    switch (cond.type) {
        case 'always':
            return 'always';
        case 'llm':
            return `${cond.expect === false ? 'LLM says no: ' : 'LLM: '}"${truncate(cond.prompt)}"`;
        case 'pixel':
            return `pixel ${cond.x},${cond.y} ≈ ${cond.color}`;
        case 'regionColor':
            return `${Math.round((cond.coverage ?? 0) * 100)}% of ${cond.w}×${cond.h} @ ${cond.x},${cond.y} ≈ ${cond.color}`;
        case 'and':
            return cond.of.length ? cond.of.map(describeCondition).join(' and ') : 'always';
        case 'or':
            return cond.of.length ? cond.of.map(describeCondition).join(' or ') : 'never';
        case 'not':
            return `not (${describeCondition(cond.of)})`;
    }
}

function formatMs(ms: number): string {
    if (ms >= 1000 && ms % 1000 === 0) {
        return `${ms / 1000}s`;
    }
    if (ms >= 1000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${ms}ms`;
}

export function describeStep(step: Step): string {
    switch (step.kind) {
        case 'click':
            return step.mode === 'abs'
                ? `Click ${step.button} @ ${step.x ?? 0},${step.y ?? 0}`
                : `Click ${step.button} at pointer`;
        case 'move':
            return step.mode === 'abs'
                ? `Move to ${step.x ?? 0},${step.y ?? 0}`
                : `Move by ${step.dx ?? 0},${step.dy ?? 0}`;
        case 'scroll':
            return `Scroll ${step.dx ? `${step.dx} horizontally` : ''}${step.dx && step.dy ? ', ' : ''}${step.dy ? `${step.dy} vertically` : ''}`.trim() || 'Scroll';
        case 'key': {
            const mods = (step.mods ?? []).map(m => m.replace(/^KEY_/, '').toLowerCase());
            const name = step.code.replace(/^KEY_/, '');
            const combo = [...mods, name].join('+');
            const verb = step.action === 'tap' ? 'Press' : step.action === 'down' ? 'Hold down' : 'Release';
            return `${verb} ${combo}`;
        }
        case 'text':
            return `Type "${truncate(step.value)}"`;
        case 'raw':
            return `${step.label || 'Recorded'} (${step.events.length} events)`;
        case 'wait':
            return step.jitterMs
                ? `Wait ${formatMs(step.ms)} ±${formatMs(step.jitterMs)}`
                : `Wait ${formatMs(step.ms)}`;
        case 'repeat':
            return step.count === 'forever' ? 'Repeat forever' : `Repeat ${step.count}×`;
        case 'while':
            return `While ${describeCondition(step.cond)}`;
        case 'if':
            return `If ${describeCondition(step.cond)}`;
        case 'gate': {
            const action = {
                'skip-rest': 'skip the rest',
                'break': 'break the loop',
                'continue': 'next iteration',
                'abort': 'stop the macro',
                'retry': 'wait and re-check',
            }[step.onFalse];
            return `Only continue if ${describeCondition(step.cond)} — otherwise ${action}`;
        }
        case 'break':
            return 'Break out of the loop';
        case 'continue':
            return 'Skip to the next iteration';
        case 'stop':
            return 'Stop the macro';
    }
}

export const STEP_KIND_LABELS: Record<StepKind, string> = {
    click: 'Click',
    move: 'Move pointer',
    scroll: 'Scroll',
    key: 'Key press',
    text: 'Type text',
    raw: 'Recorded events',
    wait: 'Wait',
    repeat: 'Repeat loop',
    while: 'While loop',
    if: 'If / else',
    gate: 'Gate (proceed only if…)',
    break: 'Break',
    continue: 'Continue',
    stop: 'Stop',
};

export const CONDITION_TYPE_LABELS: Record<ConditionType, string> = {
    always: 'Always true',
    llm: 'Ask the LLM about a screenshot',
    pixel: 'Pixel colour',
    regionColor: 'Region colour',
    and: 'All of…',
    or: 'Any of…',
    not: 'Not…',
};
