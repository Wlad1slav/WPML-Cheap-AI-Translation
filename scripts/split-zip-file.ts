import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

type CliOptions = {
  archive: string | null;
  outDir: string | null;
  name: string | null;
  parts: number;
  overwrite: boolean;
};

type FileEntry = {
  relativePath: string;
  size: number;
};

type ArchivePart = {
  files: FileEntry[];
  totalSize: number;
};

function printHelp(): void {
  console.log(`Split one existing ZIP archive into standalone ZIP files

Usage:
  npm run zip:split-file -- archives/problematic.zip
  npm run zip:split-file -- archives/problematic.zip archives fixed-name
  npm run zip:split-file -- --archive archives/problematic.zip --parts 2 --overwrite

Options:
  --archive <file.zip>  ZIP archive to split (or pass it as the first positional argument)
  --out-dir <path>      Output directory (default: directory containing the source ZIP)
  --name <name>         Base name for output parts (default: source ZIP file name)
  --parts <number>      Number of standalone ZIP parts (default: 2)
  --overwrite           Replace output parts if they already exist
  --help                Show this help

Notes:
  The source ZIP is not changed. Files are balanced by their uncompressed sizes,
  and every output is an independent ZIP that can be uploaded separately.
  Output names keep the source base name and add _N, for example archive_1.zip.
`);
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 2) {
    throw new Error(`${flag} must be an integer greater than or equal to 2.`);
  }
  return parsed;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    archive: null,
    outDir: null,
    name: null,
    parts: 2,
    overwrite: false,
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
      case "--archive":
      case "--file":
        options.archive = readValue(arg);
        break;
      case "--out-dir":
        options.outDir = readValue(arg);
        break;
      case "--name":
      case "--prefix":
        options.name = readValue(arg);
        break;
      case "--parts":
        options.parts = parsePositiveInteger(readValue(arg), arg);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        positionalArgs.push(arg);
    }
  }

  if (positionalArgs.length > 3) {
    throw new Error(`Too many positional arguments: ${positionalArgs.slice(3).join(", ")}`);
  }

  options.archive ??= positionalArgs[0] ?? null;
  options.outDir ??= positionalArgs[1] ?? null;
  options.name ??= positionalArgs[2] ?? null;

  if (!options.archive) {
    throw new Error("Missing ZIP archive path. Pass it as the first argument or use --archive.");
  }

  return options;
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
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
        reject(new Error(`ZIP process was terminated by signal: ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`ZIP process exited with code ${code}`));
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

function toPowerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function extractArchive(archive: string, destination: string): Promise<void> {
  if (process.platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `Expand-Archive -LiteralPath ${toPowerShellSingleQuoted(archive)} -DestinationPath ${toPowerShellSingleQuoted(destination)} -Force`,
    ].join("; ");
    await runProcess("powershell.exe", ["-NoProfile", "-Command", command]);
    return;
  }

  await runProcess("unzip", ["-q", archive, "-d", destination]);
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
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported non-file entry in ZIP: ${path.relative(sourceDir, entryPath)}`);
      }

      const stats = await fs.stat(entryPath);
      files.push({
        relativePath: path.relative(sourceDir, entryPath),
        size: stats.size,
      });
    }
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function buildArchiveParts(files: FileEntry[], partCount: number): ArchivePart[] {
  if (files.length < partCount) {
    throw new Error(
      `The ZIP contains ${files.length} file(s), so it cannot be split into ${partCount} non-empty parts.`,
    );
  }

  const parts: ArchivePart[] = Array.from({ length: partCount }, () => ({
    files: [],
    totalSize: 0,
  }));
  const sortedFiles = [...files].sort((left, right) => {
    if (right.size !== left.size) {
      return right.size - left.size;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });

  for (const file of sortedFiles) {
    const part = parts.reduce((smallest, candidate) =>
      candidate.totalSize < smallest.totalSize ? candidate : smallest,
    );
    part.files.push(file);
    part.totalSize += file.size;
  }

  for (const part of parts) {
    part.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }
  return parts;
}

async function withTempManifest<T>(
  relativePaths: string[],
  run: (manifestPath: string) => Promise<T>,
): Promise<T> {
  const manifestPath = path.join(
    os.tmpdir(),
    `zip-file-manifest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  await fs.writeFile(manifestPath, relativePaths.join("\n"), "utf8");

  try {
    return await run(manifestPath);
  } finally {
    await fs.unlink(manifestPath).catch(() => undefined);
  }
}

async function createArchive(
  sourceDir: string,
  destination: string,
  relativePaths: string[],
): Promise<void> {
  if (process.platform === "win32") {
    await withTempManifest(relativePaths, async (manifestPath) => {
      const command = [
        "$ErrorActionPreference = 'Stop'",
        `$paths = Get-Content -LiteralPath ${toPowerShellSingleQuoted(manifestPath)}`,
        `Set-Location -LiteralPath ${toPowerShellSingleQuoted(sourceDir)}`,
        `Compress-Archive -LiteralPath $paths -DestinationPath ${toPowerShellSingleQuoted(destination)} -CompressionLevel Optimal -Force`,
      ].join("; ");
      await runProcess("powershell.exe", ["-NoProfile", "-Command", command]);
    });
    return;
  }

  await runProcess("zip", ["-q", "-@", destination], {
    cwd: sourceDir,
    input: `${relativePaths.join("\n")}\n`,
  });
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

function outputFileName(prefix: string, index: number): string {
  return `${prefix}_${index}.zip`;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const archive = path.resolve(options.archive!);

  if (!(await exists(archive))) {
    throw new Error(`ZIP archive not found: ${archive}`);
  }
  if (!(await fs.stat(archive)).isFile()) {
    throw new Error(`Archive path must be a file: ${archive}`);
  }
  if (path.extname(archive).toLowerCase() !== ".zip") {
    throw new Error(`Archive must have a .zip extension: ${archive}`);
  }

  const outDir = path.resolve(options.outDir ?? path.dirname(archive));
  const prefix = (options.name ?? path.basename(archive, path.extname(archive)))
    .trim()
    .replace(/\.zip$/i, "");
  if (!prefix) {
    throw new Error("Output name cannot be empty.");
  }

  const destinations = Array.from({ length: options.parts }, (_, index) =>
    path.join(outDir, outputFileName(prefix, index + 1)),
  );
  if (destinations.some((destination) => destination === archive)) {
    throw new Error("An output path would overwrite the source ZIP. Choose a different --name.");
  }

  await fs.mkdir(outDir, { recursive: true });
  const existing = [];
  for (const destination of destinations) {
    if (await exists(destination)) {
      existing.push(destination);
    }
  }
  if (existing.length > 0 && !options.overwrite) {
    throw new Error(`ZIP part already exists: ${existing[0]}\nUse --overwrite to replace it.`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "split-zip-file-"));
  try {
    console.log(`Reading ZIP: ${archive}`);
    await extractArchive(archive, tempDir);
    const files = await collectFilesRecursively(tempDir);
    if (files.length === 0) {
      throw new Error(`No files found in ZIP archive: ${archive}`);
    }

    const parts = buildArchiveParts(files, options.parts);
    if (options.overwrite) {
      for (const destination of existing) {
        await fs.unlink(destination);
      }
    }

    console.log(`Found ${files.length} file(s); creating ${options.parts} standalone ZIP parts.`);
    for (const [index, part] of parts.entries()) {
      const destination = destinations[index];
      console.log(`\nCreating part ${index + 1}/${parts.length}`);
      console.log(`Files: ${part.files.length}`);
      console.log(`Raw size: ${formatBytes(part.totalSize)}`);
      console.log(`Output: ${destination}`);

      await createArchive(
        tempDir,
        destination,
        part.files.map((file) => file.relativePath),
      );
      const stats = await fs.stat(destination);
      console.log(`ZIP size: ${formatBytes(stats.size)}`);
    }

    console.log("\nDone. The source ZIP was left unchanged.");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
