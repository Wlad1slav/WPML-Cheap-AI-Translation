import { CliOptions } from "./types.js";

export type ModelPricing = {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
};

export type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type CostBreakdown = {
  inputCost: number;
  cachedInputCost: number;
  outputCost: number;
  totalCost: number;
};

// Pricing source: https://platform.openai.com/pricing (checked 2026-03-26).
export const MODEL_PRICING_USD_PER_1M: Record<string, ModelPricing> = {
  "gpt-4.1": { inputPer1M: 2.0, cachedInputPer1M: 0.5, outputPer1M: 8.0 },
  "gpt-4.1-mini": { inputPer1M: 0.4, cachedInputPer1M: 0.1, outputPer1M: 1.6 },
  "gpt-4.1-nano": { inputPer1M: 0.1, cachedInputPer1M: 0.025, outputPer1M: 0.4 },
  "gpt-4o": { inputPer1M: 2.5, cachedInputPer1M: 1.25, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.6 },
  "gpt-5": { inputPer1M: 1.25, cachedInputPer1M: 0.125, outputPer1M: 10.0 },
  "gpt-5-mini": { inputPer1M: 0.25, cachedInputPer1M: 0.025, outputPer1M: 2.0 },
  "gpt-5-nano": { inputPer1M: 0.05, cachedInputPer1M: 0.005, outputPer1M: 0.4 },
};

export function resolveModelPricing(model: string): ModelPricing | null {
  if (MODEL_PRICING_USD_PER_1M[model]) {
    return MODEL_PRICING_USD_PER_1M[model];
  }

  const entries = Object.entries(MODEL_PRICING_USD_PER_1M).sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [key, price] of entries) {
    if (model.startsWith(`${key}-`)) {
      return price;
    }
  }

  return null;
}

export function zeroUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

export function addUsage(target: UsageTotals, delta: UsageTotals): void {
  target.inputTokens += delta.inputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningTokens += delta.reasoningTokens;
  target.totalTokens += delta.totalTokens;
}

export function extractUsageTotals(rawUsage: unknown): UsageTotals {
  const usage = rawUsage as {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };

  return {
    inputTokens: usage?.input_tokens ?? 0,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

export function resolveEffectivePricing(options: CliOptions): ModelPricing | null {
  const preset = resolveModelPricing(options.model);
  const inputPer1M = options.priceInputPer1M ?? preset?.inputPer1M;
  const outputPer1M = options.priceOutputPer1M ?? preset?.outputPer1M;

  if (inputPer1M === undefined || outputPer1M === undefined) {
    return null;
  }

  const cachedInputPer1M =
    options.priceCachedInputPer1M ?? preset?.cachedInputPer1M ?? inputPer1M;

  return { inputPer1M, cachedInputPer1M, outputPer1M };
}

export function calculateCost(usage: UsageTotals, pricing: ModelPricing): CostBreakdown {
  const safeCached = Math.max(0, Math.min(usage.cachedInputTokens, usage.inputTokens));
  const nonCachedInput = Math.max(0, usage.inputTokens - safeCached);

  const inputCost = (nonCachedInput / 1_000_000) * pricing.inputPer1M;
  const cachedInputCost = (safeCached / 1_000_000) * pricing.cachedInputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  const totalCost = inputCost + cachedInputCost + outputCost;

  return { inputCost, cachedInputCost, outputCost, totalCost };
}

export function formatUsd(value: number): string {
  const digits = value >= 0.01 ? 4 : 6;
  return `$${value.toFixed(digits)}`;
}
