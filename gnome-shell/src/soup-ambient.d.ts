// Minimal typings for the bits of libsoup 3 we use. The @girs packages pinned
// here do not ship Soup declarations, and the shell process can import the
// typelib regardless.

declare module 'gi://Soup?version=3.0' {
    import type Gio from 'gi://Gio';
    import type GLib from 'gi://GLib';

    namespace Soup {
        class MessageHeaders {
            append(name: string, value: string): void;
        }

        class Message {
            static new(method: string, uriString: string): Message | null;
            request_headers: MessageHeaders;
            response_headers: MessageHeaders;
            set_request_body_from_bytes(contentType: string | null, bytes: GLib.Bytes | null): void;
            get_status(): number;
            get_reason_phrase(): string | null;
        }

        class Session {
            constructor(props?: Record<string, unknown>);
            timeout: number;
            abort(): void;
            send_and_read_async(
                msg: Message,
                ioPriority: number,
                cancellable: Gio.Cancellable | null,
                callback: ((source: Session | null, result: Gio.AsyncResult) => void) | null,
            ): void;
            send_and_read_finish(result: Gio.AsyncResult): GLib.Bytes;
        }

        enum Status {
            OK = 200,
        }
    }

    export default Soup;
}
