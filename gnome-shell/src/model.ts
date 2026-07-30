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
    /** Invert the answer: expect:false means "proceed when the answer is NO". */
    expect?: boolean;
    /** What to do when the request fails or times out. */
    onError?: 'false' | 'true' | 'abort';
}

/**
 * A colour check over a screen area. A 1×1 area with full coverage is the
 * single-pixel case, so there is one condition here rather than two.
 */
export interface ColorCondition {
    type: 'color';
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
    | ColorCondition
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

/**
 * One loop, driven by a condition and/or a count. A plain counted loop is just
 * this with an `always` condition, which is why there is no separate `repeat`.
 */
export type LoopStep = StepCommon & {
    kind: 'loop';
    /** Checked before every iteration. */
    cond: Condition;
    /** Iteration cap, or 'forever' for none. */
    count: number | 'forever';
    body: Step[];
};

export type IfStep = StepCommon & {
    kind: 'if';
    cond: Condition;
    then: Step[];
    else?: Step[];
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
    | LoopStep
    | IfStep
    | FlowStep;

export type StepKind = Step['kind'];

export interface Macro {
    id: string;
    name: string;
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
    return { id: newId(), name, body: [] };
}

export function newCondition(type: ConditionType): Condition {
    switch (type) {
        case 'llm':
            return {
                type: 'llm',
                prompt: 'Is the button on the left green?',
                region: null,
                expect: true,
                onError: 'false',
            };
        case 'color':
            return {
                type: 'color',
                x: 0, y: 0, w: 1, h: 1,
                color: '#22aa33', tolerance: 24, coverage: 1,
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
        case 'loop':
            return { id, kind: 'loop', cond: { type: 'always' }, count: 'forever', body: [] };
        case 'if':
            return { id, kind: 'if', cond: newCondition('color'), then: [], else: [] };
        case 'break':
        case 'continue':
        case 'stop':
            return { id, kind };
    }
}

/** The kinds that hold nested step lists, in the order the UI should show them. */
export function childLists(step: Step): { key: string; steps: Step[] }[] {
    switch (step.kind) {
        case 'loop':
            return [{ key: 'body', steps: step.body }];
        case 'if':
            // Materialise the else branch: callers push into these arrays, and a
            // `?? []` fallback would silently swallow whatever they add.
            step.else ??= [];
            return [
                { key: 'then', steps: step.then },
                { key: 'else', steps: step.else },
            ];
        default:
            return [];
    }
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

/**
 * Where the pointer is left after this macro, as far as can be told statically:
 * the last step that names an absolute position. Used when recording, so a fresh
 * session knows where the macro already left off.
 */
export function lastPointerEndpoint(steps: Step[]): { x: number; y: number } | null {
    let endpoint: { x: number; y: number } | null = null;
    walk(steps, ({ step }) => {
        if ((step.kind === 'click' || step.kind === 'move') && step.mode === 'abs'
            && typeof step.x === 'number' && typeof step.y === 'number') {
            endpoint = { x: step.x, y: step.y };
        }
    });
    return endpoint;
}

/**
 * Whether a `break` or `stop` in this list could end the loop that contains it.
 * Nested loops are not searched: a `break` inside one binds to that loop.
 */
function containsLoopExit(steps: Step[]): boolean {
    for (const step of steps) {
        if (step.kind === 'break' || step.kind === 'stop') {
            return true;
        }
        if (step.kind === 'if') {
            if (containsLoopExit(step.then) || containsLoopExit(step.else ?? [])) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Whether execution can ever reach the end of this list. False when it runs into
 * an endless loop with no way out — which matters because anything appended
 * after that point, a recording for instance, would never run.
 */
export function reachesEnd(steps: Step[]): boolean {
    for (const step of steps) {
        if (step.kind === 'stop') {
            return false;
        }
        if (step.kind === 'loop' && step.count === 'forever'
            && step.cond.type === 'always' && !containsLoopExit(step.body)) {
            return false;
        }
    }
    return true;
}

// --- serialisation ---------------------------------------------------------

/**
 * `repeat` and `while` were one loop wearing two names: a repeat is a while with
 * an `always` condition, and a while already carried an iteration cap. Fold both
 * onto the surviving `loop`.
 */
function migrateLoops(steps: Step[]): Step[] {
    for (const step of steps) {
        const legacy = step as unknown as {
            kind: string;
            cond?: Condition;
            count?: number | 'forever';
            maxIterations?: number;
            body?: Step[];
            then?: Step[];
            else?: Step[];
        };

        legacy.body = legacy.body ? migrateLoops(legacy.body) : legacy.body;
        legacy.then = legacy.then ? migrateLoops(legacy.then) : legacy.then;
        legacy.else = legacy.else ? migrateLoops(legacy.else) : legacy.else;

        if (legacy.kind === 'repeat') {
            legacy.kind = 'loop';
            legacy.cond = { type: 'always' };
            legacy.count = legacy.count ?? 'forever';
        } else if (legacy.kind === 'while') {
            legacy.kind = 'loop';
            legacy.count = legacy.maxIterations && legacy.maxIterations > 0
                ? legacy.maxIterations
                : 'forever';
            legacy.cond = legacy.cond ?? { type: 'always' };
            delete legacy.maxIterations;
        }
    }
    return steps;
}

/** `not` that avoids stacking double negations when migrating. */
function negate(cond: Condition): Condition {
    return cond.type === 'not' ? cond.of : { type: 'not', of: cond };
}

/**
 * Colour checks used to be two conditions, `pixel` and `regionColor`, where the
 * first was just a 1×1 region. Fold both onto the surviving `color` type.
 */
function migrateCondition(cond: Condition | null | undefined): Condition | null {
    if (!cond) {
        return null;
    }
    // Deliberately erased to a plain record: the live union no longer has these
    // members, and narrowing against it would elide the checks below.
    const legacy = cond as unknown as {
        type: string; x?: number; y?: number; w?: number; h?: number;
        color?: string; tolerance?: number; coverage?: number;
    };

    if (legacy.type === 'pixel') {
        return {
            type: 'color',
            x: legacy.x ?? 0,
            y: legacy.y ?? 0,
            w: 1,
            h: 1,
            color: legacy.color ?? '#000000',
            tolerance: legacy.tolerance ?? 24,
            coverage: 1,
        };
    }
    if (legacy.type === 'regionColor') {
        return {
            type: 'color',
            x: legacy.x ?? 0,
            y: legacy.y ?? 0,
            w: Math.max(1, legacy.w ?? 1),
            h: Math.max(1, legacy.h ?? 1),
            color: legacy.color ?? '#000000',
            tolerance: legacy.tolerance ?? 24,
            coverage: legacy.coverage ?? 1,
        };
    }

    if (cond.type === 'and' || cond.type === 'or') {
        cond.of = cond.of.map(child => migrateCondition(child)!).filter(Boolean);
    } else if (cond.type === 'not') {
        cond.of = migrateCondition(cond.of) ?? { type: 'always' };
    }
    return cond;
}

interface LegacyGate {
    kind: 'gate';
    id: string;
    cond: Condition;
    onFalse?: 'skip-rest' | 'break' | 'continue' | 'abort' | 'retry';
    retryMs?: number;
}

/**
 * `gate` was a second way to spell `if`, and its "skip the rest" action in fact
 * broke out of the loop. Rewrite each one as the plain control flow it meant,
 * following the labels the editor showed rather than what the runner did.
 */
function migrateGates(steps: Step[]): Step[] {
    const migrated: Step[] = [];

    for (let index = 0; index < steps.length; index++) {
        const step = steps[index];

        // Gates nest, so recurse before deciding what this step becomes.
        if (step.kind === 'loop') {
            step.body = migrateGates(step.body);
        } else if (step.kind === 'if') {
            step.then = migrateGates(step.then);
            step.else = migrateGates(step.else ?? []);
        }

        if ((step as unknown as LegacyGate).kind !== 'gate') {
            migrated.push(step);
            continue;
        }

        const gate = step as unknown as LegacyGate;
        const cond = migrateCondition(gate.cond) ?? { type: 'always' };
        const flow = (kind: 'break' | 'continue' | 'stop'): Step => ({ id: newId(), kind });
        const ifNot = (body: Step[]): Step =>
            ({ id: newId(), kind: 'if', cond: negate(cond), then: body, else: [] });

        switch (gate.onFalse) {
            case 'break':
                migrated.push(ifNot([flow('break')]));
                break;
            case 'continue':
                migrated.push(ifNot([flow('continue')]));
                break;
            case 'abort':
                migrated.push(ifNot([flow('stop')]));
                break;
            case 'retry':
                migrated.push({
                    id: newId(),
                    kind: 'loop',
                    cond: negate(cond),
                    count: 'forever',
                    body: [{ id: newId(), kind: 'wait', ms: gate.retryMs ?? 1000, jitterMs: 0 }],
                });
                break;
            case 'skip-rest':
            default:
                // Everything after the gate was conditional on it, so that is
                // exactly the body of the `if` it becomes.
                migrated.push({
                    id: newId(),
                    kind: 'if',
                    cond,
                    then: migrateGates(steps.slice(index + 1)),
                    else: [],
                });
                return migrated;
        }
    }

    return migrated;
}

/**
 * Steps used to carry an inline `when` guard, which did the same job as an `if`
 * with a one-step body. Rather than dropping the field — which would silently
 * make a guarded step run unconditionally — wrap each one in the `if` it always
 * was.
 */
function migrateGuards(steps: Step[]): Step[] {
    const migrated: Step[] = [];

    for (const step of steps) {
        if (step.kind === 'loop') {
            step.body = migrateGuards(step.body);
        } else if (step.kind === 'if') {
            step.then = migrateGuards(step.then);
            step.else = migrateGuards(step.else ?? []);
        }

        if (step.kind === 'if' || step.kind === 'loop') {
            step.cond = migrateCondition(step.cond) ?? { type: 'always' };
        }

        const legacy = step as Step & { when?: Condition | null };
        const guard = migrateCondition(legacy.when);
        delete legacy.when;

        if (guard && guard.type !== 'always') {
            migrated.push({ id: newId(), kind: 'if', cond: guard, then: [step], else: [] });
        } else {
            migrated.push(step);
        }
    }

    return migrated;
}

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
                body: Array.isArray(macro.body) ? macro.body : [],
            };
            walk(fixed.body, loc => {
                if (!loc.step.id) {
                    loc.step.id = newId();
                }
            });
            fixed.body = migrateGuards(migrateGates(migrateLoops(fixed.body)));
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

/**
 * Parse a group of related numbers typed as one field: "100, 200",
 * "100 200", "100x200". Returns null unless exactly `count` numbers are found,
 * so a half-typed value never overwrites a good one.
 */
export function parseNumbers(text: string, count: number): number[] | null {
    const parts = (text ?? '').split(/[\s,;x×]+/).filter(Boolean);
    if (parts.length !== count) {
        return null;
    }
    const numbers = parts.map(Number);
    return numbers.every(Number.isFinite) ? numbers.map(Math.round) : null;
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
        case 'color':
            return cond.w * cond.h === 1
                ? `pixel ${cond.x},${cond.y} ≈ ${cond.color}`
                : `${Math.round((cond.coverage ?? 0) * 100)}% of ${cond.w}×${cond.h} @ ${cond.x},${cond.y} ≈ ${cond.color}`;
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
        case 'loop': {
            // Named after how it reads, not how it is stored: a loop with an
            // `always` condition is what anyone would call a repeat.
            const forever = step.count === 'forever';
            if (step.cond.type === 'always') {
                return forever ? 'Repeat forever' : `Repeat ${step.count}×`;
            }
            return forever
                ? `While ${describeCondition(step.cond)}`
                : `While ${describeCondition(step.cond)}, at most ${step.count}×`;
        }
        case 'if':
            return `If ${describeCondition(step.cond)}`;
        case 'break':
            return 'Break out of the loop';
        case 'continue':
            return 'Skip to the next iteration';
        case 'stop':
            return 'Stop the macro';
    }
}

/**
 * The kinds worth offering in an "add a step" menu. `raw` is deliberately
 * absent: it only ever comes out of verbatim recording, and adding an empty one
 * by hand produces a step that does nothing and cannot be filled in.
 */
export const AUTHORABLE_STEP_KINDS: StepKind[] = [
    'click', 'move', 'scroll', 'key', 'text', 'wait',
    'loop', 'if', 'break', 'continue', 'stop',
];

export const STEP_KIND_LABELS: Record<StepKind, string> = {
    click: 'Click',
    move: 'Move pointer',
    scroll: 'Scroll',
    key: 'Key press',
    text: 'Type text',
    raw: 'Recorded events',
    wait: 'Wait',
    loop: 'Loop',
    if: 'If / else',
    break: 'Break',
    continue: 'Continue',
    stop: 'Stop',
};

export const CONDITION_TYPE_LABELS: Record<ConditionType, string> = {
    always: 'Always true',
    llm: 'Ask the LLM about a screenshot',
    color: 'Screen colour',
    and: 'All of…',
    or: 'Any of…',
    not: 'Not…',
};
