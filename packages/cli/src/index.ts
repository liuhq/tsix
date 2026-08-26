import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { FlakeDefinition } from "@tsix/ir";
import { copyAssets, emitFlake } from "@tsix/nix";
import { tsImport } from "tsx/esm/api";

const execute = promisify(execFile);
const manifestName = ".tsix-manifest.json";

interface Manifest {
  readonly version: 1;
  readonly generatedAssets: readonly string[];
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function loadFlake(entry: string): Promise<FlakeDefinition> {
  const entryFile = resolve(entry);
  const loaded = (await tsImport(pathToFileURL(entryFile).href, import.meta.url)) as {
    default?: unknown;
  };
  const value = loaded.default;
  if (
    typeof value !== "object" ||
    value === null ||
    !("__tsixFlake" in value) ||
    value["__tsixFlake"] !== true
  ) {
    throw new TypeError(`${entry} must default-export the result of defineFlake()`);
  }
  return value as FlakeDefinition;
}

async function readManifest(directory: string): Promise<Manifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, manifestName), "utf8")) as Manifest;
    return parsed.version === 1 && Array.isArray(parsed.generatedAssets) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function preserveUnmanaged(
  oldDirectory: string,
  stage: string,
  manifest: Manifest,
): Promise<void> {
  const oldAssets = join(oldDirectory, "assets");
  if (!(await exists(oldAssets))) return;
  await mkdir(join(stage, "assets"), { recursive: true });
  for (const name of await readdir(oldAssets)) {
    if (!manifest.generatedAssets.includes(name))
      await cp(join(oldAssets, name), join(stage, "assets", name), {
        recursive: true,
        errorOnExist: true,
      });
  }
}

export interface BuildOptions {
  readonly outDirectory?: string;
  readonly stdout?: boolean;
  readonly projectRoot?: string;
}

export async function build(entry: string, options: BuildOptions = {}): Promise<string> {
  const entryFile = resolve(entry);
  const flake = await loadFlake(entryFile);
  const output = resolve(options.outDirectory ?? "dist/tsix");
  const result = await emitFlake(flake, {
    entryFile,
    projectRoot: resolve(options.projectRoot ?? process.cwd()),
    ...(options.stdout ? {} : { preserveRoot: output }),
  });
  if (options.stdout) {
    if (result.assets.length !== 0)
      throw new Error("--stdout cannot be used when copied assets are required");
    return result.nix;
  }
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, `.${basename(output)}-stage-`));
  const backup = join(parent, `.${basename(output)}-previous-${process.pid}`);
  try {
    await writeFile(join(stage, "flake.nix"), result.nix);
    await copyAssets(result.assets, stage);
    await writeFile(
      join(stage, manifestName),
      JSON.stringify(
        { version: 1, generatedAssets: result.assets.map((asset) => asset.name) },
        null,
        2,
      ) + "\n",
    );
    if (await exists(output)) {
      const manifest = await readManifest(output);
      if (manifest === undefined)
        throw new Error(`Refusing to replace ${output}: it is not managed by tsix`);
      await preserveUnmanaged(output, stage, manifest);
      await rename(output, backup);
    }
    await rename(stage, output);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!(await exists(output)) && (await exists(backup))) await rename(backup, output);
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  return output;
}

export async function check(entry: string, projectRoot = process.cwd()): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "tsix-check-"));
  try {
    await build(entry, { outDirectory: join(temporary, "flake"), projectRoot });
    await execute(
      "nix",
      ["flake", "check", `path:${join(temporary, "flake")}`, "--no-write-lock-file"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
