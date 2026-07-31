// Vision questions against a local, OpenAI-compatible chat completions endpoint
// (llama.cpp-server, LM Studio, vLLM, or Ollama's /v1 shim).
//
// Every call is asynchronous. A local vision model can take many seconds to
// answer and the compositor thread must never wait on it.

import GdkPixbuf from 'gi://GdkPixbuf';
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
    latencyMs: number;
}

export class LlmError extends Error {}

/**
 * Deliberately blunt and repetitive. Small local vision models drift away from
 * a loose format immediately: they answer in prose, wrap JSON in a code fence,
 * or put the string "yes" where a boolean belongs. Spelling out the exact shape
 * — and what not to do — is worth more here than brevity.
 */
function buildInstruction(question: string): string {
    return [
        'You are a strict visual classifier. Look at the screenshot and decide whether',
        'the following statement is TRUE or FALSE for what you see.',
        '',
        `STATEMENT: ${question}`,
        '',
        'Reply with exactly one JSON object and nothing else.',
        'No prose. No explanation before or after. No markdown. No ``` code fence.',
        '',
        'The object must have exactly these two keys:',
        '  "match"  - the JSON boolean true or false. Not "true", not "yes", not 1.',
        '  "reason" - a string, at most 10 words.',
        '',
        'Valid replies look exactly like this:',
        '{"match": true, "reason": "the left button is green"}',
        '{"match": false, "reason": "the button is grey"}',
        '',
        'Use true only when the statement is clearly true in the screenshot.',
        'If you are unsure, or cannot see the thing being asked about, use false.',
    ].join('\n');
}

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

/** Keys small models reach for when they ignore the one we asked for. */
const VERDICT_KEYS = ['match', 'answer', 'result', 'value', 'verdict', 'is_true', 'true'];

function toBool(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (['true', 'yes', 'y', '1'].includes(text)) {
            return true;
        }
        if (['false', 'no', 'n', '0'].includes(text)) {
            return false;
        }
    }
    return null;
}

/**
 * Read the model's answer. Even with JSON mode on, small models produce fenced
 * blocks, stringly-typed booleans, alternate key names and trailing chatter, so
 * this accepts all of those before falling back to a plain YES/NO.
 */
export function parseVerdict(text: string): { match: boolean; reason: string } | null {
    const trimmed = (text ?? '').trim();
    if (trimmed === '') {
        return null;
    }

    // Non-greedy from the first brace: models sometimes emit a second object
    // after the first, and JSON.parse would choke on the pair.
    for (const candidate of trimmed.match(/\{[\s\S]*?\}/g) ?? []) {
        try {
            const parsed = JSON.parse(candidate) as Record<string, unknown>;
            const reason = String(parsed.reason ?? parsed.explanation ?? '');
            for (const key of VERDICT_KEYS) {
                if (key in parsed) {
                    const value = toBool(parsed[key]);
                    if (value !== null) {
                        return { match: value, reason };
                    }
                }
            }
        } catch {
            // Try the next object, then fall through to the plain-text reading.
        }
    }

    const word = /\b(yes|no|true|false)\b/i.exec(trimmed);
    if (word) {
        const value = word[1].toLowerCase();
        return { match: value === 'yes' || value === 'true', reason: trimmed.slice(0, 120) };
    }

    return null;
}

// --- connection test -------------------------------------------------------

export interface ConnectionTest {
    /** The endpoint answered with something we could read a verdict out of. */
    ok: boolean;
    /** ...and it got a question about the picture right, so it can see images. */
    sawImage: boolean;
    latencyMs: number;
    /** The model's own words on success, the failure reason otherwise. */
    message: string;
}

/**
 * The picture the test sends: a plain red square, generated rather than stored
 * so there is no blob to keep in the source. Small enough to be instant, large
 * enough that servers which reject one-pixel images still take it.
 */
function testImage(): EncodedImage {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 64, 64);
    if (!pixbuf) {
        throw new LlmError('could not build the test picture');
    }
    pixbuf.fill(0xff0000ff);   // RGBA, opaque red
    const [ok, data] = pixbuf.save_to_bufferv('png', [], []);
    if (!ok || !data) {
        throw new LlmError('could not encode the test picture');
    }
    return {
        dataUri: `data:image/png;base64,${GLib.base64_encode(data)}`,
        mimeType: 'image/png',
        byteLength: data.length,
        width: 64,
        height: 64,
    };
}

/**
 * Ask the configured endpoint one question it cannot get wrong. This exercises
 * the whole path a condition uses — URL, key, model name, image upload, verdict
 * parsing — so a green result means conditions will work, not merely that
 * something is listening on the port.
 */
export async function testConnection(settings: LlmSettings): Promise<ConnectionTest> {
    const client = new LlmClient();
    try {
        const verdict = await client.ask(
            'the picture is plain red, with nothing else in it', testImage(), settings);
        return { ok: true, sawImage: verdict.match, latencyMs: verdict.latencyMs, message: verdict.reason };
    } catch (error) {
        return { ok: false, sawImage: false, latencyMs: 0, message: (error as Error).message };
    } finally {
        client.destroy();
    }
}

export class LlmClient {
    private _session: Soup.Session;
    private _jsonMode = true;

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

        const body: Record<string, unknown> = {
            model: settings.model,
            temperature: 0,
            max_tokens: 96,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: buildInstruction(prompt) },
                        { type: 'image_url', image_url: { url: image.dataUri } },
                    ],
                },
            ],
        };

        // Constrained decoding, where the server supports it, is far more
        // reliable than asking nicely. Servers that do not understand the field
        // reject the request, so we remember that and stop sending it.
        if (this._jsonMode) {
            body.response_format = { type: 'json_object' };
        }

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
                if (this._jsonMode && status === 400) {
                    log('clickmate: endpoint rejected response_format, retrying without JSON mode');
                    this._jsonMode = false;
                    return this.ask(prompt, image, settings);
                }
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

            return { match: parsed.match, reason: parsed.reason, latencyMs };
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
