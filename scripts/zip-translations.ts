import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

type CliOptions = {
  sourceDir: string;
  outDir: string;
  name: string | null;
  overwrite: boolean;
};

function printHelp(): void {
  console.log(`Archive translated files into ZIP

Usage:
  npm run zip:translations
  npm run zip:translations -- --name de-translations.zip
  npm run zip:translations -- --source-dir wpml-import --out-dir archives --overwrite

Options:
  --source-dir <path>    Directory with translated files (default: wpml-import)
  --out-dir <path>       Directory where ZIP will be created (default: archives)
  --name <file.zip>      Custom ZIP file name
  --overwrite            Replace ZIP if it already exists
  --help                 Show this help
`);
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sourceDir: "wpml-import",
    outDir: "archives",
    name: null,
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
      case "--source-dir":
        options.sourceDir = readValue("--source-dir");
        break;
      case "--out-dir":
        options.outDir = readValue("--out-dir");
        break;
      case "--name":
        options.name = readValue("--name");
        break;
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

async function countFilesRecursively(dirPath: string): Promise<number> {
  let count = 0;
  const stack = [dirPath];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }

  return count;
}

function toPowerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runProcess(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      cwd,
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
  });
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

async function archiveOnWindows(sourceDir: string, destinationZip: string): Promise<void> {
  const sourceGlob = path.join(sourceDir, "*");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `Compress-Archive -Path ${toPowerShellSingleQuoted(sourceGlob)} -DestinationPath ${toPowerShellSingleQuoted(destinationZip)} -CompressionLevel Optimal -Force`,
  ].join("; ");

  await runProcess("powershell.exe", ["-NoProfile", "-Command", command]);
}

async function archiveOnNonWindows(sourceDir: string, destinationZip: string): Promise<void> {
  await runProcess("zip", ["-r", destinationZip, "."], sourceDir);
}

function isInsideDirectory(filePath: string, directoryPath: string): boolean {
  const relative = path.relative(directoryPath, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const sourceDir = path.resolve(options.sourceDir);
  const outDir = path.resolve(options.outDir);
  const zipName = options.name ?? `translations-${formatTimestamp(new Date())}.zip`;
  const zipFileName = zipName.toLowerCase().endsWith(".zip") ? zipName : `${zipName}.zip`;
  const destinationZip = path.resolve(outDir, zipFileName);

  if (!(await exists(sourceDir))) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }

  const fileCount = await countFilesRecursively(sourceDir);
  if (fileCount === 0) {
    throw new Error(`No files found in source directory: ${sourceDir}`);
  }

  if (isInsideDirectory(destinationZip, sourceDir)) {
    throw new Error("Output ZIP must be outside source directory to avoid self-inclusion.");
  }

  await fs.mkdir(outDir, { recursive: true });

  if (await exists(destinationZip)) {
    if (!options.overwrite) {
      throw new Error(`ZIP already exists: ${destinationZip}\nUse --overwrite to replace it.`);
    }
    await fs.unlink(destinationZip);
  }

  console.log(`Archiving ${fileCount} file(s) from: ${sourceDir}`);
  console.log(`Destination ZIP: ${destinationZip}`);

  if (process.platform === "win32") {
    await archiveOnWindows(sourceDir, destinationZip);
  } else {
    await archiveOnNonWindows(sourceDir, destinationZip);
  }

  const stats = await fs.stat(destinationZip);
  console.log("\nDone.");
  console.log(`Created: ${destinationZip}`);
  console.log(`Size:    ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
