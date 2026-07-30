import {
    parseDocument, stringifyDocument, newStep, describeStep, describeCondition,
    insertStep, moveStep, removeStep, wrapStep, cloneStep, walk, findStep, newMacro,
    STEP_KIND_LABELS,
} from '../dist/src/model.js';
import { textToEvents, keyCode, keyName, charToKey, buttonFromCode } from '../dist/src/keymap.js';
import { starterMacro } from '../dist/src/starter.js';
import { parseVerdict } from '../dist/src/llm.js';
import { isLoopbackEndpoint } from '../dist/src/store.js';

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
const a = newStep('click'), b = newStep('wait'), loop = newStep('repeat');
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
check('wrap', wrapStep(macro.body, a.id, 'while')?.kind === 'while');
check('remove', removeStep(macro.body, b.id)?.id === b.id);
let counted = 0;
walk(macro.body, () => counted++);
check('walk visits nested', counted >= 4, String(counted));

// round trip
const doc = { version: 1, macros: [starterMacro()] };
const back = parseDocument(stringifyDocument(doc));
check('round trip macros', back.macros.length === 1);
check('round trip nested body', back.macros[0].body[0].body.length === 4);
check('parse empty', parseDocument('').macros.length === 0);
check('parse garbage', parseDocument('{{{').macros.length === 0);

// starter describes the requested loop
const starter = starterMacro();
check('starter is forever loop', describeStep(starter.body[0]) === 'Repeat forever', describeStep(starter.body[0]));
const gate = starter.body[0].body[0];
check('starter gate mentions the prompt', describeStep(gate).includes('button on the left green'), describeStep(gate));
check('starter has a 10s wait', describeStep(starter.body[0].body[3]) === 'Wait 10s', describeStep(starter.body[0].body[3]));
const guarded = starter.body[0].body[2];
check('starter per-step condition', describeCondition(guarded.when).startsWith('pixel'), describeCondition(guarded.when));

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

// llm verdict parsing
check('verdict json', parseVerdict('{"match": true, "reason": "green"}').match === true);
check('verdict fenced', parseVerdict('```json\n{"match": false, "reason":"grey"}\n```').match === false);
check('verdict yes', parseVerdict('YES, it is green').match === true);
check('verdict no', parseVerdict('No.').match === false);
check('verdict string bool', parseVerdict('{"match":"yes"}').match === true);
check('verdict junk', parseVerdict('hmm') === null);
check('verdict empty', parseVerdict('') === null);

// endpoint check
check('loopback localhost', isLoopbackEndpoint('http://localhost:11434/v1/chat/completions'));
check('loopback 127', isLoopbackEndpoint('http://127.0.0.1:8080/v1/chat/completions'));
check('not loopback', !isLoopbackEndpoint('http://192.168.1.5:11434/v1/chat/completions'));

print(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
if (failures > 0) imports.system.exit(1);
