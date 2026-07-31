// Resume tests. The runner normally drives the daemon and asks the condition
// evaluator real questions; both are stubbed here so the only thing under test
// is which steps a run visits, and in what order.

import { MacroRunner } from '../dist/src/runner.js';
import { newMacro, newStep, pathToStep } from '../dist/src/model.js';

let failures = 0;
const check = (name, cond, extra = '') => {
    if (!cond) { failures++; print(`FAIL ${name} ${extra}`); }
    else print(`ok   ${name}`);
};

// --- stubs -----------------------------------------------------------------

const daemon = {
    play: async () => ({ aborted: false }),
    stop: async () => {},
};

let condition = true;
let evaluated = 0;
const evaluator = {
    evaluate: async () => {
        evaluated++;
        return condition;
    },
};

/** A step that does nothing but be identifiable in the trace. */
function named(kind, name) {
    const step = newStep(kind);
    step.note = name;
    NAMES.set(step.id, name);
    return step;
}
const NAMES = new Map();

/**
 * Run the macro and return the names of the steps it entered, in order. Loops
 * and ifs appear too — they are steps the runner enters like any other.
 */
async function trace(macro, resumeAt = '', onStep = null) {
    const seen = [];
    const runner = new MacroRunner(daemon, evaluator, {}, {}, {
        onStepsChanged: path => {
            if (path.length === 0) {
                return;
            }
            const id = path[path.length - 1].id;
            seen.push(NAMES.get(id) ?? id);
            onStep?.(runner, id);
        },
    });
    await runner.run(macro, resumeAt);
    return { seen: seen.join(' '), runner };
}

// --- a flat macro ----------------------------------------------------------

const flat = newMacro('flat');
const [f1, f2, f3] = [named('key', 'f1'), named('key', 'f2'), named('key', 'f3')];
flat.body.push(f1, f2, f3);

check('no resume point runs everything', (await trace(flat)).seen === 'f1 f2 f3');
check('resuming skips what came before', (await trace(flat, f2.id)).seen === 'f2 f3');
check('resuming at the last step runs only it', (await trace(flat, f3.id)).seen === 'f3');
check('an id from a deleted step starts at the top',
      (await trace(flat, 'gone')).seen === 'f1 f2 f3');

// --- inside a loop ---------------------------------------------------------

const looped = newMacro('looped');
const loop = named('loop', 'loop');
loop.count = 2;
const [l1, l2, l3] = [named('key', 'l1'), named('key', 'l2'), named('key', 'l3')];
loop.body.push(l1, l2, l3);
const after = named('key', 'after');
looped.body.push(loop, after);

check('a loop runs its body every time',
      (await trace(looped)).seen === 'loop l1 l2 l3 l1 l2 l3 after');
// The point of consuming the chain on the way down: only the iteration you
// stopped in starts part-way, the next one is a whole pass.
check('resuming into a loop only shortens the first pass',
      (await trace(looped, l2.id)).seen === 'loop l2 l3 l1 l2 l3 after');
check('resuming at the loop itself runs the whole loop',
      (await trace(looped, loop.id)).seen === 'loop l1 l2 l3 l1 l2 l3 after');

// --- inside a branch -------------------------------------------------------

const branched = newMacro('branched');
const branch = named('if', 'if');
const [t1, t2] = [named('key', 't1'), named('key', 't2')];
const [e1, e2] = [named('key', 'e1'), named('key', 'e2')];
branch.then.push(t1, t2);
branch.else = [e1, e2];
branched.body.push(branch, named('key', 'tail'));

condition = true;
evaluated = 0;
check('a true condition takes then', (await trace(branched)).seen === 'if t1 t2 tail');
check('the condition was asked', evaluated === 1, String(evaluated));

// Asking again could send the run down the other branch, which would skip the
// step you picked — so a resume into a branch does not ask.
evaluated = 0;
check('resuming into else ignores a true condition',
      (await trace(branched, e2.id)).seen === 'if e2 tail');
check('the condition was not asked', evaluated === 0, String(evaluated));

evaluated = 0;
check('resuming into then works the same way',
      (await trace(branched, t2.id)).seen === 'if t2 tail');
check('still not asked', evaluated === 0, String(evaluated));

// --- what the shell reads off the runner -----------------------------------

// Pausing writes down runner.currentStepId, so it has to be the step that is
// running at the moment it is read.
let at = '';
await trace(looped, '', (runner, id) => {
    if (NAMES.get(id) === 'l2' && !at) {
        at = runner.currentStepId;
        runner.stop();
    }
});
check('currentStepId is the innermost step', at === l2.id, at);

const broken = newMacro('broken');
const bad = named('key', 'bad');
bad.code = 'no-such-key';
const badLoop = named('loop', 'badLoop');
badLoop.count = 1;
badLoop.body.push(named('key', 'ok'), bad);
broken.body.push(badLoop);
print('--- the JS ERROR below is this test working: the run is meant to fail ---');
const failed = await trace(broken);
check('a failing run stops at the step that threw', failed.seen === 'badLoop ok bad', failed.seen);
check('and reports it as the place to continue from',
      failed.runner.failedStepId === bad.id, failed.runner.failedStepId);

// --- the path the resume walks ---------------------------------------------

check('pathToStep finds a top-level step',
      pathToStep(looped.body, after.id).join('/') === after.id);
check('pathToStep names every container on the way down',
      pathToStep(looped.body, l2.id).join('/') === `${loop.id}/${l2.id}`);
check('pathToStep reaches into an else branch',
      pathToStep(branched.body, e1.id).join('/') === `${branch.id}/${e1.id}`);
check('pathToStep of a missing step is empty', pathToStep(flat.body, 'gone').length === 0);

// --- two macros at once ----------------------------------------------------

// Every enabled macro runs, and they run alongside each other rather than one
// after the other: a runner each, over the one daemon, taking turns a step at
// a time.
{
    const order = [];
    const shared = {
        play: async () => {
            await null;   // the turn another runner needs to get a step in
            return { aborted: false };
        },
        stop: async () => {},
    };
    const run = (name, steps) => {
        const macro = newMacro(name);
        for (let i = 0; i < steps; i++) {
            macro.body.push(newStep('scroll'));
        }
        const runner = new MacroRunner(shared, evaluator, {}, {}, {
            onStepsChanged: path => {
                if (path.length > 0) {
                    order.push(name);
                }
            },
        });
        return runner.run(macro);
    };
    await Promise.all([run('a', 3), run('b', 3)]);
    check('both macros ran', order.filter(n => n === 'a').length === 3 &&
          order.filter(n => n === 'b').length === 3, order.join(''));
    check('and their steps interleaved', order.join('') !== 'aaabbb', order.join(''));
}

// --- and one macro's walk to a coordinate is not cut into ------------------

// A click at a fixed position is a conversation with the pointer: nudge, read
// it back, nudge again. Another macro playing in the middle of that moves the
// very pointer being measured, so the walk holds the daemon until it has
// clicked. Played against the real queue, with only the socket stubbed out.
{
    const { DaemonClient } = await import('../dist/src/daemon.js');
    const { EV_REL, REL_X } = await import('../dist/src/keymap.js');

    let pointer = [0, 0];
    globalThis.global = { get_pointer: () => pointer };

    const log = [];
    // Stands in for the daemon: applies half of every movement it is asked for,
    // the way an acceleration curve does, so the walk takes several passes and
    // there is a gap to slip into.
    DaemonClient.prototype._play = async function (events) {
        await null;
        for (const event of events) {
            if (event.type === EV_REL) {
                if (event.code === REL_X) {
                    pointer = [pointer[0] + event.value / 2, pointer[1]];
                    log.push('m');
                } else {
                    log.push('s');   // the other macro's scrolling
                }
            } else {
                log.push('c');
            }
        }
        return { aborted: false };
    };

    const daemon = new DaemonClient();
    const walk = newMacro('walk');
    const click = newStep('click');
    click.x = 100;
    click.y = 0;
    walk.body.push(click);
    const noise = newMacro('noise');
    for (let i = 0; i < 6; i++) {
        noise.body.push(newStep('scroll'));
    }
    const start = macro => new MacroRunner(daemon, evaluator, {}, {}, {}).run(macro);
    await Promise.all([start(walk), start(noise)]);

    const trace = log.join('');
    check('the walk converged and clicked', trace.includes('c'), trace);
    check('nothing played between its nudges and its click',
          /^s*m+c+s*$/.test(trace), trace);
    check('and it took several passes to get there', trace.indexOf('c') > 2, trace);
}

// --- starting and stopping other macros ------------------------------------
{
    // The runner knows about one macro: its own. Steps that name another one
    // hand the name back to whoever owns the rest of them.
    const asked = [];
    const control = (action, macroId, at) => {
        asked.push(`${action}:${macroId}${at ? `@${at}` : ''}`);
        return macroId === 'gone' ? 'that macro is no longer there' : null;
    };
    const runWith = async body => {
        const macro = newMacro('m');
        macro.id = 'self';
        macro.body.push(...body);
        let problem = null;
        let entered = 0;
        const runner = new MacroRunner(daemon, evaluator, {}, {}, {
            onMacroControl: control,
            onStepsChanged: path => { if (path.length > 0) { entered++; } },
            onFinished: (reason, error) => {
                problem = reason === 'error' ? error.message : null;
            },
        });
        await runner.run(macro, '');
        return { problem, entered };
    };

    const other = kind => {
        const step = newStep(kind);
        step.macro = 'other';
        return step;
    };

    await runWith([other('start'), other('stop')]);
    check('a named macro is started and stopped through the callback',
          asked.join(' ') === 'start:other stop:other', asked.join(' '));

    asked.length = 0;
    const after = newStep('wait');
    after.ms = 0;
    const stopped = await runWith([newStep('stop'), after]);
    check('a stop with no macro named ends this run',
          asked.length === 0 && stopped.entered === 1,
          `${asked.join(' ')} entered=${stopped.entered}`);

    asked.length = 0;
    await runWith([newStep('start')]);
    check('a start with no macro named restarts this one',
          asked.join(' ') === 'start:self', asked.join(' '));

    // A start step naming a step is a jump: the shell ends the run and begins
    // it again at that step, so the id has to arrive with the request.
    asked.length = 0;
    const jump = newStep('start');
    jump.at = 'landing';
    await runWith([jump]);
    check('a start step passes the step to begin at through the callback',
          asked.join(' ') === 'start:self@landing', asked.join(' '));

    const missing = newStep('stop');
    missing.macro = 'gone';
    const failed = await runWith([missing]);
    check('a macro that is not there is reported, not swallowed',
          typeof failed.problem === 'string' && failed.problem.includes('no longer there'),
          String(failed.problem));
}

print(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
if (failures > 0) {
    imports.system.exit(1);
}
