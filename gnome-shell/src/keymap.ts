// evdev constants and the name <-> code tables the runner and recorder share.
// Codes come from linux/input-event-codes.h.

import type { MouseButton, RawEvent } from './model.js';

export const EV_SYN = 0;
export const EV_KEY = 1;
export const EV_REL = 2;

export const SYN_REPORT = 0;

export const REL_X = 0;
export const REL_Y = 1;
export const REL_HWHEEL = 6;
export const REL_WHEEL = 8;

export const BTN_LEFT = 0x110;
export const BTN_RIGHT = 0x111;
export const BTN_MIDDLE = 0x112;
export const BTN_SIDE = 0x113;
export const BTN_EXTRA = 0x114;

export const BUTTON_CODES: Record<MouseButton, number> = {
    left: BTN_LEFT,
    right: BTN_RIGHT,
    middle: BTN_MIDDLE,
    side: BTN_SIDE,
    extra: BTN_EXTRA,
};

export const KEY_CODES: Record<string, number> = {
    KEY_ESC: 1,
    KEY_1: 2, KEY_2: 3, KEY_3: 4, KEY_4: 5, KEY_5: 6,
    KEY_6: 7, KEY_7: 8, KEY_8: 9, KEY_9: 10, KEY_0: 11,
    KEY_MINUS: 12, KEY_EQUAL: 13, KEY_BACKSPACE: 14, KEY_TAB: 15,
    KEY_Q: 16, KEY_W: 17, KEY_E: 18, KEY_R: 19, KEY_T: 20,
    KEY_Y: 21, KEY_U: 22, KEY_I: 23, KEY_O: 24, KEY_P: 25,
    KEY_LEFTBRACE: 26, KEY_RIGHTBRACE: 27, KEY_ENTER: 28, KEY_LEFTCTRL: 29,
    KEY_A: 30, KEY_S: 31, KEY_D: 32, KEY_F: 33, KEY_G: 34,
    KEY_H: 35, KEY_J: 36, KEY_K: 37, KEY_L: 38,
    KEY_SEMICOLON: 39, KEY_APOSTROPHE: 40, KEY_GRAVE: 41, KEY_LEFTSHIFT: 42,
    KEY_BACKSLASH: 43,
    KEY_Z: 44, KEY_X: 45, KEY_C: 46, KEY_V: 47, KEY_B: 48,
    KEY_N: 49, KEY_M: 50,
    KEY_COMMA: 51, KEY_DOT: 52, KEY_SLASH: 53, KEY_RIGHTSHIFT: 54,
    KEY_KPASTERISK: 55, KEY_LEFTALT: 56, KEY_SPACE: 57, KEY_CAPSLOCK: 58,
    KEY_F1: 59, KEY_F2: 60, KEY_F3: 61, KEY_F4: 62, KEY_F5: 63,
    KEY_F6: 64, KEY_F7: 65, KEY_F8: 66, KEY_F9: 67, KEY_F10: 68,
    KEY_NUMLOCK: 69, KEY_SCROLLLOCK: 70,
    KEY_KP7: 71, KEY_KP8: 72, KEY_KP9: 73, KEY_KPMINUS: 74,
    KEY_KP4: 75, KEY_KP5: 76, KEY_KP6: 77, KEY_KPPLUS: 78,
    KEY_KP1: 79, KEY_KP2: 80, KEY_KP3: 81, KEY_KP0: 82, KEY_KPDOT: 83,
    KEY_F11: 87, KEY_F12: 88,
    KEY_KPENTER: 96, KEY_RIGHTCTRL: 97, KEY_KPSLASH: 98, KEY_SYSRQ: 99,
    KEY_RIGHTALT: 100,
    KEY_HOME: 102, KEY_UP: 103, KEY_PAGEUP: 104, KEY_LEFT: 105,
    KEY_RIGHT: 106, KEY_END: 107, KEY_DOWN: 108, KEY_PAGEDOWN: 109,
    KEY_INSERT: 110, KEY_DELETE: 111,
    KEY_MUTE: 113, KEY_VOLUMEDOWN: 114, KEY_VOLUMEUP: 115,
    KEY_PAUSE: 119,
    KEY_LEFTMETA: 125, KEY_RIGHTMETA: 126, KEY_COMPOSE: 127,
    KEY_F13: 183, KEY_F14: 184, KEY_F15: 185, KEY_F16: 186,
    KEY_F17: 187, KEY_F18: 188, KEY_F19: 189, KEY_F20: 190,
    KEY_F21: 191, KEY_F22: 192, KEY_F23: 193, KEY_F24: 194,
};

const CODE_TO_NAME = new Map<number, string>();
for (const [name, code] of Object.entries(KEY_CODES)) {
    if (!CODE_TO_NAME.has(code)) {
        CODE_TO_NAME.set(code, name);
    }
}
for (const [button, code] of Object.entries(BUTTON_CODES)) {
    CODE_TO_NAME.set(code, `BTN_${button.toUpperCase()}`);
}

export function keyName(code: number): string {
    return CODE_TO_NAME.get(code) ?? `CODE_${code}`;
}

export function keyCode(name: string): number | null {
    if (name in KEY_CODES) {
        return KEY_CODES[name];
    }
    const upper = `KEY_${name.toUpperCase()}`;
    return upper in KEY_CODES ? KEY_CODES[upper] : null;
}

export function buttonFromCode(code: number): MouseButton | null {
    switch (code) {
        case BTN_LEFT: return 'left';
        case BTN_RIGHT: return 'right';
        case BTN_MIDDLE: return 'middle';
        case BTN_SIDE: return 'side';
        case BTN_EXTRA: return 'extra';
        default: return null;
    }
}

export function isModifier(code: number): boolean {
    return code === KEY_CODES.KEY_LEFTCTRL || code === KEY_CODES.KEY_RIGHTCTRL ||
           code === KEY_CODES.KEY_LEFTSHIFT || code === KEY_CODES.KEY_RIGHTSHIFT ||
           code === KEY_CODES.KEY_LEFTALT || code === KEY_CODES.KEY_RIGHTALT ||
           code === KEY_CODES.KEY_LEFTMETA || code === KEY_CODES.KEY_RIGHTMETA;
}

export const MODIFIER_NAMES = [
    'KEY_LEFTCTRL', 'KEY_LEFTSHIFT', 'KEY_LEFTALT', 'KEY_LEFTMETA',
    'KEY_RIGHTCTRL', 'KEY_RIGHTSHIFT', 'KEY_RIGHTALT', 'KEY_RIGHTMETA',
];

// --- text -> key events ----------------------------------------------------
// A US layout table. Typing text on another layout is best done by recording it;
// this covers the common ASCII case for scripted input.

const UNSHIFTED: Record<string, string> = {
    'a': 'KEY_A', 'b': 'KEY_B', 'c': 'KEY_C', 'd': 'KEY_D', 'e': 'KEY_E',
    'f': 'KEY_F', 'g': 'KEY_G', 'h': 'KEY_H', 'i': 'KEY_I', 'j': 'KEY_J',
    'k': 'KEY_K', 'l': 'KEY_L', 'm': 'KEY_M', 'n': 'KEY_N', 'o': 'KEY_O',
    'p': 'KEY_P', 'q': 'KEY_Q', 'r': 'KEY_R', 's': 'KEY_S', 't': 'KEY_T',
    'u': 'KEY_U', 'v': 'KEY_V', 'w': 'KEY_W', 'x': 'KEY_X', 'y': 'KEY_Y',
    'z': 'KEY_Z',
    '1': 'KEY_1', '2': 'KEY_2', '3': 'KEY_3', '4': 'KEY_4', '5': 'KEY_5',
    '6': 'KEY_6', '7': 'KEY_7', '8': 'KEY_8', '9': 'KEY_9', '0': 'KEY_0',
    '-': 'KEY_MINUS', '=': 'KEY_EQUAL', '[': 'KEY_LEFTBRACE', ']': 'KEY_RIGHTBRACE',
    '\\': 'KEY_BACKSLASH', ';': 'KEY_SEMICOLON', "'": 'KEY_APOSTROPHE',
    '`': 'KEY_GRAVE', ',': 'KEY_COMMA', '.': 'KEY_DOT', '/': 'KEY_SLASH',
    ' ': 'KEY_SPACE', '\n': 'KEY_ENTER', '\t': 'KEY_TAB',
};

const SHIFTED: Record<string, string> = {
    '!': 'KEY_1', '@': 'KEY_2', '#': 'KEY_3', '$': 'KEY_4', '%': 'KEY_5',
    '^': 'KEY_6', '&': 'KEY_7', '*': 'KEY_8', '(': 'KEY_9', ')': 'KEY_0',
    '_': 'KEY_MINUS', '+': 'KEY_EQUAL', '{': 'KEY_LEFTBRACE', '}': 'KEY_RIGHTBRACE',
    '|': 'KEY_BACKSLASH', ':': 'KEY_SEMICOLON', '"': 'KEY_APOSTROPHE',
    '~': 'KEY_GRAVE', '<': 'KEY_COMMA', '>': 'KEY_DOT', '?': 'KEY_SLASH',
};

export interface CharKey {
    code: number;
    shift: boolean;
}

export function charToKey(ch: string): CharKey | null {
    const lower = ch.toLowerCase();
    if (ch >= 'A' && ch <= 'Z') {
        return { code: KEY_CODES[UNSHIFTED[lower]], shift: true };
    }
    if (UNSHIFTED[ch] !== undefined) {
        return { code: KEY_CODES[UNSHIFTED[ch]], shift: false };
    }
    if (SHIFTED[ch] !== undefined) {
        return { code: KEY_CODES[SHIFTED[ch]], shift: true };
    }
    return null;
}

/** Build the event train for typing a string. Unmappable characters are skipped. */
export function textToEvents(text: string, delayMs = 12): RawEvent[] {
    const events: RawEvent[] = [];
    const gap = Math.max(0, delayMs) * 1000;
    let shiftHeld = false;

    for (const ch of text) {
        const key = charToKey(ch);
        if (!key) {
            log(`clickmate: cannot type character ${JSON.stringify(ch)} on the US table, skipping`);
            continue;
        }

        if (key.shift && !shiftHeld) {
            events.push({ dt: gap, type: EV_KEY, code: KEY_CODES.KEY_LEFTSHIFT, value: 1 });
            shiftHeld = true;
        } else if (!key.shift && shiftHeld) {
            events.push({ dt: gap, type: EV_KEY, code: KEY_CODES.KEY_LEFTSHIFT, value: 0 });
            shiftHeld = false;
        }

        events.push({ dt: gap, type: EV_KEY, code: key.code, value: 1 });
        events.push({ dt: gap, type: EV_KEY, code: key.code, value: 0 });
    }

    if (shiftHeld) {
        events.push({ dt: gap, type: EV_KEY, code: KEY_CODES.KEY_LEFTSHIFT, value: 0 });
    }
    return events;
}
