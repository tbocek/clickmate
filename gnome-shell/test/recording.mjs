// Recording tests. The Recorder normally reads a live event stream from the
// daemon and asks the shell where the pointer is; here both are stubbed so the
// coalescing logic can be driven event by event.

import { Recorder, acceleratorToEvdevCodes } from '../dist/src/recorder.js';

let failures = 0;
const check = (name, cond, extra = '') => {
    if (!cond) { failures++; print(`FAIL ${name} ${extra}`); }
    else print(`ok   ${name}`);
};

// --- stubs -----------------------------------------------------------------

let pointer = [0, 0];
globalThis.global = { get_pointer: () => [pointer[0], pointer[1], 0] };

const BASE_CONFIG = {
    recordGapMs: 250,
    recordMotion: true,
};

const EV_KEY = 1;
const EV_REL = 2;
const REL_X = 0;
const REL_Y = 1;
const BTN_LEFT = 272;
const BTN_RIGHT = 273;
const KEY_A = 30;
const KEY_B = 48;
const KEY_C = 46;
const KEY_LEFTCTRL = 29;
const KEY_LEFTSHIFT = 42;

let seq = 0;
const ev = (ms, type, code, value) => ({ seq: ++seq, t: ms * 1000, dev: 0, type, code, value });

/** Feed a script of events through a recorder and return the steps it made. */
async function record(events, overrides = {}, ignored = [], resumeFrom = null) {
    const daemon = { eventPath: '/dev/null', setRecording: async () => {} };
    const recorder = new Recorder(daemon, { ...BASE_CONFIG, ...overrides }, {});
    recorder.setIgnoredCodes(ignored);
    recorder._mode = 'macro';
    recorder._lastEndpoint = resumeFrom;
    for (const event of events) {
        recorder._onEvent(event);
    }
    return recorder.stop();
}

const kinds = steps => steps.map(s => s.kind).join(',');

// --- clicks ----------------------------------------------------------------

pointer = [100, 200];
let steps = await record([
    ev(1000, EV_KEY, BTN_LEFT, 1),
    ev(1050, EV_KEY, BTN_LEFT, 0),
]);
check('click makes one step', kinds(steps) === 'click', kinds(steps));
check('click records the press position', steps[0].x === 100 && steps[0].y === 200);
check('click records the hold time', steps[0].holdMs === 50, String(steps[0].holdMs));
check('click records the button', steps[0].button === 'left');

// The position is sampled at press time, not release: a drag should record
// where it started.
{
    const daemon = { eventPath: '/dev/null', setRecording: async () => {} };
    const recorder = new Recorder(daemon, { ...BASE_CONFIG }, {});
    recorder._mode = 'macro';
    pointer = [100, 200];
    recorder._onEvent(ev(1000, EV_KEY, BTN_LEFT, 1));
    pointer = [400, 500];                       // dragged before releasing
    recorder._onEvent(ev(1100, EV_KEY, BTN_LEFT, 0));
    const dragged = await recorder.stop();
    check('click uses the press position, not the release',
          dragged[0].x === 100 && dragged[0].y === 200, JSON.stringify(dragged[0]));
}

pointer = [10, 20];
steps = await record([
    ev(1000, EV_KEY, BTN_RIGHT, 1),
    ev(1010, EV_KEY, BTN_RIGHT, 0),
]);
check('right button recorded', steps[0].button === 'right');

steps = await record([ev(1000, EV_KEY, BTN_LEFT, 0)]);
check('release without a press is ignored', steps.length === 0, kinds(steps));

// --- keys ------------------------------------------------------------------

steps = await record([
    ev(1000, EV_KEY, KEY_A, 1),
    ev(1030, EV_KEY, KEY_A, 0),
]);
check('key tap makes one step', kinds(steps) === 'key', kinds(steps));
check('key name resolved', steps[0].code === 'KEY_A', steps[0].code);
check('key hold time', steps[0].holdMs === 30);

steps = await record([
    ev(1000, EV_KEY, KEY_A, 1),
    ev(1010, EV_KEY, KEY_A, 2),   // autorepeat
    ev(1020, EV_KEY, KEY_A, 2),
    ev(1030, EV_KEY, KEY_A, 0),
]);
check('autorepeat ignored', steps.length === 1, kinds(steps));

steps = await record([
    ev(1000, EV_KEY, KEY_LEFTCTRL, 1),
    ev(1010, EV_KEY, KEY_C, 1),
    ev(1020, EV_KEY, KEY_C, 0),
    ev(1030, EV_KEY, KEY_LEFTCTRL, 0),
]);
check('ctrl+c is one step', steps.length === 1, kinds(steps));
check('ctrl+c carries the modifier', steps[0].code === 'KEY_C' && steps[0].mods[0] === 'KEY_LEFTCTRL',
      JSON.stringify(steps[0]));

steps = await record([
    ev(1000, EV_KEY, KEY_LEFTSHIFT, 1),
    ev(1080, EV_KEY, KEY_LEFTSHIFT, 0),
]);
check('a modifier on its own is recorded', steps.length === 1 && steps[0].code === 'KEY_LEFTSHIFT',
      kinds(steps));

steps = await record([
    ev(1000, EV_KEY, KEY_LEFTCTRL, 1),
    ev(1010, EV_KEY, KEY_C, 1),
    ev(1020, EV_KEY, KEY_C, 0),
    ev(1030, EV_KEY, KEY_LEFTCTRL, 0),
], {}, [KEY_LEFTCTRL, KEY_C]);
check('ignored codes are dropped', steps.length === 0, kinds(steps));

// --- pauses ----------------------------------------------------------------

steps = await record([
    ev(1000, EV_KEY, KEY_A, 1),
    ev(1010, EV_KEY, KEY_A, 0),
    ev(2000, EV_KEY, KEY_B, 1),   // 990 ms later
    ev(2010, EV_KEY, KEY_B, 0),
]);
check('idle gap becomes a wait', kinds(steps) === 'key,wait,key', kinds(steps));
check('wait length is the idle time', steps[1].ms === 990, String(steps[1].ms));

steps = await record([
    ev(1000, EV_KEY, KEY_A, 1),
    ev(1010, EV_KEY, KEY_A, 0),
    ev(1100, EV_KEY, KEY_B, 1),   // only 90 ms
    ev(1110, EV_KEY, KEY_B, 0),
]);
check('short gaps are not recorded', kinds(steps) === 'key,key', kinds(steps));

steps = await record([
    ev(1000, EV_KEY, KEY_A, 1),
    ev(1010, EV_KEY, KEY_A, 0),
    ev(9000, EV_KEY, KEY_B, 1),
    ev(9010, EV_KEY, KEY_B, 0),
], { recordGapMs: 0 });
check('gap threshold 0 records no waits', kinds(steps) === 'key,key', kinds(steps));

// A long press is already described by holdMs; it must not also become a wait.
steps = await record([
    ev(1000, EV_KEY, KEY_A, 1),
    ev(2000, EV_KEY, KEY_A, 0),   // held for a second
]);
check('a long key press is not also a wait', kinds(steps) === 'key', kinds(steps));
check('the long press keeps its hold time', steps[0].holdMs === 1000, String(steps[0].holdMs));

steps = await record([
    ev(1000, EV_KEY, BTN_LEFT, 1),
    ev(2000, EV_KEY, BTN_LEFT, 0),
]);
check('a long click is not also a wait', kinds(steps) === 'click', kinds(steps));
check('the long click keeps its hold time', steps[0].holdMs === 1000, String(steps[0].holdMs));

// --- motion ----------------------------------------------------------------

pointer = [640, 480];
steps = await record([
    ev(1000, EV_REL, REL_X, 5),
    ev(1010, EV_REL, REL_Y, -3),
    ev(1020, EV_KEY, BTN_LEFT, 1),
    ev(1030, EV_KEY, BTN_LEFT, 0),
]);
check('motion into a click records only the click', kinds(steps) === 'click', kinds(steps));

steps = await record([
    ev(1000, EV_REL, REL_X, 5),
    ev(1010, EV_KEY, KEY_A, 1),
    ev(1020, EV_KEY, KEY_A, 0),
]);
check('motion into a key records the move', kinds(steps) === 'move,key', kinds(steps));
check('the move lands where the pointer is', steps[0].x === 640 && steps[0].y === 480);

steps = await record([
    ev(1000, EV_REL, REL_X, 5),
    ev(1010, EV_REL, REL_Y, 5),
]);
check('motion then stopping records the move', kinds(steps) === 'move', kinds(steps));

steps = await record([
    ev(1000, EV_REL, REL_X, 5),
    ev(1010, EV_KEY, KEY_A, 1),
    ev(1020, EV_KEY, KEY_A, 0),
], { recordMotion: false });
check('motion off records no move', kinds(steps) === 'key', kinds(steps));

// --- continuing from where the macro left off ------------------------------

// Between two recordings the mouse gets used for other things. Coming back to
// where the macro already left the pointer is not a step.
pointer = [800, 600];
steps = await record([
    ev(1000, EV_REL, REL_X, 5),
    ev(1010, EV_KEY, KEY_A, 1),
    ev(1020, EV_KEY, KEY_A, 0),
], {}, [], { x: 800, y: 600 });
check('returning to the last endpoint records no move', kinds(steps) === 'key', kinds(steps));

steps = await record([
    ev(1000, EV_REL, REL_X, 5),
    ev(1010, EV_KEY, KEY_A, 1),
    ev(1020, EV_KEY, KEY_A, 0),
], {}, [], { x: 802, y: 599 });
check('a pixel or two off still counts as the same place', kinds(steps) === 'key', kinds(steps));

steps = await record([
    ev(1000, EV_REL, REL_X, 5),
    ev(1010, EV_KEY, KEY_A, 1),
    ev(1020, EV_KEY, KEY_A, 0),
], {}, [], { x: 100, y: 100 });
check('moving somewhere else still records the move', kinds(steps) === 'move,key', kinds(steps));
check('and records its true position', steps[0].x === 800 && steps[0].y === 600,
      JSON.stringify(steps[0]));

// A click sets the endpoint too, so a move back onto it is not restated.
pointer = [300, 300];
steps = await record([
    ev(1000, EV_KEY, BTN_LEFT, 1),
    ev(1010, EV_KEY, BTN_LEFT, 0),
    ev(2000, EV_REL, REL_X, 2),
    ev(2100, EV_KEY, KEY_A, 1),
    ev(2110, EV_KEY, KEY_A, 0),
]);
check('a move back onto the clicked point is not restated',
      kinds(steps) === 'click,wait,key', kinds(steps));

// --- the stop shortcut ------------------------------------------------------

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('stop chord filters only its trigger key',
      eq(acceleratorToEvdevCodes('<Control><Shift>R'), [19]),
      JSON.stringify(acceleratorToEvdevCodes('<Control><Shift>R')));
check('plain key accelerator', eq(acceleratorToEvdevCodes('F9'), [67]),
      JSON.stringify(acceleratorToEvdevCodes('F9')));
check('empty accelerator', eq(acceleratorToEvdevCodes(''), []));
check('unknown key yields nothing', eq(acceleratorToEvdevCodes('<Control>Nonsense'), []));

// Ctrl+C must survive a Ctrl+Shift+R stop shortcut with its modifier intact.
steps = await record([
    ev(1000, EV_KEY, KEY_LEFTCTRL, 1),
    ev(1010, EV_KEY, KEY_C, 1),
    ev(1020, EV_KEY, KEY_C, 0),
    ev(1030, EV_KEY, KEY_LEFTCTRL, 0),
], {}, acceleratorToEvdevCodes('<Control><Shift>R'));
check('ctrl+c keeps its modifier under a ctrl-based stop chord',
      steps.length === 1 && steps[0].code === 'KEY_C' && steps[0].mods[0] === 'KEY_LEFTCTRL',
      JSON.stringify(steps));

// The trigger key itself is still dropped, in case the stream delivers it
// before the shell has acted on the shortcut.
steps = await record([
    ev(1000, EV_KEY, 19, 1),
    ev(1010, EV_KEY, 19, 0),
], {}, acceleratorToEvdevCodes('<Control><Shift>R'));
check('the trigger key is dropped', steps.length === 0, kinds(steps));

// --- a whole little session -------------------------------------------------

pointer = [300, 400];
steps = await record([
    ev(1000, EV_REL, REL_X, 20),
    ev(1010, EV_KEY, BTN_LEFT, 1),
    ev(1060, EV_KEY, BTN_LEFT, 0),
    ev(2500, EV_KEY, KEY_LEFTCTRL, 1),
    ev(2510, EV_KEY, KEY_A, 1),
    ev(2520, EV_KEY, KEY_A, 0),
    ev(2530, EV_KEY, KEY_LEFTCTRL, 0),
]);
check('session shape', kinds(steps) === 'click,wait,key', kinds(steps));
check('session click position', steps[0].x === 300 && steps[0].y === 400);
check('session wait', steps[1].ms === 1440, String(steps[1].ms));
check('session shortcut', steps[2].code === 'KEY_A' && steps[2].mods[0] === 'KEY_LEFTCTRL');

print(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
if (failures > 0) {
    imports.system.exit(1);
}
