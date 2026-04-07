import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

type CliOptions = {
  postsDir: string;
  outDir: string;
  targetLanguage: string | null;
  model: string | null;
  concurrency: number | null;
  priceInputPer1M: number | null;
  priceCachedInputPer1M: number | null;
  priceOutputPer1M: number | null;
  overwrite: boolean;
  continueOnError: boolean;
  limit: number | null;
  startFrom: string | null;
};

function printHelp(): void {
  console.log(`Translate all XLIFF files from posts directory

Usage:
  npm run translate:all
  npm run translate:all -- --target-language de
  npm run translate:all -- --target-language de --model gpt-5-nano --overwrite

Options:
  --posts-dir <path>        Source directory with XLIFF files (default: posts)
  --out-dir <path>          Output directory for import-ready files (default: wpml-import)
  --target-language <lc>    Target language override for every file (example: en, de, fr)
  --to <lc>                 Alias for --target-language
  --model <model>           OpenAI model for each file translation
  --concurrency <number>    Segment-level parallelism passed to translate script
  --price-input <usd>       Input price per 1M tokens (USD)
  --price-cached <usd>      Cached input price per 1M tokens (USD)
  --price-output <usd>      Output price per 1M tokens (USD)
  --start-from <filename>   Start from this file name (inclusive)
  --limit <number>          Translate only the first N files after filtering
  --overwrite               Overwrite output files if they already exist
  --continue-on-error       Continue with next files when one file fails
  --help                    Show this help
`);
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    postsDir: "posts",
    outDir: "wpml-import",
    targetLanguage: null,
    model: null,
    concurrency: null,
    priceInputPer1M: null,
    priceCachedInputPer1M: null,
    priceOutputPer1M: null,
    overwrite: false,
    continueOnError: false,
    limit: null,
    startFrom: null,
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

    if (arg === "--continue-on-error") {
      options.continueOnError = true;
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
      case "--posts-dir":
        options.postsDir = readValue("--posts-dir");
        break;
      case "--out-dir":
        options.outDir = readValue("--out-dir");
        break;
      case "--target-language":
      case "--to":
        options.targetLanguage = readValue(arg);
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
      case "--price-input":
        options.priceInputPer1M = readNumber("--price-input");
        break;
      case "--price-cached":
        options.priceCachedInputPer1M = readNumber("--price-cached");
        break;
      case "--price-output":
        options.priceOutputPer1M = readNumber("--price-output");
        break;
      case "--start-from":
        options.startFrom = readValue("--start-from");
        break;
      case "--limit": {
        const value = Number(readValue("--limit"));
        if (!Number.isFinite(value) || value < 1) {
          throw new Error("--limit must be a positive integer");
        }
        options.limit = Math.floor(value);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function listXliffFiles(postsDirPath: string): Promise<string[]> {
  const entries = await fs.readdir(postsDirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".xliff"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`Child process was terminated by signal: ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Child process exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function buildTranslateArgs(
  tsxCliPath: string,
  translateScriptPath: string,
  fileName: string,
  options: CliOptions,
): string[] {
  const args = [
    tsxCliPath,
    translateScriptPath,
    "--file",
    fileName,
    "--posts-dir",
    options.postsDir,
    "--out-dir",
    options.outDir,
  ];

  if (options.targetLanguage) {
    args.push("--target-language", options.targetLanguage);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.concurrency !== null) {
    args.push("--concurrency", String(options.concurrency));
  }
  if (options.priceInputPer1M !== null) {
    args.push("--price-input", String(options.priceInputPer1M));
  }
  if (options.priceCachedInputPer1M !== null) {
    args.push("--price-cached", String(options.priceCachedInputPer1M));
  }
  if (options.priceOutputPer1M !== null) {
    args.push("--price-output", String(options.priceOutputPer1M));
  }
  if (options.overwrite) {
    args.push("--overwrite");
  }

  return args;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const postsDirPath = path.resolve(options.postsDir);
  const tsxCliPath = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
  const translateScriptPath = path.resolve("scripts", "translate-wpml.ts");

  if (!(await exists(postsDirPath))) {
    throw new Error(`Posts directory not found: ${postsDirPath}`);
  }

  if (!(await exists(tsxCliPath))) {
    throw new Error(`TSX CLI not found: ${tsxCliPath}\nRun npm install first.`);
  }

  if (!(await exists(translateScriptPath))) {
    throw new Error(`Translation script not found: ${translateScriptPath}`);
  }

  let files = await listXliffFiles(postsDirPath);
  if (files.length === 0) {
    throw new Error(`No .xliff files found in ${postsDirPath}`);
  }

  if (options.startFrom) {
    const startIndex = files.findIndex(
      (fileName) => fileName.toLowerCase() === options.startFrom?.toLowerCase(),
    );
    if (startIndex === -1) {
      throw new Error(`--start-from file was not found in posts directory: ${options.startFrom}`);
    }
    files = files.slice(startIndex);
  }

  if (options.limit !== null) {
    files = files.slice(0, options.limit);
  }

  console.log(`Found ${files.length} file(s) to translate.`);
  console.log(`Posts dir: ${postsDirPath}`);
  console.log(`Out dir:   ${path.resolve(options.outDir)}`);

  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < files.length; index += 1) {
    const fileName = files[index];
    console.log(`\n[${index + 1}/${files.length}] ${fileName}`);

    try {
      const args = buildTranslateArgs(tsxCliPath, translateScriptPath, fileName, options);
      await runProcess(process.execPath, args);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed: ${fileName}`);
      console.error(`Reason: ${message}`);

      if (!options.continueOnError) {
        break;
      }
    }
  }

  const processed = succeeded + failed;
  const skipped = Math.max(0, files.length - processed);

  console.log("\nBatch summary:");
  console.log(`  total selected: ${files.length}`);
  console.log(`  succeeded:      ${succeeded}`);
  console.log(`  failed:         ${failed}`);
  console.log(`  skipped:        ${skipped}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
