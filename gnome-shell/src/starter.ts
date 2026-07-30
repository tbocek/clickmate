// The macro shipped on first run. It is the loop this project was built for:
// look at the screen, ask the model whether it is time to act, run the steps,
// wait, and go round again.

import { newId, type Macro } from './model.js';

export function starterMacro(): Macro {
    return {
        id: newId(),
        name: 'Screen-gated loop',
        shortcut: '',
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
                        kind: 'gate',
                        onFalse: 'skip-rest',
                        retryMs: 1000,
                        note: 'Nothing below runs unless the model answers yes.',
                        cond: {
                            type: 'llm',
                            prompt: 'Is the button on the left green?',
                            region: null,
                            expect: true,
                            timeoutMs: 20000,
                            cacheMs: 0,
                            onError: 'false',
                        },
                    },
                    {
                        id: newId(),
                        kind: 'click',
                        button: 'left',
                        mode: 'abs',
                        x: 100,
                        y: 200,
                        holdMs: 20,
                        note: 'Set the coordinates with “Use pointer” or the pick shortcut.',
                    },
                    {
                        id: newId(),
                        kind: 'key',
                        code: 'KEY_E',
                        action: 'tap',
                        mods: [],
                        holdMs: 20,
                        note: 'Example of a per-step condition: only pressed when the pixel matches.',
                        when: {
                            type: 'pixel',
                            x: 100,
                            y: 200,
                            color: '#22aa33',
                            tolerance: 24,
                        },
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
