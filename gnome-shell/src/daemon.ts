// Async client for the clickmate daemon. Everything here runs on the compositor
// thread, so every call is asynchronous: a synchronous socket read would freeze
// the whole desktop for as long as the daemon takes to answer.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type { RawEvent } from './model.js';
import { reportProblem } from './problems.js';

export const DEFAULT_CONTROL_SOCKET = '/var/run/click-socket';
export const DEFAULT_EVENT_SOCKET = '/var/run/clickmate-events';

let promisified = false;

function ensurePromisified(): void {
    if (promisified) {
        return;
    }
    promisified = true;
    const gio = Gio as unknown as {
        _promisify: (proto: object, method: string, finish?: string) => void;
    };
    const pairs: [object, string, string][] = [
        [Gio.SocketClient.prototype, 'connect_async', 'connect_finish'],
        [Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish'],
        [Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish'],
        [Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish'],
    ];
    for (const [proto, method, finish] of pairs) {
        try {
            gio._promisify(proto, method, finish);
        } catch {
            // Already promisified by the shell or another extension.
        }
    }
}

export interface DaemonDevice {
    index: number;
    name: string;
    path: string;
    grabbed: boolean;
    keyboard: boolean;
    pointer: boolean;
}

export interface DaemonStatus {
    version: number;
    recording: boolean;
    playing: boolean;
    devices: DaemonDevice[];
}

export interface PlayResult {
    aborted: boolean;
}

export class DaemonError extends Error {}

interface AsyncSocketClient {
    connect_async(address: Gio.SocketAddress, cancellable: Gio.Cancellable | null): Promise<Gio.SocketConnection>;
}

interface AsyncOutputStream {
    write_all_async(
        buffer: Uint8Array, priority: number, cancellable: Gio.Cancellable | null,
    ): Promise<[boolean, number]>;
}

interface AsyncInputStream {
    read_bytes_async(count: number, priority: number, cancellable: Gio.Cancellable | null): Promise<GLib.Bytes>;
}

interface AsyncDataInputStream {
    read_line_async(priority: number, cancellable: Gio.Cancellable | null): Promise<[Uint8Array | null, number]>;
}

export class DaemonClient {
    private _controlPath: string;
    private _eventPath: string;

    constructor(controlPath = DEFAULT_CONTROL_SOCKET, eventPath = DEFAULT_EVENT_SOCKET) {
        ensurePromisified();
        this._controlPath = controlPath;
        this._eventPath = eventPath;
    }

    get controlPath(): string {
        return this._controlPath;
    }

    get eventPath(): string {
        return this._eventPath;
    }

    setPaths(controlPath: string, eventPath: string): void {
        this._controlPath = controlPath || DEFAULT_CONTROL_SOCKET;
        this._eventPath = eventPath || DEFAULT_EVENT_SOCKET;
    }

    private async _request(method: string, path: string, body: object | null, timeoutMs: number): Promise<any> {
        const cancellable = new Gio.Cancellable();
        let timeoutId = 0;
        if (timeoutMs > 0) {
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timeoutId = 0;
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
        }

        try {
            const client = new Gio.SocketClient() as Gio.SocketClient & AsyncSocketClient;
            const address = new Gio.UnixSocketAddress({ path: this._controlPath });
            const connection = await client.connect_async(address, cancellable);

            const encoder = new TextEncoder();
            const payload = body ? encoder.encode(JSON.stringify(body)) : new Uint8Array(0);
            const head = [
                `${method} ${path} HTTP/1.1`,
                'Host: localhost',
                'Connection: close',
                'Content-Type: application/json',
                `Content-Length: ${payload.length}`,
                '',
                '',
            ].join('\r\n');

            const request = new Uint8Array(encoder.encode(head).length + payload.length);
            const headBytes = encoder.encode(head);
            request.set(headBytes, 0);
            request.set(payload, headBytes.length);

            const output = connection.get_output_stream() as Gio.OutputStream & AsyncOutputStream;
            await output.write_all_async(request, GLib.PRIORITY_DEFAULT, cancellable);

            const input = connection.get_input_stream() as Gio.InputStream & AsyncInputStream;
            const chunks: Uint8Array[] = [];
            let total = 0;
            for (;;) {
                const bytes = await input.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, cancellable);
                const data = bytes.get_data();
                if (!data || data.length === 0) {
                    break;
                }
                chunks.push(data);
                total += data.length;
                if (total > 4 * 1024 * 1024) {
                    throw new DaemonError('response too large');
                }
            }
            connection.close(null);

            const merged = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.length;
            }

            const text = new TextDecoder().decode(merged);
            const separator = text.indexOf('\r\n\r\n');
            const bodyText = separator >= 0 ? text.slice(separator + 4) : text;
            if (bodyText.trim() === '') {
                return {};
            }
            return JSON.parse(bodyText);
        } catch (error) {
            if (error instanceof Gio.IOErrorEnum || (error as GLib.Error)?.code !== undefined) {
                throw new DaemonError(`${method} ${path}: ${(error as Error).message}`);
            }
            throw error;
        } finally {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
            }
        }
    }

    async status(timeoutMs = 3000): Promise<DaemonStatus> {
        const json = await this._request('GET', '/status', null, timeoutMs);
        return {
            version: json.version ?? 0,
            recording: !!json.recording,
            playing: !!json.playing,
            devices: Array.isArray(json.devices) ? json.devices : [],
        };
    }

    /**
     * Play an event train. The daemon answers only once the train has finished,
     * so the returned promise resolves when the input has actually been sent.
     */
    async play(events: RawEvent[]): Promise<PlayResult> {
        if (events.length === 0) {
            return { aborted: false };
        }
        const durationMs = events.reduce((sum, e) => sum + Math.max(0, e.dt), 0) / 1000;
        const timeoutMs = Math.max(10000, durationMs + 10000);
        const json = await this._request('POST', '/play', { events }, timeoutMs);
        if (json.error) {
            throw new DaemonError(json.error);
        }
        return { aborted: !!json.aborted };
    }

    async stop(): Promise<void> {
        await this._request('POST', '/stop', {}, 3000);
    }

    async setRecording(on: boolean): Promise<void> {
        await this._request('POST', '/record', { on }, 3000);
    }

}

export interface StreamedEvent {
    seq: number;
    /** Device timestamp in microseconds. */
    t: number;
    dev: number;
    type: number;
    code: number;
    value: number;
}

/**
 * Reads the daemon's newline-delimited event stream. Used while recording; the
 * daemon only writes to it when recording is enabled.
 */
export class EventStream {
    private _path: string;
    private _cancellable: Gio.Cancellable | null = null;
    private _connection: Gio.SocketConnection | null = null;
    private _reader: (Gio.DataInputStream & AsyncDataInputStream) | null = null;

    constructor(path = DEFAULT_EVENT_SOCKET) {
        ensurePromisified();
        this._path = path;
    }

    get active(): boolean {
        return this._connection !== null;
    }

    async open(
        onEvent: (event: StreamedEvent) => void,
        onClosed?: (error: Error | null) => void,
    ): Promise<void> {
        this.close();

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const client = new Gio.SocketClient() as Gio.SocketClient & AsyncSocketClient;
        const address = new Gio.UnixSocketAddress({ path: this._path });
        const connection = await client.connect_async(address, cancellable);
        this._connection = connection;

        const reader = new Gio.DataInputStream({
            base_stream: connection.get_input_stream(),
        }) as Gio.DataInputStream & AsyncDataInputStream;
        this._reader = reader;

        // Deliberately not awaited: the read loop runs until close() is called.
        void this._readLoop(reader, cancellable, onEvent, onClosed);
    }

    private async _readLoop(
        reader: Gio.DataInputStream & AsyncDataInputStream,
        cancellable: Gio.Cancellable,
        onEvent: (event: StreamedEvent) => void,
        onClosed?: (error: Error | null) => void,
    ): Promise<void> {
        const decoder = new TextDecoder();
        try {
            for (;;) {
                const [line] = await reader.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                if (line === null) {
                    break; // daemon closed the connection
                }
                const text = decoder.decode(line).trim();
                if (text === '') {
                    continue;
                }
                try {
                    onEvent(JSON.parse(text) as StreamedEvent);
                } catch {
                    // Collapses by message, so a stream that has gone out of sync
                    // reports once with a count rather than once per event.
                    reportProblem('Daemon', 'the event stream sent something unreadable', {
                        hint: `Recording will be missing events. First bad line: ${text.slice(0, 80)}`,
                    });
                }
            }
            onClosed?.(null);
        } catch (error) {
            if (!cancellable.is_cancelled()) {
                onClosed?.(error as Error);
            }
        }
    }

    close(): void {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._reader = null;
        try {
            this._connection?.close(null);
        } catch {
            // Already gone.
        }
        this._connection = null;
    }
}
