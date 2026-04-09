import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import OpenAI from "openai";

type CliOptions = {
  postsDir: string;
  outDir: string;
  file: string | null;
  targetLanguage: string | null;
  priceInputPer1M: number | null;
  priceCachedInputPer1M: number | null;
  priceOutputPer1M: number | null;
  model: string;
  concurrency: number;
  preservePageArticleHandle: boolean;
  overwrite: boolean;
};

type TransUnit = {
  start: number;
  end: number;
  block: string;
  sourceText: string;
  translatable: boolean;
  copySourceToTarget: boolean;
};

type FileContext = {
  postTypes: string[];
  isPageOrArticle: boolean;
};

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

type TranslationResponse = {
  text: string;
  usage: UsageTotals;
};

type TranslationBatchResult = {
  translations: Map<string, string>;
  usage: UsageTotals;
};

type ModelPricing = {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
};

type CostBreakdown = {
  inputCost: number;
  cachedInputCost: number;
  outputCost: number;
  totalCost: number;
};

// Pricing source: https://platform.openai.com/pricing (checked 2026-03-26).
const MODEL_PRICING_USD_PER_1M: Record<string, ModelPricing> = {
  "gpt-4.1": { inputPer1M: 2.0, cachedInputPer1M: 0.5, outputPer1M: 8.0 },
  "gpt-4.1-mini": { inputPer1M: 0.4, cachedInputPer1M: 0.1, outputPer1M: 1.6 },
  "gpt-4.1-nano": { inputPer1M: 0.1, cachedInputPer1M: 0.025, outputPer1M: 0.4 },
  "gpt-4o": { inputPer1M: 2.5, cachedInputPer1M: 1.25, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.6 },
  "gpt-5": { inputPer1M: 1.25, cachedInputPer1M: 0.125, outputPer1M: 10.0 },
  "gpt-5-mini": { inputPer1M: 0.25, cachedInputPer1M: 0.025, outputPer1M: 2.0 },
  "gpt-5-nano": { inputPer1M: 0.05, cachedInputPer1M: 0.005, outputPer1M: 0.4 },
};

const DEFAULT_MODEL = "gpt-4.1-nano";
const HANDLE_FIELD_REGEX = /\b(handle|slug|post[_-]?name|url[_-]?slug|permalink)\b/i;
const PAGE_OR_ARTICLE_POST_TYPES = new Set(["post_page", "post_post", "page", "article", "post_article"]);

function isLikelyModelId(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("gpt-") || normalized.startsWith("o1") || normalized.startsWith("o3");
}

function zeroUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(target: UsageTotals, delta: UsageTotals): void {
  target.inputTokens += delta.inputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningTokens += delta.reasoningTokens;
  target.totalTokens += delta.totalTokens;
}

function extractUsageTotals(rawUsage: unknown): UsageTotals {
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

function resolveModelPricing(model: string): ModelPricing | null {
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

function resolveEffectivePricing(options: CliOptions): ModelPricing | null {
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

function calculateCost(usage: UsageTotals, pricing: ModelPricing): CostBreakdown {
  const safeCached = Math.max(0, Math.min(usage.cachedInputTokens, usage.inputTokens));
  const nonCachedInput = Math.max(0, usage.inputTokens - safeCached);

  const inputCost = (nonCachedInput / 1_000_000) * pricing.inputPer1M;
  const cachedInputCost = (safeCached / 1_000_000) * pricing.cachedInputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  const totalCost = inputCost + cachedInputCost + outputCost;

  return { inputCost, cachedInputCost, outputCost, totalCost };
}

function formatUsd(value: number): string {
  const digits = value >= 0.01 ? 4 : 6;
  return `$${value.toFixed(digits)}`;
}

function printHelp(): void {
  console.log(`WPML XLIFF translator

Usage:
  npm run translate:wpml -- --file "Western Bid-translation-job-264.xliff"
  npm run translate:wpml -- "Western Bid-translation-job-264.xliff"
  npm run translate:wpml -- "Western Bid-translation-job-264.xliff" "de"
  npm run translate:wpml -- "Western Bid-translation-job-264.xliff" "gpt-5-nano"

Options:
  --file <name|path>      XLIFF file name from posts directory or explicit path
  --target-language <lc>  Target language override (example: en, de, fr)
  --to <lc>               Alias for --target-language
  --price-input <usd>     Input price per 1M tokens (USD)
  --price-cached <usd>    Cached input price per 1M tokens (USD)
  --price-output <usd>    Output price per 1M tokens (USD)
  --posts-dir <path>      Source directory with XLIFF files (default: posts)
  --out-dir <path>        Output directory for import-ready files (default: wpml-import)
  --model <model>         OpenAI model (default: gpt-4.1-nano)
  --concurrency <number>  Parallel translation requests (default: 3)
  --preserve-page-article-handle
                          Keep original handle/slug for page/article files (default)
  --translate-page-article-handle
                          Disable handle/slug preservation for page/article files
  --overwrite             Overwrite output file if it already exists
  --help                  Show this help
`);
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    postsDir: "posts",
    outDir: "wpml-import",
    file: null,
    targetLanguage: null,
    priceInputPer1M: null,
    priceCachedInputPer1M: null,
    priceOutputPer1M: null,
    model: DEFAULT_MODEL,
    concurrency: 3,
    preservePageArticleHandle: true,
    overwrite: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--overwrite") {
      options.overwrite = true;
      continue;
    }

    if (arg === "--preserve-page-article-handle") {
      options.preservePageArticleHandle = true;
      continue;
    }

    if (arg === "--translate-page-article-handle") {
      options.preservePageArticleHandle = false;
      continue;
    }

    const readValue = (flag: string): string => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      i += 1;
      return value;
    };

    const readNumber = (flag: string): number => {
      const value = Number(readValue(flag));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${flag} must be a non-negative number`);
      }
      return value;
    };

    switch (arg) {
      case "--file":
        options.file = readValue("--file");
        break;
      case "--target-language":
      case "--to":
        options.targetLanguage = readValue(arg);
        break;
      case "--price-input":
        options.priceInputPer1M = readNumber("--price-input");
        break;
      case "--price-cached":
        options.priceCachedInputPer1M = readNumber("--price-cached");
        break;
      case "--price-output":
        options.priceOutputPer1M = readNumber("--price-output");
        break;
      case "--posts-dir":
        options.postsDir = readValue("--posts-dir");
        break;
      case "--out-dir":
        options.outDir = readValue("--out-dir");
        break;
      case "--model":
        options.model = readValue("--model");
        break;
      case "--concurrency": {
        const value = Number(readValue("--concurrency"));
        if (!Number.isFinite(value) || value < 1) {
          throw new Error("--concurrency must be a positive integer");
        }
        options.concurrency = Math.floor(value);
        break;
      }
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        if (options.file) {
          if (!options.targetLanguage) {
            if (isLikelyModelId(arg) && options.model === DEFAULT_MODEL) {
              options.model = arg;
              break;
            }
            options.targetLanguage = arg;
            break;
          }

          if (isLikelyModelId(arg) && options.model === DEFAULT_MODEL) {
            options.model = arg;
            break;
          }

          throw new Error(`Unexpected positional argument: ${arg}`);
        }
        options.file = arg;
    }
  }

  return options;
}

function replaceFileTargetLanguage(xml: string, targetLanguage: string): string {
  return xml.replace(/<file\b([^>]*)>/i, (_m, attrs: string) => {
    const hasTargetLanguage = /\btarget-language\s*=/i.test(attrs);
    if (hasTargetLanguage) {
      const updatedAttrs = attrs.replace(
        /\btarget-language\s*=\s*(?:"[^"]*"|'[^']*')/i,
        `target-language="${targetLanguage}"`,
      );
      return `<file${updatedAttrs}>`;
    }

    return `<file${attrs} target-language="${targetLanguage}">`;
  });
}

async function loadLocalEnvIfExists(): Promise<void> {
  const envPath = path.resolve(".env");
  const exists = await fs
    .access(envPath)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return;
  }

  const content = await fs.readFile(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function resolveInputFile(options: CliOptions): Promise<string> {
  const postsDir = path.resolve(options.postsDir);

  if (options.file) {
    const candidate = path.isAbsolute(options.file)
      ? options.file
      : path.resolve(postsDir, options.file);
    return candidate;
  }

  if (!process.stdin.isTTY) {
    throw new Error("Use --file when running non-interactively");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const files = await fs.readdir(postsDir);
    const xliffFiles = files
      .filter((name) => name.toLowerCase().endsWith(".xliff"))
      .sort((a, b) => a.localeCompare(b));

    if (xliffFiles.length === 0) {
      throw new Error(`No .xliff files found in ${postsDir}`);
    }

    console.log(`Found ${xliffFiles.length} XLIFF files in ${postsDir}`);
    const answer = await rl.question(
      "Enter XLIFF filename from posts (for example: Western Bid-translation-job-264.xliff): ",
    );

    if (!answer.trim()) {
      throw new Error("Filename is required");
    }

    return path.resolve(postsDir, answer.trim());
  } finally {
    rl.close();
  }
}

function extractAttr(tagContent: string, attrName: string): string | null {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = tagContent.match(regex);
  if (!match) {
    return null;
  }
  return match[1] ?? match[2] ?? null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlInnerToText(innerXml: string): string {
  const cdataMatch = innerXml.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdataMatch) {
    return cdataMatch[1];
  }
  return decodeXmlEntities(innerXml);
}

function toCdata(value: string): string {
  const safe = value.replace(/\]\]>/g, "]]]]><![CDATA[>");
  return `<![CDATA[${safe}]]>`;
}

function normalizeForHandleMatch(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function isHandleField(value: string | null): boolean {
  if (!value) {
    return false;
  }
  return HANDLE_FIELD_REGEX.test(normalizeForHandleMatch(value));
}

function extractPostTypes(xml: string): string[] {
  const postTypes = new Set<string>();
  const regex =
    /<phase\b[^>]*\bphase-name\s*=\s*(?:"post_type"|'post_type')[^>]*>[\s\S]*?<note>([\s\S]*?)<\/note>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const raw = xmlInnerToText(match[1]).trim().toLowerCase();
    if (raw) {
      postTypes.add(raw);
    }
  }

  return Array.from(postTypes);
}

function isPageOrArticlePostType(postType: string): boolean {
  if (PAGE_OR_ARTICLE_POST_TYPES.has(postType)) {
    return true;
  }

  return postType.includes("page") || postType.includes("article");
}

function isPageOrArticleFile(postTypes: string[]): boolean {
  return postTypes.some((postType) => isPageOrArticlePostType(postType));
}

function shouldPreserveOriginalHandle(
  options: CliOptions,
  fileContext: FileContext,
  block: string,
): boolean {
  if (!options.preservePageArticleHandle || !fileContext.isPageOrArticle) {
    return false;
  }

  const transUnitTagMatch = block.match(/<trans-unit\b([^>]*)>/i);
  const transUnitAttrs = transUnitTagMatch?.[1] ?? "";
  const id = extractAttr(transUnitAttrs, "id");
  const resname = extractAttr(transUnitAttrs, "resname");

  const extradataTagMatch = block.match(/<tool:extradata\b([^>]*)\/?>/i);
  const extradataAttrs = extradataTagMatch?.[1] ?? "";
  const extraUnit = extractAttr(extradataAttrs, "unit");
  const extraPurpose = extractAttr(extradataAttrs, "purpose");

  return (
    isHandleField(id) ||
    isHandleField(resname) ||
    isHandleField(extraUnit) ||
    isHandleField(extraPurpose)
  );
}

function extractTransUnits(xml: string, options: CliOptions, fileContext: FileContext): TransUnit[] {
  const units: TransUnit[] = [];
  const transUnitRegex = /<trans-unit\b[\s\S]*?<\/trans-unit>/gi;
  let match: RegExpExecArray | null;

  while ((match = transUnitRegex.exec(xml)) !== null) {
    const block = match[0];
    const sourceMatch = block.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i);
    if (!sourceMatch) {
      continue;
    }

    const sourceText = xmlInnerToText(sourceMatch[1]);
    const copySourceToTarget = shouldPreserveOriginalHandle(options, fileContext, block);
    const translatable = sourceText.trim().length > 0 && !copySourceToTarget;
    units.push({
      start: match.index,
      end: match.index + block.length,
      block,
      sourceText,
      translatable,
      copySourceToTarget,
    });
  }

  return units;
}

function makeTranslatorPrompt(sourceLanguage: string, targetLanguage: string): string {
  return [
    "You are a professional translator for WordPress/WPML content.",
    `Translate from ${sourceLanguage} to ${targetLanguage}.`,
    "Rules:",
    "1. Return only the translated text with no explanations or markdown.",
    "2. Keep HTML tags, shortcodes, placeholders, URLs, JSON keys, numbers, and code syntax unchanged.",
    "3. Translate only human-readable natural language content.",
    "4. Preserve line breaks and spacing as naturally as possible.",
    "5. If a fragment is already in the target language, keep it unchanged.",
  ].join("\n");
}

async function translateText(
  client: OpenAI,
  model: string,
  sourceLanguage: string,
  targetLanguage: string,
  text: string,
): Promise<TranslationResponse> {
  const response = await client.responses.create({
    model,
    input: [
      {
        role: "system",
        content: makeTranslatorPrompt(sourceLanguage, targetLanguage),
      },
      {
        role: "user",
        content: text,
      },
    ],
    // temperature: 0,
  });

  const output = (response.output_text ?? "").trim();
  if (!output) {
    throw new Error("Model returned an empty translation");
  }

  return {
    text: output,
    usage: extractUsageTotals(response.usage),
  };
}

async function translateWithRetry(
  client: OpenAI,
  model: string,
  sourceLanguage: string,
  targetLanguage: string,
  text: string,
): Promise<TranslationResponse> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await translateText(client, model, sourceLanguage, targetLanguage, text);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delayMs = 800 * attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

async function translateUniqueTexts(
  client: OpenAI,
  model: string,
  sourceLanguage: string,
  targetLanguage: string,
  uniqueTexts: string[],
  concurrency: number,
): Promise<TranslationBatchResult> {
  const results = new Map<string, string>();
  const usageTotals = zeroUsageTotals();
  if (uniqueTexts.length === 0) {
    return { translations: results, usage: usageTotals };
  }

  let done = 0;
  let cursor = 0;
  const workerCount = Math.min(concurrency, uniqueTexts.length);

  console.log(`Translating ${uniqueTexts.length} unique segments with concurrency=${workerCount}...`);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= uniqueTexts.length) {
        return;
      }

      const sourceText = uniqueTexts[index];
      const translated = await translateWithRetry(
        client,
        model,
        sourceLanguage,
        targetLanguage,
        sourceText,
      );
      results.set(sourceText, translated.text);
      addUsage(usageTotals, translated.usage);

      done += 1;
      console.log(`[${done}/${uniqueTexts.length}] translated`);
    }
  });

  await Promise.all(workers);
  return { translations: results, usage: usageTotals };
}

function buildOutputXml(originalXml: string, units: TransUnit[], translatedMap: Map<string, string>): string {
  let outputXml = "";
  let cursor = 0;

  for (const unit of units) {
    outputXml += originalXml.slice(cursor, unit.start);
    let updatedBlock = unit.block;

    if (unit.translatable) {
      const translated = translatedMap.get(unit.sourceText);
      if (!translated) {
        throw new Error("Missing translated segment while composing output XLIFF");
      }

      const targetInner = toCdata(translated);
      if (/<target\b[^>]*>[\s\S]*?<\/target>/i.test(updatedBlock)) {
        updatedBlock = updatedBlock.replace(
          /<target\b([^>]*)>[\s\S]*?<\/target>/i,
          (_m, targetAttrs: string) => `<target${targetAttrs}>${targetInner}</target>`,
        );
      } else {
        updatedBlock = updatedBlock.replace(
          /<\/source>/i,
          `</source><target>${targetInner}</target>`,
        );
      }
    } else if (unit.copySourceToTarget) {
      const targetInner = toCdata(unit.sourceText);
      if (/<target\b[^>]*>[\s\S]*?<\/target>/i.test(updatedBlock)) {
        updatedBlock = updatedBlock.replace(
          /<target\b([^>]*)>[\s\S]*?<\/target>/i,
          (_m, targetAttrs: string) => `<target${targetAttrs}>${targetInner}</target>`,
        );
      } else {
        updatedBlock = updatedBlock.replace(
          /<\/source>/i,
          `</source><target>${targetInner}</target>`,
        );
      }
    }

    outputXml += updatedBlock;
    cursor = unit.end;
  }

  outputXml += originalXml.slice(cursor);
  return outputXml;
}

async function main(): Promise<void> {
  await loadLocalEnvIfExists();
  const options = parseCliArgs(process.argv.slice(2));
  const inputFilePath = await resolveInputFile(options);
  const absoluteInput = path.resolve(inputFilePath);

  const exists = await fs
    .access(absoluteInput)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    throw new Error(`Input file not found: ${absoluteInput}`);
  }

  if (path.extname(absoluteInput).toLowerCase() !== ".xliff") {
    throw new Error("Input file must have .xliff extension");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const xml = await fs.readFile(absoluteInput, "utf8");
  const fileTagMatch = xml.match(/<file\b([^>]*)>/i);
  if (!fileTagMatch) {
    throw new Error("Invalid XLIFF: <file> tag was not found");
  }

  const sourceLanguage = extractAttr(fileTagMatch[1], "source-language") ?? "auto";
  const targetLanguageFromFile = extractAttr(fileTagMatch[1], "target-language");
  const targetLanguage = (options.targetLanguage ?? targetLanguageFromFile ?? "en").trim();
  if (!targetLanguage) {
    throw new Error("Target language cannot be empty");
  }

  const postTypes = extractPostTypes(xml);
  const fileContext: FileContext = {
    postTypes,
    isPageOrArticle: isPageOrArticleFile(postTypes),
  };
  const units = extractTransUnits(xml, options, fileContext);
  const preservedHandleCount = units.filter((unit) => unit.copySourceToTarget).length;

  if (units.length === 0) {
    throw new Error("No trans-unit entries found in XLIFF");
  }

  const uniqueTexts = Array.from(
    new Set(
      units
        .filter((unit) => unit.translatable)
        .map((unit) => unit.sourceText),
    ),
  );

  const client = new OpenAI({ apiKey });
  const translationBatch = await translateUniqueTexts(
    client,
    options.model,
    sourceLanguage,
    targetLanguage,
    uniqueTexts,
    options.concurrency,
  );

  const translatedXml = buildOutputXml(xml, units, translationBatch.translations);
  const outputXml = replaceFileTargetLanguage(translatedXml, targetLanguage);

  const outputDir = path.resolve(options.outDir);
  await fs.mkdir(outputDir, { recursive: true });

  const inputBaseName = path.basename(absoluteInput, path.extname(absoluteInput));
  const outputName = `${inputBaseName}.${targetLanguage}.wpml-import.xliff`;
  const outputPath = path.join(outputDir, outputName);

  const outExists = await fs
    .access(outputPath)
    .then(() => true)
    .catch(() => false);

  if (outExists && !options.overwrite) {
    throw new Error(
      `Output file already exists: ${outputPath}\nUse --overwrite to replace it.`,
    );
  }

  await fs.writeFile(outputPath, outputXml, "utf8");

  console.log("\nDone.");
  console.log(`Input:  ${absoluteInput}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Model:  ${options.model}`);
  console.log(`Units:  ${units.length} (${uniqueTexts.length} unique translated segments)`);
  console.log(`Langs:  ${sourceLanguage} -> ${targetLanguage}`);
  if (options.preservePageArticleHandle && fileContext.isPageOrArticle) {
    const postTypeLabel = fileContext.postTypes.length > 0 ? fileContext.postTypes.join(", ") : "unknown";
    console.log(`Post type: ${postTypeLabel}`);
    console.log(`Handle/slug units preserved: ${preservedHandleCount}`);
  }

  const usage = translationBatch.usage;
  console.log("Tokens:");
  console.log(
    `  input=${usage.inputTokens.toLocaleString()} (cached=${usage.cachedInputTokens.toLocaleString()})`,
  );
  console.log(`  output=${usage.outputTokens.toLocaleString()}`);
  console.log(`  total=${usage.totalTokens.toLocaleString()}`);

  const pricing = resolveEffectivePricing(options);
  if (!pricing) {
    console.log(
      "Cost: unavailable (model pricing not found; use --price-input and --price-output to set custom rates).",
    );
  } else {
    const cost = calculateCost(usage, pricing);
    console.log("Cost (estimated, USD):");
    console.log(`  input:        ${formatUsd(cost.inputCost)}`);
    console.log(`  cached input: ${formatUsd(cost.cachedInputCost)}`);
    console.log(`  output:       ${formatUsd(cost.outputCost)}`);
    console.log(`  total:        ${formatUsd(cost.totalCost)}`);
    console.log(
      `  rates per 1M: input=$${pricing.inputPer1M}, cached=$${pricing.cachedInputPer1M}, output=$${pricing.outputPer1M}`,
    );
    console.log("  source: https://platform.openai.com/pricing (checked 2026-03-26)");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
