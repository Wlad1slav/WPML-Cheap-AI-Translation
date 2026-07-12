import fs from "node:fs/promises";
import path from "node:path";
import { ModelPricing, UsageTotals } from "./usage-cost.js";

type TranslationCost = {
  inputCost: number;
  cachedInputCost: number;
  outputCost: number;
  totalCost: number;
};

type TranslationLogEntry = {
  completedAt: string;
  input: string;
  output: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  units: number;
  uniqueTranslatedSegments: number;
  durationMs: number;
  usage: UsageTotals;
  pricingUsdPer1M: ModelPricing | null;
  estimatedCostUsd: TranslationCost | null;
};

export const TRANSLATION_LOG_PATH = path.resolve("logs", "translation-history.jsonl");

export async function appendTranslationLog(entry: TranslationLogEntry): Promise<void> {
  await fs.mkdir(path.dirname(TRANSLATION_LOG_PATH), { recursive: true });
  await fs.appendFile(TRANSLATION_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}
