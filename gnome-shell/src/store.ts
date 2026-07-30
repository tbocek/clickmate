// GSettings-backed document store. Both the shell process and the preferences
// process instantiate one of these against the same schema, so an edit made in
// prefs shows up in the popup (and vice versa) without any extra plumbing.

import Gio from 'gi://Gio';

import {
    Macro,
    MacroDocument,
    Step,
    emptyDocument,
    findStep,
    parseDocument,
    stringifyDocument,
} from './model.js';

export interface Config {
    llmEndpoint: string;
    llmModel: string;
    llmApiKey: string;
    llmTimeoutMs: number;
    llmMaxWidth: number;
    llmJpegQuality: number;
    controlSocket: string;
    eventSocket: string;
    neutralizePointerAccel: boolean;
    recordDelays: boolean;
    recordGapMs: number;
    recordMotion: boolean;
    recordRaw: boolean;
}

export class MacroStore {
    private _settings: Gio.Settings;
    private _doc: MacroDocument;
    private _changedId: number;
    private _writing = false;
    private _listeners = new Set<() => void>();

    constructor(settings: Gio.Settings) {
        this._settings = settings;
        this._doc = parseDocument(settings.get_string('macros'));

        this._changedId = settings.connect('changed::macros', () => {
            if (this._writing) {
                return; // our own write echoing back
            }
            this._doc = parseDocument(this._settings.get_string('macros'));
            this._notify();
        });
    }

    destroy(): void {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._listeners.clear();
    }

    get settings(): Gio.Settings {
        return this._settings;
    }

    get document(): MacroDocument {
        return this._doc;
    }

    get macros(): Macro[] {
        return this._doc.macros;
    }

    /** Called whenever the document changes, from either process. */
    onChanged(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    private _notify(): void {
        for (const listener of [...this._listeners]) {
            try {
                listener();
            } catch (error) {
                logError(error as Error, 'clickmate: store listener failed');
            }
        }
    }

    /** Persist the in-memory document and tell every listener about it. */
    save(): void {
        this._writing = true;
        try {
            this._settings.set_string('macros', stringifyDocument(this._doc));
        } finally {
            this._writing = false;
        }
        this._notify();
    }

    replaceDocument(doc: MacroDocument): void {
        this._doc = doc;
        this.save();
    }

    reset(): void {
        this._doc = emptyDocument();
        this.save();
    }

    getMacro(id: string): Macro | null {
        return this._doc.macros.find(macro => macro.id === id) ?? null;
    }

    get activeMacroId(): string {
        return this._settings.get_string('active-macro-id');
    }

    set activeMacroId(id: string) {
        this._settings.set_string('active-macro-id', id);
    }

    /** The macro the popup and shortcuts act on; falls back to the first one. */
    get activeMacro(): Macro | null {
        const selected = this.getMacro(this.activeMacroId);
        if (selected) {
            return selected;
        }
        return this._doc.macros[0] ?? null;
    }

    addMacro(macro: Macro): void {
        this._doc.macros.push(macro);
        this.save();
    }

    removeMacro(id: string): void {
        this._doc.macros = this._doc.macros.filter(macro => macro.id !== id);
        this.save();
    }

    /** Find a step anywhere in the document, plus the macro that owns it. */
    locateStep(stepId: string): { macro: Macro; step: Step } | null {
        for (const macro of this._doc.macros) {
            const loc = findStep(macro.body, stepId);
            if (loc) {
                return { macro, step: loc.step };
            }
        }
        return null;
    }

    get config(): Config {
        const s = this._settings;
        return {
            llmEndpoint: s.get_string('llm-endpoint'),
            llmModel: s.get_string('llm-model'),
            llmApiKey: s.get_string('llm-api-key'),
            llmTimeoutMs: s.get_int('llm-timeout-ms'),
            llmMaxWidth: s.get_int('llm-max-width'),
            llmJpegQuality: s.get_int('llm-jpeg-quality'),
            controlSocket: s.get_string('control-socket'),
            eventSocket: s.get_string('event-socket'),
            neutralizePointerAccel: s.get_boolean('neutralize-pointer-accel'),
            recordDelays: s.get_boolean('record-delays'),
            recordGapMs: s.get_int('record-gap-ms'),
            recordMotion: s.get_boolean('record-motion'),
            recordRaw: s.get_boolean('record-raw'),
        };
    }
}

/** True when the endpoint talks to this machine, i.e. screenshots stay local. */
export function isLoopbackEndpoint(url: string): boolean {
    try {
        const match = /^https?:\/\/([^/:]+)/i.exec(url.trim());
        if (!match) {
            return false;
        }
        const host = match[1].toLowerCase();
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    } catch {
        return false;
    }
}
