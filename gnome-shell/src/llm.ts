// Vision questions against a local, OpenAI-compatible chat completions endpoint
// (llama.cpp-server, LM Studio, vLLM, or Ollama's /v1 shim).
//
// Every call is asynchronous. A local vision model can take many seconds to
// answer and the compositor thread must never wait on it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import type { EncodedImage } from './screenshot.js';

export interface LlmSettings {
    endpoint: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
}

export interface Verdict {
    /** The answer to the question, after `expect` has been applied by the caller. */
    match: boolean;
    reason: string;
    /** Raw model output, for showing in the UI when a prompt misbehaves. */
    raw: string;
    latencyMs: number;
}

export class LlmError extends Error {}

const INSTRUCTION =
    'Look at the screenshot and answer the question about it.\n' +
    'Reply with a single JSON object and nothing else:\n' +
    '{"match": true or false, "reason": "<at most 12 words>"}\n' +
    'Set "match" to true only when the question is clearly satisfied by the screenshot.';

let promisified = false;

function ensurePromisified(): void {
    if (promisified) {
        return;
    }
    promisified = true;
    const gio = Gio as unknown as {
        _promisify: (proto: object, method: string, finish?: string) => void;
    };
    try {
        gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
    } catch {
        // Already promisified.
    }
}

interface AsyncSoupSession {
    send_and_read_async(
        message: Soup.Message, priority: number, cancellable: Gio.Cancellable | null,
    ): Promise<GLib.Bytes>;
}

/**
 * Parse the model's answer. Models drift from the requested format constantly,
 * so accept a bare JSON object, a fenced one, or a plain YES/NO.
 */
export function parseVerdict(text: string): { match: boolean; reason: string } | null {
    const trimmed = (text ?? '').trim();
    if (trimmed === '') {
        return null;
    }

    const jsonMatch = /\{[\s\S]*\}/.exec(trimmed);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]) as { match?: unknown; reason?: unknown };
            if (typeof parsed.match === 'boolean') {
                return { match: parsed.match, reason: String(parsed.reason ?? '') };
            }
            if (typeof parsed.match === 'string') {
                const value = parsed.match.trim().toLowerCase();
                if (value === 'true' || value === 'yes') {
                    return { match: true, reason: String(parsed.reason ?? '') };
                }
                if (value === 'false' || value === 'no') {
                    return { match: false, reason: String(parsed.reason ?? '') };
                }
            }
        } catch {
            // Fall through to the plain-text reading.
        }
    }

    const word = /\b(yes|no|true|false)\b/i.exec(trimmed);
    if (word) {
        const value = word[1].toLowerCase();
        return { match: value === 'yes' || value === 'true', reason: trimmed.slice(0, 120) };
    }

    return null;
}

export class LlmClient {
    private _session: Soup.Session;

    constructor() {
        ensurePromisified();
        this._session = new Soup.Session();
    }

    destroy(): void {
        this._session.abort();
    }

    async ask(prompt: string, image: EncodedImage, settings: LlmSettings): Promise<Verdict> {
        if (!settings.endpoint) {
            throw new LlmError('no LLM endpoint configured');
        }

        const body = {
            model: settings.model,
            temperature: 0,
            max_tokens: 96,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: `${INSTRUCTION}\n\nQuestion: ${prompt}` },
                        { type: 'image_url', image_url: { url: image.dataUri } },
                    ],
                },
            ],
        };

        const message = Soup.Message.new('POST', settings.endpoint);
        if (!message) {
            throw new LlmError(`invalid endpoint URL: ${settings.endpoint}`);
        }
        if (settings.apiKey) {
            message.request_headers.append('Authorization', `Bearer ${settings.apiKey}`);
        }
        const payload = new TextEncoder().encode(JSON.stringify(body));
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(payload));

        const cancellable = new Gio.Cancellable();
        let timeoutId = 0;
        let timedOut = false;
        if (settings.timeoutMs > 0) {
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, settings.timeoutMs, () => {
                timeoutId = 0;
                timedOut = true;
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
        }

        const started = GLib.get_monotonic_time();
        try {
            const session = this._session as Soup.Session & AsyncSoupSession;
            const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
            const latencyMs = Math.round((GLib.get_monotonic_time() - started) / 1000);

            const status = message.get_status();
            const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array(0));

            if (status !== Soup.Status.OK) {
                throw new LlmError(`HTTP ${status}: ${text.slice(0, 200)}`);
            }

            let content = '';
            try {
                const json = JSON.parse(text) as {
                    choices?: { message?: { content?: unknown } }[];
                    error?: { message?: string };
                };
                if (json.error?.message) {
                    throw new LlmError(json.error.message);
                }
                const raw = json.choices?.[0]?.message?.content;
                if (typeof raw === 'string') {
                    content = raw;
                } else if (Array.isArray(raw)) {
                    // Some servers answer with the content-part array form.
                    content = raw
                        .map(part => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? ''))
                        .join(' ');
                }
            } catch (error) {
                if (error instanceof LlmError) {
                    throw error;
                }
                throw new LlmError(`could not parse the response: ${text.slice(0, 200)}`);
            }

            const parsed = parseVerdict(content);
            if (!parsed) {
                throw new LlmError(`could not read a yes/no answer from: ${content.slice(0, 200)}`);
            }

            return { match: parsed.match, reason: parsed.reason, raw: content, latencyMs };
        } catch (error) {
            if (timedOut) {
                throw new LlmError(`timed out after ${settings.timeoutMs}ms`);
            }
            if (error instanceof LlmError) {
                throw error;
            }
            throw new LlmError((error as Error).message ?? String(error));
        } finally {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
            }
        }
    }
}
