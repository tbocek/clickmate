// The macro shipped on first run. It is the loop this project was built for:
// look at the screen, ask the model whether it is time to act, run the steps,
// wait, and go round again.

import { newId, type Macro } from './model.js';

export function starterMacro(): Macro {
    return {
        id: newId(),
        name: 'Screen-gated loop',
        suppressInput: false,
        body: [
            {
                id: newId(),
                kind: 'repeat',
                count: 'forever',
                note: 'Check the screen, act when it says so, then wait 10 seconds.',
                body: [
                    {
                        id: newId(),
                        kind: 'if',
                        note: 'Nothing inside runs unless the model answers yes.',
                        cond: {
                            type: 'llm',
                            prompt: 'Is the button on the left green?',
                            region: null,
                            expect: true,
                            onError: 'false',
                        },
                        then: [
                            {
                                id: newId(),
                                kind: 'click',
                                button: 'left',
                                mode: 'abs',
                                x: 100,
                                y: 200,
                                holdMs: 20,
                                note: 'Set the coordinates with the Record button.',
                            },
                            {
                                id: newId(),
                                kind: 'if',
                                note: 'A cheap, deterministic check — no model needed.',
                                cond: {
                                    type: 'color',
                                    x: 100,
                                    y: 200,
                                    w: 1,
                                    h: 1,
                                    color: '#22aa33',
                                    tolerance: 24,
                                    coverage: 1,
                                },
                                then: [
                                    {
                                        id: newId(),
                                        kind: 'key',
                                        code: 'KEY_E',
                                        action: 'tap',
                                        mods: [],
                                        holdMs: 20,
                                    },
                                ],
                                else: [],
                            },
                        ],
                        else: [],
                    },
                    {
                        id: newId(),
                        kind: 'wait',
                        ms: 10000,
                        jitterMs: 0,
                    },
                ],
            },
        ],
    };
}
