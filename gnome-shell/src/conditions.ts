// Condition evaluation. Cheap checks (pixel colour) never touch the network;
// only the `llm` type sends a screenshot to the configured endpoint.

import GLib from 'gi://GLib';

import type { ColorCondition, Condition, LlmCondition } from './model.js';
import { describeCondition } from './model.js';
import { LlmClient, LlmError, type LlmSettings } from './llm.js';
import { reportProblem } from './problems.js';
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

export class ConditionEvaluator {
    private _llm = new LlmClient();
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
    }

    /** Evaluate a condition tree. Throws when a check cannot be answered. */
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

            case 'color':
                return this._evaluateColor(condition);

            case 'llm':
                return this._evaluateLlm(condition);
        }
    }

    /**
     * One capture covers both cases: a 1×1 area is the single-pixel check, and
     * reporting the colour actually found is far more useful there than a
     * coverage percentage.
     */
    private async _evaluateColor(condition: ColorCondition): Promise<{ result: boolean; detail: string }> {
        const w = Math.max(1, condition.w);
        const h = Math.max(1, condition.h);
        const pixbuf = await captureRegion(condition.x, condition.y, w, h);
        const target = parseColor(condition.color);

        if (w * h === 1) {
            const actual = readPixel(pixbuf, 0, 0);
            const distance = colorDistance(actual, target);
            return {
                result: distance <= condition.tolerance,
                detail: `found ${formatColor(actual)}, distance ${distance.toFixed(1)} vs tolerance ${condition.tolerance}`,
            };
        }

        const coverage = colorCoverage(pixbuf, target, condition.tolerance);
        return {
            result: coverage >= condition.coverage,
            detail: `${(coverage * 100).toFixed(1)}% matched, need ${(condition.coverage * 100).toFixed(0)}%`,
        };
    }

    private async _evaluateLlm(condition: LlmCondition): Promise<{ result: boolean; detail: string }> {
        // Endpoint, model and timeout are global settings: a per-condition copy
        // of each was more knobs than anyone wants on every prompt.
        const settings: LlmSettings = {
            endpoint: this._config.llmEndpoint,
            model: this._config.llmModel,
            apiKey: this._config.llmApiKey,
            timeoutMs: this._config.llmTimeoutMs,
        };

        try {
            const pixbuf = condition.region
                ? await captureRegion(condition.region.x, condition.region.y, condition.region.w, condition.region.h)
                : await captureScreen();
            const image = encodeForLlm(pixbuf, this._config.llmMaxWidth);
            const verdict = await this._llm.ask(condition.prompt, image, settings);

            const detail = `model said ${verdict.match ? 'yes' : 'no'}${verdict.reason ? ` — ${verdict.reason}` : ''} (${verdict.latencyMs}ms)`;
            return { result: verdict.match, detail };
        } catch (error) {
            const message = error instanceof LlmError ? error.message : (error as Error).message;
            // A failed check has no answer, and guessing one either way sends the
            // macro down a branch on no evidence. Say so and stop.
            reportProblem('Model', message, {
                where: describeCondition(condition),
                hint: `Clickmate asked ${settings.endpoint || '(no endpoint set)'} — start that server, ` +
                    'point Settings → Model somewhere else, or replace the check with a colour test.',
            });
            throw new Error(`the model could not answer: ${message}`);
        }
    }
}
