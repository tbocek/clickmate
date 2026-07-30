// Screen capture and pixel inspection. Runs inside the shell process, where
// Shell.Screenshot can grab the stage without a portal round trip.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';

export interface Rgb {
    r: number;
    g: number;
    b: number;
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
    for (const [method, finish] of [
        ['screenshot', 'screenshot_finish'],
        ['screenshot_area', 'screenshot_area_finish'],
    ]) {
        try {
            gio._promisify(Shell.Screenshot.prototype, method, finish);
        } catch {
            // Already promisified.
        }
    }
}

interface AsyncScreenshot {
    screenshot(includeCursor: boolean, stream: Gio.OutputStream): Promise<unknown>;
    screenshot_area(x: number, y: number, width: number, height: number, stream: Gio.OutputStream): Promise<unknown>;
}

function pixbufFromBytes(bytes: GLib.Bytes): GdkPixbuf.Pixbuf {
    const input = Gio.MemoryInputStream.new_from_bytes(bytes);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(input, null);
    input.close(null);
    if (!pixbuf) {
        throw new Error('could not decode the screenshot');
    }
    return pixbuf;
}

/** Full stage capture, across all monitors. */
export async function captureScreen(): Promise<GdkPixbuf.Pixbuf> {
    ensurePromisified();
    const shooter = new Shell.Screenshot() as Shell.Screenshot & AsyncScreenshot;
    const stream = Gio.MemoryOutputStream.new_resizable();
    await shooter.screenshot(false, stream);
    stream.close(null);
    return pixbufFromBytes(stream.steal_as_bytes());
}

export function stageSize(): [number, number] {
    return [global.stage.width, global.stage.height];
}

/** Capture a rectangle, clamped to the stage so a stale coordinate cannot throw. */
export async function captureRegion(
    x: number, y: number, width: number, height: number,
): Promise<GdkPixbuf.Pixbuf> {
    ensurePromisified();
    const [stageWidth, stageHeight] = stageSize();

    const cx = Math.max(0, Math.min(Math.round(x), stageWidth - 1));
    const cy = Math.max(0, Math.min(Math.round(y), stageHeight - 1));
    const cw = Math.max(1, Math.min(Math.round(width), stageWidth - cx));
    const ch = Math.max(1, Math.min(Math.round(height), stageHeight - cy));

    const shooter = new Shell.Screenshot() as Shell.Screenshot & AsyncScreenshot;
    const stream = Gio.MemoryOutputStream.new_resizable();
    await shooter.screenshot_area(cx, cy, cw, ch, stream);
    stream.close(null);
    return pixbufFromBytes(stream.steal_as_bytes());
}

// --- colour helpers --------------------------------------------------------

export function parseColor(value: string): Rgb {
    const text = (value || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(text)) {
        return {
            r: parseInt(text[0] + text[0], 16),
            g: parseInt(text[1] + text[1], 16),
            b: parseInt(text[2] + text[2], 16),
        };
    }
    if (/^[0-9a-f]{6}$/i.test(text)) {
        return {
            r: parseInt(text.slice(0, 2), 16),
            g: parseInt(text.slice(2, 4), 16),
            b: parseInt(text.slice(4, 6), 16),
        };
    }
    return { r: 0, g: 0, b: 0 };
}

export function formatColor(color: Rgb): string {
    const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

/** Euclidean RGB distance; good enough for "is this button green". */
export function colorDistance(a: Rgb, b: Rgb): number {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function readPixel(pixbuf: GdkPixbuf.Pixbuf, x = 0, y = 0): Rgb {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const px = Math.max(0, Math.min(x, pixbuf.get_width() - 1));
    const py = Math.max(0, Math.min(y, pixbuf.get_height() - 1));
    const offset = py * rowstride + px * channels;
    return { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2] };
}

/** Fraction of pixels within `tolerance` of `target`, 0..1. */
export function colorCoverage(pixbuf: GdkPixbuf.Pixbuf, target: Rgb, tolerance: number): number {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();

    let matched = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = y * rowstride + x * channels;
            const distance = colorDistance(
                { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2] },
                target,
            );
            if (distance <= tolerance) {
                matched++;
            }
        }
    }
    return matched / Math.max(1, width * height);
}

// --- encoding for the LLM --------------------------------------------------

export function scaleToWidth(pixbuf: GdkPixbuf.Pixbuf, maxWidth: number): GdkPixbuf.Pixbuf {
    const width = pixbuf.get_width();
    if (width <= maxWidth || maxWidth <= 0) {
        return pixbuf;
    }
    const height = Math.max(1, Math.round(pixbuf.get_height() * (maxWidth / width)));
    return pixbuf.scale_simple(maxWidth, height, GdkPixbuf.InterpType.BILINEAR) ?? pixbuf;
}

export interface EncodedImage {
    dataUri: string;
    mimeType: string;
    byteLength: number;
    width: number;
    height: number;
}

/** Encode as JPEG for the model, falling back to PNG when no JPEG saver exists. */
export function encodeForLlm(pixbuf: GdkPixbuf.Pixbuf, maxWidth: number, quality: number): EncodedImage {
    const scaled = scaleToWidth(pixbuf, maxWidth);

    let mimeType = 'image/jpeg';
    let buffer: Uint8Array | null = null;
    try {
        const [ok, data] = scaled.save_to_bufferv('jpeg', ['quality'], [String(quality)]);
        if (ok && data) {
            buffer = data;
        }
    } catch (error) {
        log(`clickmate: JPEG encoding unavailable (${(error as Error).message}), falling back to PNG`);
    }

    if (!buffer) {
        mimeType = 'image/png';
        const [ok, data] = scaled.save_to_bufferv('png', [], []);
        if (!ok || !data) {
            throw new Error('could not encode the screenshot');
        }
        buffer = data;
    }

    return {
        dataUri: `data:${mimeType};base64,${GLib.base64_encode(buffer)}`,
        mimeType,
        byteLength: buffer.length,
        width: scaled.get_width(),
        height: scaled.get_height(),
    };
}
