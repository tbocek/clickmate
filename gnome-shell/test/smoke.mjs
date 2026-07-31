import {
    parseDocument, stringifyDocument, newStep, describeStep, describeCondition,
    insertStep, moveStep, moveStepNested, parentOf, removeStep, cloneStep, walk, findStep, newMacro,
    resolveRecordTarget,
    resolveRunStart,
    STEP_KIND_LABELS, parseNumbers, reachesEnd, lastPointerEndpoint,
    AUTHORABLE_STEP_KINDS,
} from '../dist/src/model.js';
import { textToEvents, keyCode, keyName, charToKey, buttonFromCode } from '../dist/src/keymap.js';
import { starterMacro } from '../dist/src/starter.js';
import { parseVerdict, verdictFromObjects } from '../dist/src/llm.js';
import { isLoopbackEndpoint } from '../dist/src/store.js';
import {
    reportProblem, listProblems, problemCount, clearProblems, onProblemsChanged,
} from '../dist/src/problems.js';

let failures = 0;
const check = (name, cond, extra = '') => {
    if (!cond) { failures++; print(`FAIL ${name} ${extra}`); }
    else print(`ok   ${name}`);
};

// every step kind builds and describes
const kinds = Object.keys(STEP_KIND_LABELS);
for (const kind of kinds) {
    const step = newStep(kind);
    const text = describeStep(step);
    check(`describe ${kind}`, typeof text === 'string' && text.length > 0, text);
}

// tree ops
const macro = newMacro('t');
const a = newStep('click'), b = newStep('wait'), loop = newStep('loop');
macro.body.push(a, b);
insertStep(macro.body, loop, b.id);
check('insert after', macro.body.length === 3 && macro.body[2].id === loop.id);
const inner = newStep('key');
insertStep(macro.body, inner, loop.id);
check('insert into empty container', loop.body.length === 1 && loop.body[0].id === inner.id);
check('findStep nested', findStep(macro.body, inner.id)?.step.id === inner.id);
check('move down', moveStep(macro.body, a.id, 1) && macro.body[1].id === a.id);
check('move past end returns false', moveStep(macro.body, loop.id, 1) === false);
const clone = cloneStep(loop);
check('clone gets fresh ids', clone.id !== loop.id && clone.body[0].id !== inner.id);
check('remove', removeStep(macro.body, b.id)?.id === b.id);
let counted = 0;
walk(macro.body, () => counted++);
check('walk visits nested', counted >= 3, String(counted));

// moving with the folded/open cards of the editor in mind
const closed = () => false;
const open = () => true;
{
    const m = newMacro('m');
    const one = newStep('click'), lp = newStep('loop'), two = newStep('wait');
    const held = newStep('key');
    lp.body.push(held);
    m.body.push(one, lp, two);

    check('folded loop is stepped over',
          moveStepNested(m.body, one.id, 1, closed) &&
          m.body.map(s => s.id).join() === [lp.id, one.id, two.id].join());
    // put it back before the loop
    moveStepNested(m.body, one.id, -1, closed);

    check('open loop is stepped into',
          moveStepNested(m.body, one.id, 1, open) &&
          lp.body.map(s => s.id).join() === [one.id, held.id].join() &&
          m.body.map(s => s.id).join() === [lp.id, two.id].join());
    check('and the body knows who its parent is',
          parentOf(m.body, one.id)?.step.id === lp.id);
    check('the top of a body climbs back out above the loop',
          moveStepNested(m.body, one.id, -1, open) &&
          m.body.map(s => s.id).join() === [one.id, lp.id, two.id].join());

    check('coming up from below lands at the bottom of the body',
          moveStepNested(m.body, two.id, -1, open) &&
          lp.body.map(s => s.id).join() === [held.id, two.id].join());
    check('and the bottom of a body climbs out below the loop',
          moveStepNested(m.body, two.id, 1, open) &&
          m.body.map(s => s.id).join() === [one.id, lp.id, two.id].join());
    check('the very first step has nowhere to go up',
          moveStepNested(m.body, one.id, -1, open) === false);
    check('the very last step has nowhere to go down',
          moveStepNested(m.body, two.id, 1, open) === false);
}
{
    // An if offers two bodies: enter by whichever side you arrive from, and only
    // if that side is open.
    const m = newMacro('m');
    const before = newStep('click'), gate = newStep('if'), after = newStep('wait');
    m.body.push(before, gate, after);
    const thenOnly = (id, key) => key === 'then';

    check('moving down enters then',
          moveStepNested(m.body, before.id, 1, open) &&
          gate.then.map(s => s.id).join() === before.id);
    check('moving up enters else',
          moveStepNested(m.body, after.id, -1, open) &&
          gate.else.map(s => s.id).join() === after.id);
    moveStepNested(m.body, after.id, 1, open);   // back out below
    check('a folded else is not entered from below',
          moveStepNested(m.body, after.id, -1, thenOnly) &&
          gate.then.map(s => s.id).join() === [before.id, after.id].join());
}

{
    // The row the editor selected, as the shell reads it back. Landing a
    // recording in a loop body rather than after the loop is the whole point,
    // so it is worth a test that does not need a compositor to run.
    const m = newMacro('m');
    const first = newStep('click'), loop = newStep('loop'), gate = newStep('if');
    m.body.push(first, loop, gate);
    const inside = newStep('wait');
    loop.body.push(inside);

    const drop = (raw, step) => {
        const target = resolveRecordTarget(m.body, raw);
        target.list.splice(target.at, 0, step);
        return target;
    };

    check('no selection is the end of the macro',
          resolveRecordTarget(m.body, '').at === 3 &&
          resolveRecordTarget(m.body, '').where === '');
    check('a body lands inside the loop, after what is already there',
          drop(`in:${loop.id}:body`, newStep('text')).list === loop.body &&
          loop.body.map(s => s.kind).join() === 'wait,text');
    check('and says where it went',
          resolveRecordTarget(m.body, `in:${loop.id}:body`).where === 'the body of Repeat forever');
    check('an if names the branch it was given',
          resolveRecordTarget(m.body, `in:${gate.id}:else`).list === gate.else);
    check('a step lands right behind it, not at the end',
          drop(`after:${first.id}`, newStep('scroll')).at === 1 &&
          m.body.map(s => s.kind).join() === 'click,scroll,loop,if');
    check('a nested step lands inside the body it lives in',
          drop(`after:${inside.id}`, newStep('key')).list === loop.body &&
          loop.body.map(s => s.kind).join() === 'wait,key,text');
    check('a deleted step falls back to the end of the macro',
          resolveRecordTarget(m.body, 'after:gone').where === '' &&
          resolveRecordTarget(m.body, 'after:gone').at === m.body.length);
    check('so does a target from an older version',
          resolveRecordTarget(m.body, `${loop.id}:body`).where === '');

    // The same selection says where a run starts, so that there is one mark
    // for "here" rather than a second button meaning almost the same thing.
    check('a selected step is where the next run starts',
          resolveRunStart(m.body, `after:${first.id}`) === first.id);
    check('a step inside a body counts too',
          resolveRunStart(m.body, `after:${inside.id}`) === inside.id);
    check('a selected body starts at the top',
          resolveRunStart(m.body, `in:${loop.id}:body`) === '');
    check('so does no selection at all',
          resolveRunStart(m.body, '') === '');
    check('and so does a step that has been deleted since',
          resolveRunStart(m.body, 'after:gone') === '');
}

// round trip
const doc = { version: 1, macros: [starterMacro()] };
const back = parseDocument(stringifyDocument(doc));
check('round trip macros', back.macros.length === 1);
check('round trip nested body', back.macros[0].body[0].body.length === 2,
      String(back.macros[0].body[0].body.length));
check('parse empty', parseDocument('').macros.length === 0);
check('parse garbage', parseDocument('{{{').macros.length === 0);

// starter describes the requested loop
const starter = starterMacro();
check('starter is forever loop', describeStep(starter.body[0]) === 'Repeat forever', describeStep(starter.body[0]));
const outerIf = starter.body[0].body[0];
check('starter gate is now an if', outerIf.kind === 'if', outerIf.kind);
check('starter if mentions the prompt', describeStep(outerIf).includes('button on the left green'), describeStep(outerIf));
check('starter wait is outside the if', describeStep(starter.body[0].body[1]) === 'Wait 10s',
      describeStep(starter.body[0].body[1]));
check('starter acts inside the if', outerIf.then[0].kind === 'click');
const innerIf = outerIf.then[1];
check('starter nested colour check', innerIf.kind === 'if' && describeCondition(innerIf.cond).startsWith('pixel'),
      describeCondition(innerIf.cond));
check('starter nested body', innerIf.then.length === 1 && innerIf.then[0].kind === 'key');

// legacy inline `when` guards migrate into an if rather than vanishing
const legacy = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'legacy', body: [
    { id: 'a', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2,
      when: { type: 'pixel', x: 3, y: 4, color: '#fff', tolerance: 5 } },
    { id: 'b', kind: 'loop', count: 2, body: [
        { id: 'c', kind: 'key', code: 'KEY_E', action: 'tap',
          when: { type: 'llm', prompt: 'ready?' } },
    ] },
    { id: 'd', kind: 'wait', ms: 5, when: { type: 'always' } },
] }] });
const mig = parseDocument(legacy).macros[0].body;
check('guard migrated to if', mig[0].kind === 'if' && mig[0].then[0].id === 'a', mig[0].kind);
check('guard condition preserved', describeCondition(mig[0].cond).startsWith('pixel'), describeCondition(mig[0].cond));
check('guard removed from step', mig[0].then[0].when === undefined);
check('nested guard migrated', mig[1].body[0].kind === 'if' && mig[1].body[0].then[0].id === 'c');
check('always guard not wrapped', mig[2].kind === 'wait' && mig[2].when === undefined, mig[2].kind);

// keymap
check('keyCode KEY_E', keyCode('KEY_E') === 18);
check('keyCode bare e', keyCode('e') === 18);
check('keyName 18', keyName(18) === 'KEY_E');
check('buttonFromCode', buttonFromCode(272) === 'left');
check('charToKey shift', charToKey('A').shift === true && charToKey('a').shift === false);
const ev = textToEvents('Hi!', 0);
// H(shift) i(unshift) !(shift) -> shift down, H down/up, shift up, i down/up, shift down, ! down/up, shift up
check('textToEvents balanced', ev.filter(e => e.value === 1).length === ev.filter(e => e.value === 0).length, JSON.stringify(ev.length));
check('textToEvents releases shift at end', ev[ev.length - 1].value === 0 && ev[ev.length - 1].code === 42);

// the add-a-step menu should only offer things you can actually author
check('verbatim steps are gone entirely', !AUTHORABLE_STEP_KINDS.includes('raw')
      && STEP_KIND_LABELS['raw'] === undefined);
// a document from before verbatim recording was removed loses only those steps
const rawDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'r', body: [
    { id: 'a', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2 },
    { id: 'b', kind: 'raw', label: 'old', events: [{ dt: 0, type: 1, code: 2, value: 1 }] },
    { id: 'l', kind: 'loop', count: 'forever', body: [
        { id: 'c', kind: 'raw', label: 'nested', events: [] },
        { id: 'd', kind: 'wait', ms: 5 }] },
] }] });
const rawKept = parseDocument(rawDoc).macros[0].body;
check('raw dropped at the top level', rawKept.map(s => s.kind).join(',') === 'click,loop',
      rawKept.map(s => s.kind).join(','));
check('raw dropped inside a loop', rawKept[1].body.map(s => s.kind).join(',') === 'wait',
      rawKept[1].body.map(s => s.kind).join(','));
check('every offered kind has a label',
      AUTHORABLE_STEP_KINDS.every(k => typeof STEP_KIND_LABELS[k] === 'string'));
check('every offered kind builds something usable',
      AUTHORABLE_STEP_KINDS.every(k => newStep(k).kind === k));

// where a macro leaves the pointer, so a new recording knows where it resumes
const eqp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('no endpoint in an empty macro', lastPointerEndpoint([]) === null);
check('endpoint from the last positioned step', eqp(lastPointerEndpoint([
    { id: 'a', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2 },
    { id: 'b', kind: 'move', mode: 'abs', x: 9, y: 8 },
]), { x: 9, y: 8 }));
check('relative moves do not count', eqp(lastPointerEndpoint([
    { id: 'a', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2 },
    { id: 'b', kind: 'move', mode: 'rel', dx: 5, dy: 5 },
]), { x: 1, y: 2 }));
check('endpoint found inside a loop', eqp(lastPointerEndpoint([
    { id: 'r', kind: 'loop', count: 'forever', body: [
        { id: 'c', kind: 'click', button: 'left', mode: 'abs', x: 7, y: 7 }] },
]), { x: 7, y: 7 }));
check('keys have no endpoint', lastPointerEndpoint([
    { id: 'k', kind: 'key', code: 'KEY_A', action: 'tap' }]) === null);

// reachability, so recordings are not appended somewhere unreachable
const mk = (kind, extra = {}) => ({ id: 'x', kind, ...extra });
const loopStep = (extra) => ({ id: 'a', kind: 'loop', count: 'forever', body: [], ...extra });
check('plain list reaches the end', reachesEnd([mk('click'), mk('wait')]));
check('endless loop does not', !reachesEnd([loopStep({ body: [mk('click')] })]));
check('endless loop with a break does', reachesEnd([
    loopStep({ body: [mk('click'), { id: 'b', kind: 'break' }] })]));
check('break inside an if still counts', reachesEnd([
    loopStep({ body: [
        { id: 'i', kind: 'if', cond: { type: 'always' }, then: [{ id: 'b', kind: 'break' }], else: [] }] })]));
check('a break in a nested loop does not free the outer one', !reachesEnd([
    loopStep({ body: [loopStep({ id: 'n', body: [{ id: 'b', kind: 'break' }] })] })]));
check('counted loop reaches the end', reachesEnd([loopStep({ count: 5 })]));
check('a loop with a break reaches the end', reachesEnd([
    loopStep({ body: [{ id: 'b', kind: 'break' }] })]));
check('stop ends the list', !reachesEnd([mk('click'), { id: 's', kind: 'stop' }]));

// coordinate field parsing
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('numbers comma', eq(parseNumbers('100, 200', 2), [100, 200]));
check('numbers space', eq(parseNumbers('100 200', 2), [100, 200]));
check('numbers x', eq(parseNumbers('40x60', 2), [40, 60]));
check('numbers rect', eq(parseNumbers('10, 20, 30, 40', 4), [10, 20, 30, 40]));
check('numbers negative', eq(parseNumbers('-5, 12', 2), [-5, 12]));
check('numbers rounded', eq(parseNumbers('10.6, 20.2', 2), [11, 20]));
check('numbers padded', eq(parseNumbers('  100 ,  200  ', 2), [100, 200]));
check('numbers too few', parseNumbers('100', 2) === null);
check('numbers too many', parseNumbers('1,2,3', 2) === null);
check('numbers not a number', parseNumbers('abc, 2', 2) === null);
check('numbers empty', parseNumbers('', 2) === null);

// repeat and while fold onto one loop
const loopDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'l', body: [
    { id: 'a', kind: 'repeat', count: 'forever', body: [{ id: 'x', kind: 'wait', ms: 1 }] },
    { id: 'b', kind: 'repeat', count: 7, body: [] },
    { id: 'c', kind: 'while', cond: { type: 'llm', prompt: 'go?' }, maxIterations: 0, body: [] },
    { id: 'd', kind: 'while', cond: { type: 'llm', prompt: 'go?' }, maxIterations: 4, body: [] },
] }] });
const loops = parseDocument(loopDoc).macros[0].body;
check('all loops become one kind', loops.every(s => s.kind === 'loop'), JSON.stringify(loops.map(s => s.kind)));
check('no loop carries a condition any more', loops.every(s => s.cond === undefined));
check('maxIterations is gone', loops[3].maxIterations === undefined);
check('repeat forever keeps its shape', loops[0].count === 'forever' && loops[0].body.length === 1);
check('counted repeat keeps its count', loops[1].count === 7);
check('uncapped while becomes forever', loops[2].count === 'forever');
check('capped while keeps its cap', loops[3].count === 4);
check('repeat forever still reads as before', describeStep(loops[0]) === 'Repeat forever', describeStep(loops[0]));
check('counted repeat reads naturally', describeStep(loops[1]) === 'Repeat 7×', describeStep(loops[1]));

// a while condition becomes the `if … break` it was shorthand for
const guardStep = loops[2].body[0];
check('while condition became an if', guardStep?.kind === 'if', JSON.stringify(guardStep?.kind));
check('it breaks out of the loop', guardStep?.then[0]?.kind === 'break');
check('and it breaks when the condition fails', guardStep?.cond.type === 'not' && guardStep.cond.of.type === 'llm',
      JSON.stringify(guardStep?.cond));
check('the guard runs before the body', loops[2].body.length === 1);

// gate steps migrate into plain control flow
const gateDoc = (onFalse, extra = {}) => JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'g', body: [
    { id: 'r', kind: 'loop', count: 'forever', body: [
        { id: 'g1', kind: 'gate', onFalse, ...extra, cond: { type: 'llm', prompt: 'ready?' } },
        { id: 's1', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2 },
        { id: 's2', kind: 'wait', ms: 10000 },
    ] },
] }] });
const gateBody = onFalse => parseDocument(gateDoc(onFalse)).macros[0].body[0].body;

const skip = gateBody('skip-rest');
check('gate skip-rest wraps the rest in an if', skip.length === 1 && skip[0].kind === 'if', JSON.stringify(skip.map(s => s.kind)));
check('gate skip-rest keeps the following steps', skip[0].then.length === 2 && skip[0].then[0].id === 's1');
const brk = gateBody('break');
check('gate break becomes if-not-break', brk[0].kind === 'if' && brk[0].cond.type === 'not' && brk[0].then[0].kind === 'break');
check('gate break leaves later steps alone', brk.length === 3 && brk[1].id === 's1');
const cont = gateBody('continue');
check('gate continue becomes if-not-continue', cont[0].then[0].kind === 'continue');
const abort = gateBody('abort');
check('gate abort becomes if-not-stop', abort[0].then[0].kind === 'stop');
const retryBody = parseDocument(gateDoc('retry', { retryMs: 500 })).macros[0].body[0].body;
check('gate retry becomes a loop that breaks when ready',
      retryBody[0].kind === 'loop' && retryBody[0].body[0].kind === 'if'
      && retryBody[0].body[0].then[0].kind === 'break');
check('gate retry waits inside the loop', retryBody[0].body[1].kind === 'wait' && retryBody[0].body[1].ms === 500);

// pixel and regionColor fold onto one colour condition
const colDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'c', body: [
    { id: 'a', kind: 'if', cond: { type: 'pixel', x: 5, y: 6, color: '#abcdef', tolerance: 9 }, then: [], else: [] },
    { id: 'b', kind: 'if', cond: { type: 'regionColor', x: 1, y: 2, w: 30, h: 40, color: '#123456', tolerance: 7, coverage: 0.5 }, then: [], else: [] },
    { id: 'c', kind: 'if', cond: { type: 'and', of: [{ type: 'pixel', x: 1, y: 1, color: '#fff', tolerance: 2 }] }, then: [], else: [] },
] }] });
const cols = parseDocument(colDoc).macros[0].body;
check('pixel becomes 1x1 colour', cols[0].cond.type === 'color' && cols[0].cond.w === 1 && cols[0].cond.coverage === 1);
check('pixel keeps its position', cols[0].cond.x === 5 && cols[0].cond.y === 6 && cols[0].cond.color === '#abcdef');
check('regionColor becomes colour', cols[1].cond.type === 'color' && cols[1].cond.w === 30 && cols[1].cond.coverage === 0.5);
check('nested condition migrated', cols[2].cond.of[0].type === 'color');
check('1x1 colour describes as a pixel', describeCondition(cols[0].cond).startsWith('pixel'), describeCondition(cols[0].cond));
check('area colour describes as coverage', describeCondition(cols[1].cond).includes('30×40'), describeCondition(cols[1].cond));

// llm verdict parsing
check('verdict json', parseVerdict('{"match": true, "reason": "green"}').match === true);
check('verdict fenced', parseVerdict('```json\n{"match": false, "reason":"grey"}\n```').match === false);
check('verdict yes', parseVerdict('YES, it is green').match === true);
check('verdict no', parseVerdict('No.').match === false);
check('verdict string bool', parseVerdict('{"match":"yes"}').match === true);
check('verdict junk', parseVerdict('hmm') === null);
check('verdict empty', parseVerdict('') === null);
// small-model output shapes
check('verdict stringly false', parseVerdict('{"match":"false"}').match === false);
check('verdict numeric', parseVerdict('{"match":1}').match === true);
check('verdict numeric zero', parseVerdict('{"match":0}').match === false);
check('verdict alt key answer', parseVerdict('{"answer": true, "reason":"x"}').match === true);
check('verdict alt key result', parseVerdict('{"result": false}').match === false);
check('verdict alt key verdict', parseVerdict('{"verdict":"yes"}').match === true);
check('verdict reason via explanation', parseVerdict('{"match":true,"explanation":"grn"}').reason === 'grn');
check('verdict trailing chatter', parseVerdict('{"match": true, "reason":"ok"} I hope that helps!').match === true);
check('verdict two objects', parseVerdict('{"match": false, "reason":"a"}\n{"match": true}').match === false);
check('verdict preamble prose', parseVerdict('Sure! Here is the JSON:\n{"match": true, "reason":"green"}').match === true);
check('verdict unknown keys only', parseVerdict('{"colour":"green"}') === null,
      JSON.stringify(parseVerdict('{"colour":"green"}')));
// reasoning models: thinking is not the answer
check('verdict past a think block',
      parseVerdict('<think>Is it true? No, wait.</think>\n{"match": true, "reason":"red"}').match === true);
check('verdict think block only', parseVerdict('<think>It looks true to me.</think>') === null);
check('verdict cut off mid-thought', parseVerdict('<think>The statement seems true, so 1. **D') === null);
check('verdict braces in a thought are not the answer',
      parseVerdict('<think>maybe {"match": false}</think>{"match": true}').match === true);
check('objects-only reads written-out json',
      verdictFromObjects('I decided. {"match": false, "reason":"grey"}').match === false);
check('objects-only ignores a stray yes', verdictFromObjects('yes, that is true') === null);

// endpoint check
check('loopback localhost', isLoopbackEndpoint('http://localhost:11434/v1/chat/completions'));
check('loopback 127', isLoopbackEndpoint('http://127.0.0.1:8080/v1/chat/completions'));
check('not loopback', !isLoopbackEndpoint('http://192.168.1.5:11434/v1/chat/completions'));

// problem log
clearProblems();
let notified = 0;
const stopListening = onProblemsChanged(() => notified++);
reportProblem('Model', 'connection refused', { hint: 'start it', where: 'if LLM' });
check('problem recorded', problemCount() === 1);
check('problem listener fired', notified === 1);
check('problem fields kept', listProblems()[0].hint === 'start it' && listProblems()[0].where === 'if LLM');
check('problem is timestamped', /^\d\d:\d\d:\d\d$/.test(listProblems()[0].time), listProblems()[0].time);
reportProblem('Model', 'connection refused');
check('repeat collapses', problemCount() === 1 && listProblems()[0].count === 2);
check('repeat keeps the hint', listProblems()[0].hint === 'start it');
reportProblem('Daemon', 'not running');
check('different source is its own entry', problemCount() === 2);
check('newest first', listProblems()[0].source === 'Daemon');
reportProblem('Model', 'connection refused');
check('a repeat comes back to the top', listProblems()[0].source === 'Model');
for (let i = 0; i < 40; i++) reportProblem('Step', `failure ${i}`);
check('log is capped', problemCount() === 25, String(problemCount()));
check('the cap keeps the newest', listProblems()[0].message === 'failure 39');
reportProblem('Screen', '   ');
check('blank message still says something', listProblems()[0].message === 'unknown error');
clearProblems();
check('cleared', problemCount() === 0);
stopListening();
const before = notified;
reportProblem('Macro', 'after unsubscribe');
check('unsubscribed listener is silent', notified === before);
clearProblems();

print(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
if (failures > 0) imports.system.exit(1);
