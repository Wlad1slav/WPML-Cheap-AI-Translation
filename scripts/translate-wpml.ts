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
  model: string;
  concurrency: number;
  overwrite: boolean;
};

type TransUnit = {
  start: number;
  end: number;
  block: string;
  sourceText: string;
  translatable: boolean;
};

function printHelp(): void {
  console.log(`WPML XLIFF translator

Usage:
  npm run translate:wpml -- --file "Western Bid-translation-job-264.xliff"
  npm run translate:wpml -- "Western Bid-translation-job-264.xliff"
  npm run translate:wpml -- "Western Bid-translation-job-264.xliff" "de"

Options:
  --file <name|path>      XLIFF file name from posts directory or explicit path
  --target-language <lc>  Target language override (example: en, de, fr)
  --to <lc>               Alias for --target-language
  --posts-dir <path>      Source directory with XLIFF files (default: posts)
  --out-dir <path>        Output directory for import-ready files (default: wpml-import)
  --model <model>         OpenAI model (default: gpt-4.1-nano)
  --concurrency <number>  Parallel translation requests (default: 3)
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
    model: "gpt-4.1-nano",
    concurrency: 3,
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

    const readValue = (flag: string): string => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      i += 1;
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
          if (options.targetLanguage) {
            throw new Error(`Unexpected positional argument: ${arg}`);
          }
          options.targetLanguage = arg;
          break;
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

function extractTransUnits(xml: string): TransUnit[] {
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
    const translatable = sourceText.trim().length > 0;
    units.push({
      start: match.index,
      end: match.index + block.length,
      block,
      sourceText,
      translatable,
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
): Promise<string> {
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
    temperature: 0,
  });

  const output = (response.output_text ?? "").trim();
  if (!output) {
    throw new Error("Model returned an empty translation");
  }

  return output;
}

async function translateWithRetry(
  client: OpenAI,
  model: string,
  sourceLanguage: string,
  targetLanguage: string,
  text: string,
): Promise<string> {
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
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (uniqueTexts.length === 0) {
    return results;
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
      results.set(sourceText, translated);

      done += 1;
      console.log(`[${done}/${uniqueTexts.length}] translated`);
    }
  });

  await Promise.all(workers);
  return results;
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

  const units = extractTransUnits(xml);

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
  const translatedMap = await translateUniqueTexts(
    client,
    options.model,
    sourceLanguage,
    targetLanguage,
    uniqueTexts,
    options.concurrency,
  );

  const translatedXml = buildOutputXml(xml, units, translatedMap);
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
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
