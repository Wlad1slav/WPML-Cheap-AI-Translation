import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

type CliOptions = {
  sourceDir: string;
  outDir: string;
  name: string | null;
  maxSizeBytes: number | null;
  overwrite: boolean;
};

type FileEntry = {
  relativePath: string;
  size: number;
};

type ArchivePart = {
  index: number;
  files: FileEntry[];
  totalSize: number;
};

function printHelp(): void {
  console.log(`Split files into multiple ZIP archives

Usage:
  npm run zip:split -- 25MB wpml-import archives de-translations
  npm run zip:split -- --max-size 25MB
  npm run zip:split -- --source-dir wpml-import --out-dir archives --name de-translations --max-size 20MB
  npm run zip:split -- --source-dir wpml-import --max-size 500KB --overwrite

Options:
  --source-dir <path>    Directory with files to archive (default: wpml-import)
  --out-dir <path>       Directory where ZIP parts will be created (default: archives)
  --name <name>          Base name for output ZIP parts (default: <source-dir>-timestamp)
  --max-size <size>      Max source size per part, for example 25MB, 500KB, 1.5GB
  --overwrite            Replace ZIP parts if they already exist
  --help                 Show this help

Notes:
  The script splits files into several standalone ZIP archives.
  Each part uses the original file sizes for packing, so the final ZIP
  is usually smaller than the configured limit because of compression.
  Positional form is recommended for PowerShell/npm compatibility:
    npm run zip:split -- 25MB wpml-import archives de-translations
`);
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sourceDir: process.env.npm_config_source_dir ?? "wpml-import",
    outDir: process.env.npm_config_out_dir ?? "archives",
    name: process.env.npm_config_name ?? null,
    maxSizeBytes: parseSizeFromEnv(process.env.npm_config_max_size),
    overwrite: parseBooleanEnv(process.env.npm_config_overwrite),
  };
  const positionalArgs: string[] = [];

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
      case "--source-dir":
        options.sourceDir = readValue("--source-dir");
        break;
      case "--out-dir":
        options.outDir = readValue("--out-dir");
        break;
      case "--name":
      case "--prefix":
        options.name = readValue(arg);
        break;
      case "--max-size":
        options.maxSizeBytes = parseSizeToBytes(readValue("--max-size"));
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        positionalArgs.push(arg);
        break;
    }
  }

  const normalizedPositionals = [...positionalArgs];
  const lastPositional = normalizedPositionals.at(-1);
  if (lastPositional) {
    const overwriteFlag = lastPositional.toLowerCase();
    if (overwriteFlag === "overwrite" || overwriteFlag === "force") {
      options.overwrite = true;
      normalizedPositionals.pop();
    }
  }

  const firstArgSize = normalizedPositionals[0]
    ? tryParseSizeToBytes(normalizedPositionals[0])
    : null;
  const lastArgSize =
    !firstArgSize && normalizedPositionals.length > 0
      ? tryParseSizeToBytes(normalizedPositionals[normalizedPositionals.length - 1])
      : null;

  if (firstArgSize) {
    options.maxSizeBytes = firstArgSize;
    applyOrderedValues(normalizedPositionals.slice(1), options);
  } else if (lastArgSize) {
    options.maxSizeBytes = lastArgSize;
    applyOrderedValues(normalizedPositionals.slice(0, -1), options);
  } else if (normalizedPositionals.length > 0) {
    throw new Error(
      `Could not find a valid size in positional arguments: ${normalizedPositionals.join(", ")}`,
    );
  }

  if (!options.maxSizeBytes) {
    throw new Error("Missing required argument: --max-size");
  }

  return options;
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return value === "true" || value === "1";
}

function parseSizeFromEnv(value: string | undefined): number | null {
  if (!value || value === "true" || value === "false") {
    return null;
  }

  return parseSizeToBytes(value);
}

function tryParseSizeToBytes(value: string): number | null {
  try {
    return parseSizeToBytes(value);
  } catch {
    return null;
  }
}

function applyOrderedValues(values: string[], options: CliOptions): void {
  if (values[0]) {
    options.sourceDir = values[0];
  }

  if (values[1]) {
    options.outDir = values[1];
  }

  if (values[2]) {
    options.name = values[2];
  }

  if (values.length > 3) {
    throw new Error(`Too many positional arguments: ${values.slice(3).join(", ")}`);
  }
}

function parseSizeToBytes(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|k|m|g|t)?$/i);
  if (!match) {
    throw new Error(`Invalid size value: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
  };

  const multiplier = multipliers[unit];
  const bytes = Math.floor(amount * multiplier);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`Invalid size value: ${value}`);
  }

  return bytes;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function formatTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function collectFilesRecursively(sourceDir: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  const stack = [sourceDir];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stats = await fs.stat(entryPath);
      files.push({
        relativePath: path.relative(sourceDir, entryPath),
        size: stats.size,
      });
    }
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

function buildArchiveParts(files: FileEntry[], maxSizeBytes: number): ArchivePart[] {
  const sortedFiles = [...files].sort((left, right) => {
    if (right.size !== left.size) {
      return right.size - left.size;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });

  const parts: ArchivePart[] = [];

  for (const file of sortedFiles) {
    if (file.size > maxSizeBytes) {
      throw new Error(
        `File "${file.relativePath}" is larger than the part limit (${formatBytes(file.size)} > ${formatBytes(maxSizeBytes)}).`,
      );
    }

    let selectedPart: ArchivePart | null = null;
    let bestRemainingSpace = Number.POSITIVE_INFINITY;

    for (const part of parts) {
      const nextSize = part.totalSize + file.size;
      if (nextSize > maxSizeBytes) {
        continue;
      }

      const remainingSpace = maxSizeBytes - nextSize;
      if (remainingSpace < bestRemainingSpace) {
        selectedPart = part;
        bestRemainingSpace = remainingSpace;
      }
    }

    if (!selectedPart) {
      selectedPart = {
        index: parts.length + 1,
        files: [],
        totalSize: 0,
      };
      parts.push(selectedPart);
    }

    selectedPart.files.push(file);
    selectedPart.totalSize += file.size;
  }

  for (const part of parts) {
    part.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  return parts;
}

function toPowerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`Archive process was terminated by signal: ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Archive process exited with code ${code}`));
        return;
      }
      resolve();
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

async function withTempManifest<T>(
  relativePaths: string[],
  run: (manifestPath: string) => Promise<T>,
): Promise<T> {
  const manifestPath = path.join(
    os.tmpdir(),
    `zip-part-manifest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );

  await fs.writeFile(manifestPath, relativePaths.join("\n"), "utf8");

  try {
    return await run(manifestPath);
  } finally {
    await fs.unlink(manifestPath).catch(() => undefined);
  }
}

async function archiveOnWindows(
  sourceDir: string,
  destinationZip: string,
  relativePaths: string[],
): Promise<void> {
  await withTempManifest(relativePaths, async (manifestPath) => {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `$paths = Get-Content -LiteralPath ${toPowerShellSingleQuoted(manifestPath)}`,
      `Set-Location -LiteralPath ${toPowerShellSingleQuoted(sourceDir)}`,
      `Compress-Archive -LiteralPath $paths -DestinationPath ${toPowerShellSingleQuoted(destinationZip)} -CompressionLevel Optimal -Force`,
    ].join("; ");

    await runProcess("powershell.exe", ["-NoProfile", "-Command", command]);
  });
}

async function archiveOnNonWindows(
  sourceDir: string,
  destinationZip: string,
  relativePaths: string[],
): Promise<void> {
  await runProcess("zip", ["-q", "-@", destinationZip], {
    cwd: sourceDir,
    input: `${relativePaths.join("\n")}\n`,
  });
}

async function createArchivePart(
  sourceDir: string,
  destinationZip: string,
  relativePaths: string[],
): Promise<void> {
  if (process.platform === "win32") {
    await archiveOnWindows(sourceDir, destinationZip, relativePaths);
    return;
  }

  await archiveOnNonWindows(sourceDir, destinationZip, relativePaths);
}

function isSameOrInsideDirectory(targetPath: string, directoryPath: string): boolean {
  const relative = path.relative(directoryPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getOutputPrefix(sourceDir: string, customName: string | null): string {
  if (customName && customName.trim().length > 0) {
    return customName.trim().replace(/\.zip$/i, "");
  }

  return `${path.basename(sourceDir)}-${formatTimestamp(new Date())}`;
}

function getOutputFileName(prefix: string, totalParts: number, partIndex: number): string {
  if (totalParts === 1) {
    return `${prefix}.zip`;
  }

  const width = Math.max(2, String(totalParts).length);
  const indexLabel = String(partIndex).padStart(width, "0");
  const totalLabel = String(totalParts).padStart(width, "0");
  return `${prefix}-part${indexLabel}-of${totalLabel}.zip`;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const sourceDir = path.resolve(options.sourceDir);
  const outDir = path.resolve(options.outDir);
  const maxSizeBytes = options.maxSizeBytes;

  if (!maxSizeBytes) {
    throw new Error("Missing part size limit.");
  }

  if (!(await exists(sourceDir))) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }

  const sourceStats = await fs.stat(sourceDir);
  if (!sourceStats.isDirectory()) {
    throw new Error(`Source path must be a directory: ${sourceDir}`);
  }

  if (isSameOrInsideDirectory(outDir, sourceDir)) {
    throw new Error("Output directory must be outside the source directory.");
  }

  const files = await collectFilesRecursively(sourceDir);
  if (files.length === 0) {
    throw new Error(`No files found in source directory: ${sourceDir}`);
  }

  const parts = buildArchiveParts(files, maxSizeBytes);
  const outputPrefix = getOutputPrefix(sourceDir, options.name);
  const destinations = parts.map((part) =>
    path.resolve(outDir, getOutputFileName(outputPrefix, parts.length, part.index)),
  );

  await fs.mkdir(outDir, { recursive: true });

  const existingDestinations: string[] = [];
  for (const destination of destinations) {
    if (await exists(destination)) {
      existingDestinations.push(destination);
    }
  }

  if (existingDestinations.length > 0 && !options.overwrite) {
    throw new Error(
      `ZIP part already exists: ${existingDestinations[0]}\nUse --overwrite to replace existing parts.`,
    );
  }

  if (options.overwrite) {
    for (const destination of existingDestinations) {
      await fs.unlink(destination);
    }
  }

  console.log(`Preparing ${files.length} file(s) from: ${sourceDir}`);
  console.log(`Output directory: ${outDir}`);
  console.log(`Part size limit: ${formatBytes(maxSizeBytes)}`);
  console.log(`Archive prefix:  ${outputPrefix}`);
  console.log(`Planned parts:   ${parts.length}`);

  let totalZipSize = 0;

  for (const [index, part] of parts.entries()) {
    const destination = destinations[index];
    console.log(`\nCreating part ${index + 1}/${parts.length}`);
    console.log(`Files: ${part.files.length}`);
    console.log(`Raw size: ${formatBytes(part.totalSize)}`);
    console.log(`Output: ${destination}`);

    await createArchivePart(
      sourceDir,
      destination,
      part.files.map((file) => file.relativePath),
    );

    const stats = await fs.stat(destination);
    totalZipSize += stats.size;

    console.log(`Created ZIP size: ${formatBytes(stats.size)}`);
    if (stats.size > maxSizeBytes) {
      console.warn(
        `Warning: ZIP part is larger than the requested limit (${formatBytes(stats.size)} > ${formatBytes(maxSizeBytes)}).`,
      );
    }
  }

  console.log("\nDone.");
  console.log(`Created ${parts.length} ZIP part(s).`);
  console.log(`Combined ZIP size: ${formatBytes(totalZipSize)}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
