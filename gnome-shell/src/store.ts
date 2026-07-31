// GSettings-backed document store. Both the shell process and the preferences
// process instantiate one of these against the same schema, so an edit made in
// prefs shows up in the popup (and vice versa) without any extra plumbing.

import Gio from 'gi://Gio';

import {
    Macro,
    MacroDocument,
    macroEnabled,
    parseDocument,
    stringifyDocument,
} from './model.js';
import { reportProblem } from './problems.js';

export interface Config {
    llmEndpoint: string;
    llmModel: string;
    llmApiKey: string;
    llmTimeoutMs: number;
    llmMaxWidth: number;
    controlSocket: string;
    eventSocket: string;
    /** 0 means: do not turn idle gaps into wait steps. */
    recordGapMs: number;
}

export class MacroStore {
    private _settings: Gio.Settings;
    private _doc: MacroDocument;
    private _changedId: number;
    private _writing = false;
    private _listeners = new Set<(external: boolean) => void>();

    constructor(settings: Gio.Settings) {
        this._settings = settings;
        this._doc = parseDocument(settings.get_string('macros'));
        this._migrateEnabled();

        this._changedId = settings.connect('changed::macros', () => {
            if (this._writing) {
                return; // our own write echoing back
            }
            // Written by the other process: every step object we handed out is
            // now stale, so listeners have to rebuild rather than refresh.
            this._doc = parseDocument(this._settings.get_string('macros'));
            this._notify(true);
        });
    }

    /**
     * Documents written before macros could be switched on and off carry no flag
     * at all. Run used to start exactly one macro — the selected one — so that is
     * the one left on: turning them all on would set every macro anyone ever
     * recorded loose on the pointer at the first press. Runs once; after this the
     * flags are on disk, and the other process finds them already there.
     */
    private _migrateEnabled(): void {
        const macros = this._doc.macros;
        // One macro needs no choosing, and on is what absent already means.
        if (macros.length < 2 || macros.some(macro => typeof macro.enabled === 'boolean')) {
            return;
        }
        const active = this._settings.get_string('active-macro-id');
        const chosen = macros.find(macro => macro.id === active) ?? macros[0];
        for (const macro of macros) {
            macro.enabled = macro === chosen;
        }
        this.save();
    }

    destroy(): void {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._listeners.clear();
    }

    get document(): MacroDocument {
        return this._doc;
    }

    get macros(): Macro[] {
        return this._doc.macros;
    }

    /** The macros Run starts, in document order. */
    get enabledMacros(): Macro[] {
        return this._doc.macros.filter(macroEnabled);
    }

    /**
     * Called whenever the document changes. `external` is true when the other
     * process wrote it, which means the in-memory objects were replaced.
     */
    onChanged(listener: (external: boolean) => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    private _notify(external: boolean): void {
        for (const listener of [...this._listeners]) {
            try {
                listener(external);
            } catch (error) {
                reportProblem('Settings', `a change listener failed: ${(error as Error).message}`, {
                    error: error as Error,
                });
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
        this._notify(false);
    }

    replaceDocument(doc: MacroDocument): void {
        this._doc = doc;
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

    /**
     * The macro being worked on — the one holding the selected row, which is
     * where a recording lands. Not the one that runs: Run starts every enabled
     * macro. Falls back to the first one.
     */
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

    get config(): Config {
        const s = this._settings;
        return {
            llmEndpoint: s.get_string('llm-endpoint'),
            llmModel: s.get_string('llm-model'),
            llmApiKey: s.get_string('llm-api-key'),
            llmTimeoutMs: s.get_int('llm-timeout-ms'),
            llmMaxWidth: s.get_int('llm-max-width'),
            controlSocket: s.get_string('control-socket'),
            eventSocket: s.get_string('event-socket'),
            recordGapMs: s.get_int('record-gap-ms'),
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
