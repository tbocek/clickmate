// The macro document model. Pure data + helpers, no GNOME Shell imports, so it
// can be used from both the shell process and the preferences process.

import GLib from 'gi://GLib';

import { reportProblem } from './problems.js';

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

export type WaitStep = StepCommon & {
    kind: 'wait';
    ms: number;
    jitterMs?: number;
};

/**
 * A loop, and nothing else. It has no condition of its own: `loop while C` is
 * exactly `loop forever: [if not C: break, …]`, and expressing it that way keeps
 * conditions in one place — inside `if` — instead of two.
 */
export type LoopStep = StepCommon & {
    kind: 'loop';
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
    kind: 'break' | 'continue';
};

/**
 * Reaching out of this macro into another one, by id. Empty means this macro,
 * so `stop` on its own is the plain "stop here" it has always been and `start`
 * on its own is "begin again from the top".
 *
 * `start` on a macro that is already running restarts it: there is one run per
 * macro, and asking for it while it is going can only mean from the beginning.
 */
export type MacroStep = StepCommon & {
    kind: 'start' | 'stop';
    macro?: string;
};

export type Step =
    | ClickStep
    | MoveStep
    | ScrollStep
    | KeyStep
    | TextStep
    | WaitStep
    | LoopStep
    | IfStep
    | FlowStep
    | MacroStep;

export type StepKind = Step['kind'];

export interface Macro {
    id: string;
    name: string;
    /**
     * Whether Run starts this one. Several can be on at once, and they run
     * alongside each other. Absent counts as on, so a macro written before this
     * flag existed still runs — the store turns the older documents into
     * explicit flags once, on the way in.
     */
    enabled?: boolean;
    body: Step[];
}

/** Absent means on: see `Macro.enabled`. */
export function macroEnabled(macro: Macro): boolean {
    return macro.enabled !== false;
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
    return { id: newId(), name, enabled: true, body: [] };
}

export function newCondition(type: ConditionType): Condition {
    switch (type) {
        case 'llm':
            return {
                type: 'llm',
                // A statement, not a question: it is what the model is asked to
                // call true or false, and it is the example every new condition
                // starts from.
                prompt: 'the button on the left is green',
                region: null,
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
        case 'wait':
            return { id, kind: 'wait', ms: 1000, jitterMs: 0 };
        case 'loop':
            return { id, kind: 'loop', count: 'forever', body: [] };
        case 'if':
            return { id, kind: 'if', cond: newCondition('color'), then: [], else: [] };
        case 'break':
        case 'continue':
            return { id, kind };
        case 'start':
        case 'stop':
            // Empty is this macro: a stop that stops the run it is in, and a
            // start that begins it again. Pick another one and it reaches over.
            return { id, kind, macro: '' };
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
            // No before Yes, which is the order the editor draws them in and so
            // the order everything that talks about "the first branch" means:
            // where a step lands when it moves down into an `if`, and which
            // branch an empty one takes a new step into.
            return [
                { key: 'else', steps: step.else },
                { key: 'then', steps: step.then },
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

/**
 * The chain of ids from the top of `list` down to `id`, outermost first, or an
 * empty array if the step is not in there. This is what lets a run start in the
 * middle of a nested body: the runner needs to know which loop and which branch
 * to descend into, not just which step to stop skipping at.
 */
export function pathToStep(list: Step[], id: string): string[] {
    for (const step of list) {
        if (step.id === id) {
            return [step.id];
        }
        for (const child of childLists(step)) {
            const inner = pathToStep(child.steps, id);
            if (inner.length > 0) {
                return [step.id, ...inner];
            }
        }
    }
    return [];
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

/** Where a recording lands: a list, and the index to put the first step at. */
export interface RecordTarget {
    list: Step[];
    at: number;
    /** How to name the spot in a notification; empty for the end of the macro. */
    where: string;
}

/**
 * Read the row preferences has selected. `after:<id>` is a step, and puts the
 * recording right behind it; `in:<id>:<branch>` is a body, and puts it at the
 * end of that body; anything else — empty, unrecognised, or naming a step that
 * has since been deleted or belongs to another macro — is the end of the macro.
 * Falling back rather than failing is deliberate: a stale selection should cost
 * you a move, not a recording.
 */
export function resolveRecordTarget(body: Step[], raw: string): RecordTarget {
    const end: RecordTarget = { list: body, at: body.length, where: '' };
    const [what, stepId, listKey] = raw.split(':');
    if (!stepId || (what !== 'after' && what !== 'in')) {
        return end;
    }
    const loc = findStep(body, stepId);
    if (!loc) {
        return end;
    }
    if (what === 'after') {
        return { list: loc.list, at: loc.index + 1, where: `after ${describeStep(loc.step)}` };
    }
    const lists = childLists(loc.step);
    const match = lists.find(list => list.key === listKey) ?? lists[0];
    return match
        ? {
            list: match.steps,
            at: match.steps.length,
            where: `the ${match.key} of ${describeStep(loc.step)}`,
        }
        : end;
}

/**
 * Where a run starts, read from the same selected row. A step selected is a
 * step to begin at — the editor has no separate "continue from here" mark, and
 * two marks meaning almost the same thing was one too many. A body, or nothing,
 * or a step that has since gone: from the top.
 */
export function resolveRunStart(body: Step[], raw: string): string {
    const [what, stepId] = raw.split(':');
    if (what !== 'after' || !stepId) {
        return '';
    }
    return findStep(body, stepId) ? stepId : '';
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

/** The container a step sits inside, and where that container itself sits. */
export function parentOf(root: Step[], id: string): StepLocation | null {
    let found: StepLocation | null = null;
    walk(root, loc => {
        for (const child of childLists(loc.step)) {
            if (!found && child.steps.some(s => s.id === id)) {
                found = loc;
            }
        }
    });
    return found;
}

/**
 * Move a step one place up or down, treating an open container as somewhere you
 * can move into. Which is the whole point: a folded loop is one card on screen,
 * so a step should pass it in a single press, while an open one is a place with
 * an inside, and the press that walks up to its edge should walk in.
 *
 * `isOpen` answers that for one branch of one container, and comes from the
 * editor, because the answer is which cards are folded on screen right now.
 * Reaching the end of a body and pressing again climbs back out, past the
 * container — otherwise a step that moved in could never leave.
 */
export function moveStepNested(
    root: Step[],
    id: string,
    delta: 1 | -1,
    isOpen: (stepId: string, listKey: string) => boolean,
): boolean {
    const loc = findStep(root, id);
    if (!loc) {
        return false;
    }

    const neighbour = loc.index + delta;
    if (neighbour >= 0 && neighbour < loc.list.length) {
        const sibling = loc.list[neighbour];
        const open = childLists(sibling).filter(list => isOpen(sibling.id, list.key));
        const [step] = loc.list.splice(loc.index, 1);
        if (open.length > 0) {
            // Enter by the near side: coming down, land on top of the first open
            // branch; coming up, land at the bottom of the last one.
            const target = delta === 1 ? open[0] : open[open.length - 1];
            if (delta === 1) {
                target.steps.unshift(step);
            } else {
                target.steps.push(step);
            }
        } else {
            loc.list.splice(neighbour, 0, step);
        }
        return true;
    }

    const parent = parentOf(root, id);
    if (!parent) {
        return false;   // already at the top or bottom of the macro
    }
    const [step] = loc.list.splice(loc.index, 1);
    parent.list.splice(parent.index + (delta === 1 ? 1 : 0), 0, step);
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
    // Named rather than taken from childLists: that order is the editor's, and
    // an `if` draws No first while the branch you mean by "inside it" is Yes.
    const inside = loc.step.kind === 'loop' ? loc.step.body
        : loc.step.kind === 'if' ? loc.step.then
        : null;
    if (inside && inside.length === 0) {
        inside.push(step);
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
 * Verbatim recording produced opaque `raw` steps; without it nothing creates
 * them and nothing can edit them, so any left over are dropped.
 */
function dropRawSteps(steps: Step[]): Step[] {
    const kept: Step[] = [];
    for (const step of steps) {
        if ((step as unknown as { kind: string }).kind === 'raw') {
            log('clickmate: dropping a verbatim step; that recording mode is gone');
            continue;
        }
        for (const list of childLists(step)) {
            const migrated = dropRawSteps(list.steps);
            list.steps.length = 0;
            list.steps.push(...migrated);
        }
        kept.push(step);
    }
    return kept;
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
        if (step.kind === 'loop' && step.count === 'forever' && !containsLoopExit(step.body)) {
            return false;
        }
    }
    return true;
}

// --- serialisation ---------------------------------------------------------

/** `not` that avoids stacking double negations when migrating. */
function negate(cond: Condition): Condition {
    return cond.type === 'not' ? cond.of : { type: 'not', of: cond };
}

/**
 * Loops have arrived at their shape in stages: first `repeat` and `while` as
 * separate kinds, then one `loop` carrying a condition. Both fold onto a loop
 * that only counts — the condition becomes the `if … break` it was shorthand
 * for, which is where every other condition in a macro already lives.
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

        const wasRepeat = legacy.kind === 'repeat';
        const wasWhile = legacy.kind === 'while';
        if (!wasRepeat && !wasWhile && legacy.kind !== 'loop') {
            continue;
        }

        legacy.kind = 'loop';
        if (wasWhile) {
            legacy.count = legacy.maxIterations && legacy.maxIterations > 0
                ? legacy.maxIterations
                : 'forever';
            delete legacy.maxIterations;
        }
        legacy.count = legacy.count ?? 'forever';

        const condition = wasRepeat ? undefined : legacy.cond;
        delete legacy.cond;
        if (condition && condition.type !== 'always') {
            // Leaving when the condition fails is the same as breaking as soon
            // as it fails, checked in the same place: the top of the body.
            legacy.body = [
                {
                    id: newId(),
                    kind: 'if',
                    cond: negate(condition),
                    then: [{ id: newId(), kind: 'break' }],
                    else: [],
                },
                ...(legacy.body ?? []),
            ];
        }
    }
    return steps;
}

/**
 * Colour checks used to be two conditions, `pixel` and `regionColor`, where the
 * first was just a 1×1 region. Fold both onto the surviving `color` type.
 */
function migrateCondition(cond: Condition | null | undefined): Condition | null {
    if (!cond) {
        return null;
    }

    // `expect: false` meant "proceed when the answer is NO", which is what `not`
    // says. Dropping the field without this would silently invert the check.
    const asked = cond as Condition & { expect?: boolean; onError?: string };
    if (cond.type === 'llm') {
        const inverted = asked.expect === false;
        delete asked.expect;
        delete asked.onError;
        if (inverted) {
            return { type: 'not', of: cond };
        }
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
                    count: 'forever',
                    body: [
                        { id: newId(), kind: 'if', cond, then: [{ id: newId(), kind: 'break' }], else: [] },
                        { id: newId(), kind: 'wait', ms: gate.retryMs ?? 1000, jitterMs: 0 },
                    ],
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

        if (step.kind === 'if') {
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
                // Left absent when it is absent, rather than defaulted here:
                // the store tells a document from before the flag existed by
                // the fact that nothing in it carries one.
                enabled: typeof macro.enabled === 'boolean' ? macro.enabled : undefined,
                body: Array.isArray(macro.body) ? macro.body : [],
            };
            walk(fixed.body, loc => {
                if (!loc.step.id) {
                    loc.step.id = newId();
                }
                // Steps used to carry a switch of their own. A macro is the
                // thing you switch on and off now, so the flag is dropped here
                // rather than left behind to mean nothing: a step that is in a
                // macro runs when that macro does.
                delete (loc.step as { enabled?: boolean }).enabled;
            });
            fixed.body = dropRawSteps(migrateGuards(migrateGates(migrateLoops(fixed.body))));
            return fixed;
        });
        return { version: raw.version ?? DOCUMENT_VERSION, macros };
    } catch (error) {
        // Returning an empty document rather than throwing keeps the extension
        // alive, but it also means every macro has just vanished from the UI —
        // which needs saying out loud, not only in the journal.
        reportProblem('Macros', `could not read the saved macros: ${(error as Error).message}`, {
            hint: 'The list will look empty until this is fixed. The stored text is still there: ' +
                'gsettings get org.gnome.shell.extensions.clickmate macros',
            error: error as Error,
        });
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
            return `LLM: "${truncate(cond.prompt)}"`;
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

/**
 * `macroName` resolves the macro a `start` or `stop` step points at. Without it
 * those read as "another macro": the runner has no document to look in, and its
 * breadcrumb is about where the run is, not which macro it just poked.
 */
export function describeStep(step: Step, macroName?: (id: string) => string | undefined): string {
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
        case 'wait':
            return step.jitterMs
                ? `Wait ${formatMs(step.ms)} ±${formatMs(step.jitterMs)}`
                : `Wait ${formatMs(step.ms)}`;
        case 'loop':
            return step.count === 'forever' ? 'Repeat forever' : `Repeat ${step.count}×`;
        case 'if':
            return `If ${describeCondition(step.cond)}`;
        case 'break':
            return 'Break out of the loop';
        case 'continue':
            return 'Skip to the next iteration';
        case 'start':
        case 'stop': {
            const verb = step.kind === 'start' ? 'Start' : 'Stop';
            if (!step.macro) {
                return step.kind === 'start' ? 'Start this macro again' : 'Stop the macro';
            }
            const name = macroName?.(step.macro);
            return name ? `${verb} “${name}”` : `${verb} another macro`;
        }
    }
}

/**
 * The kinds worth offering in an "add a step" menu — which, now that verbatim
 * recording is gone, is all of them.
 */
export const AUTHORABLE_STEP_KINDS: StepKind[] = [
    'click', 'move', 'scroll', 'key', 'text', 'wait',
    'loop', 'if', 'break', 'continue', 'start', 'stop',
];

export const STEP_KIND_LABELS: Record<StepKind, string> = {
    click: 'Click',
    move: 'Move pointer',
    scroll: 'Scroll',
    key: 'Key press',
    text: 'Type text',
    wait: 'Wait',
    loop: 'Loop',
    if: 'If / else',
    break: 'Break',
    continue: 'Continue',
    start: 'Start a macro',
    stop: 'Stop a macro',
};

export const CONDITION_TYPE_LABELS: Record<ConditionType, string> = {
    always: 'Always true',
    llm: 'Ask the LLM about a screenshot',
    color: 'Screen colour',
    and: 'All of…',
    or: 'Any of…',
    not: 'Not…',
};
