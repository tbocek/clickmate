// Everything that goes wrong, in one place.
//
// Most failures here are ones a macro is designed to survive: an LLM check that
// cannot reach its endpoint counts as "no" and the macro carries on. That is the
// right behaviour and the wrong silence — a macro that quietly does nothing is
// indistinguishable from a broken one. So every swallowed error is recorded
// here as well, and the panel popup shows the list until you clear it.
//
// A module singleton rather than a callback threaded through eight files: the
// places that fail (screenshot encoding, document parsing, the event stream) are
// leaf helpers with no path back to the extension object.

import GLib from 'gi://GLib';

/** Which part of clickmate failed. Shown verbatim in the popup. */
export type ProblemSource =
    | 'Model'
    | 'Daemon'
    | 'Macro'
    | 'Step'
    | 'Recording'
    | 'Screen'
    | 'Macros'
    | 'Settings';

export interface Problem {
    id: number;
    source: ProblemSource;
    /** One line: what failed. */
    message: string;
    /** What to do about it, when there is something to do. */
    hint?: string;
    /** Which step or macro it happened in. */
    where?: string;
    /** Local wall-clock, formatted once — the popup only ever displays it. */
    time: string;
    /** How many times this same failure has happened; a poll loop repeats fast. */
    count: number;
}

export interface ProblemOptions {
    hint?: string;
    where?: string;
    /** Logged with a stack trace as well, when the failure came from a throw. */
    error?: Error;
}

const MAX_PROBLEMS = 25;

let nextId = 1;
const problems: Problem[] = [];
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            logError(error as Error, 'clickmate: problem listener failed');
        }
    }
}

/**
 * Record a failure. Repeats of the same message collapse into a count instead of
 * filling the list: a loop that checks an unreachable endpoint every iteration
 * would otherwise push everything else out within seconds.
 */
export function reportProblem(source: ProblemSource, message: string, options: ProblemOptions = {}): void {
    const text = (message ?? '').trim() || 'unknown error';
    const time = GLib.DateTime.new_now_local().format('%H:%M:%S') ?? '';

    if (options.error) {
        logError(options.error, `clickmate: ${source}: ${text}`);
    } else {
        log(`clickmate: ${source}: ${text}`);
    }

    const existing = problems.find(problem => problem.source === source && problem.message === text);
    if (existing) {
        existing.count++;
        existing.time = time;
        existing.where = options.where ?? existing.where;
        existing.hint = options.hint ?? existing.hint;
        // Newest first, so a recurring failure does not sink out of view.
        problems.splice(problems.indexOf(existing), 1);
        problems.unshift(existing);
        notify();
        return;
    }

    problems.unshift({
        id: nextId++,
        source,
        message: text,
        hint: options.hint,
        where: options.where,
        time,
        count: 1,
    });
    problems.length = Math.min(problems.length, MAX_PROBLEMS);
    notify();
}

/** Newest first. */
export function listProblems(): Problem[] {
    return [...problems];
}

export function problemCount(): number {
    return problems.length;
}

export function clearProblems(): void {
    if (problems.length === 0) {
        return;
    }
    problems.length = 0;
    notify();
}

export function onProblemsChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
