// Condition evaluation. Cheap checks (pixel colour) never touch the network;
// only the `llm` type sends a screenshot to the configured endpoint.

import GLib from 'gi://GLib';

import type { Condition, LlmCondition, PixelCondition, RegionColorCondition } from './model.js';
import { describeCondition } from './model.js';
import { LlmClient, LlmError, type LlmSettings } from './llm.js';
import type { Config } from './store.js';
import {
    captureRegion,
    captureScreen,
    colorCoverage,
    colorDistance,
    encodeForLlm,
    formatColor,
    parseColor,
    readPixel,
} from './screenshot.js';

export interface EvaluationTrace {
    condition: string;
    result: boolean;
    detail: string;
    latencyMs: number;
}

export class ConditionAborted extends Error {}

interface CacheEntry {
    result: boolean;
    detail: string;
    expiresAt: number;
}

export class ConditionEvaluator {
    private _llm = new LlmClient();
    private _cache = new Map<string, CacheEntry>();
    private _config: Config;
    private _onTrace?: (trace: EvaluationTrace) => void;

    constructor(config: Config, onTrace?: (trace: EvaluationTrace) => void) {
        this._config = config;
        this._onTrace = onTrace;
    }

    setConfig(config: Config): void {
        this._config = config;
    }

    destroy(): void {
        this._llm.destroy();
        this._cache.clear();
    }

    clearCache(): void {
        this._cache.clear();
    }

    /** Evaluate a condition tree. Throws ConditionAborted for onError:'abort'. */
    async evaluate(condition: Condition | null | undefined): Promise<boolean> {
        if (!condition) {
            return true;
        }

        const started = GLib.get_monotonic_time();
        const { result, detail } = await this._evaluateInner(condition);
        const latencyMs = Math.round((GLib.get_monotonic_time() - started) / 1000);

        this._onTrace?.({
            condition: describeCondition(condition),
            result,
            detail,
            latencyMs,
        });
        return result;
    }

    private async _evaluateInner(condition: Condition): Promise<{ result: boolean; detail: string }> {
        switch (condition.type) {
            case 'always':
                return { result: true, detail: '' };

            case 'not': {
                const inner = await this._evaluateInner(condition.of);
                return { result: !inner.result, detail: inner.detail };
            }

            case 'and': {
                if (condition.of.length === 0) {
                    return { result: true, detail: 'no sub-conditions' };
                }
                for (const child of condition.of) {
                    const inner = await this._evaluateInner(child);
                    if (!inner.result) {
                        return { result: false, detail: inner.detail };
                    }
                }
                return { result: true, detail: '' };
            }

            case 'or': {
                if (condition.of.length === 0) {
                    return { result: false, detail: 'no sub-conditions' };
                }
                let lastDetail = '';
                for (const child of condition.of) {
                    const inner = await this._evaluateInner(child);
                    if (inner.result) {
                        return { result: true, detail: inner.detail };
                    }
                    lastDetail = inner.detail;
                }
                return { result: false, detail: lastDetail };
            }

            case 'pixel':
                return this._evaluatePixel(condition);

            case 'regionColor':
                return this._evaluateRegionColor(condition);

            case 'llm':
                return this._evaluateLlm(condition);
        }
    }

    private async _evaluatePixel(condition: PixelCondition): Promise<{ result: boolean; detail: string }> {
        const pixbuf = await captureRegion(condition.x, condition.y, 1, 1);
        const actual = readPixel(pixbuf, 0, 0);
        const target = parseColor(condition.color);
        const distance = colorDistance(actual, target);
        return {
            result: distance <= condition.tolerance,
            detail: `found ${formatColor(actual)}, distance ${distance.toFixed(1)} vs tolerance ${condition.tolerance}`,
        };
    }

    private async _evaluateRegionColor(
        condition: RegionColorCondition,
    ): Promise<{ result: boolean; detail: string }> {
        const pixbuf = await captureRegion(condition.x, condition.y, condition.w, condition.h);
        const target = parseColor(condition.color);
        const coverage = colorCoverage(pixbuf, target, condition.tolerance);
        return {
            result: coverage >= condition.coverage,
            detail: `${(coverage * 100).toFixed(1)}% matched, need ${(condition.coverage * 100).toFixed(0)}%`,
        };
    }

    private _cacheKey(condition: LlmCondition): string {
        const region = condition.region
            ? `${condition.region.x},${condition.region.y},${condition.region.w},${condition.region.h}`
            : 'screen';
        return `${condition.model ?? ''}|${region}|${condition.prompt}`;
    }

    private async _evaluateLlm(condition: LlmCondition): Promise<{ result: boolean; detail: string }> {
        const cacheMs = condition.cacheMs ?? 0;
        const key = this._cacheKey(condition);
        const now = GLib.get_monotonic_time() / 1000;

        if (cacheMs > 0) {
            const cached = this._cache.get(key);
            if (cached && cached.expiresAt > now) {
                return { result: cached.result, detail: `${cached.detail} (cached)` };
            }
        }

        const settings: LlmSettings = {
            endpoint: this._config.llmEndpoint,
            model: condition.model || this._config.llmModel,
            apiKey: this._config.llmApiKey,
            timeoutMs: condition.timeoutMs ?? this._config.llmTimeoutMs,
        };

        try {
            const pixbuf = condition.region
                ? await captureRegion(condition.region.x, condition.region.y, condition.region.w, condition.region.h)
                : await captureScreen();
            const image = encodeForLlm(pixbuf, this._config.llmMaxWidth, this._config.llmJpegQuality);
            const verdict = await this._llm.ask(condition.prompt, image, settings);

            const expect = condition.expect !== false;
            const result = verdict.match === expect;
            const detail = `model said ${verdict.match ? 'yes' : 'no'}${verdict.reason ? ` — ${verdict.reason}` : ''} (${verdict.latencyMs}ms)`;

            if (cacheMs > 0) {
                this._cache.set(key, { result, detail, expiresAt: now + cacheMs });
            }
            return { result, detail };
        } catch (error) {
            const message = error instanceof LlmError ? error.message : (error as Error).message;
            const policy = condition.onError ?? 'false';
            if (policy === 'abort') {
                throw new ConditionAborted(`LLM check failed: ${message}`);
            }
            log(`clickmate: LLM check failed (${message}); treating as ${policy}`);
            return { result: policy === 'true', detail: `error: ${message}` };
        }
    }
}
