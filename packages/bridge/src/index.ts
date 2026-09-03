import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isDerivationRef,
  isOutputRef,
  isPackageRef,
  isPathRef,
  isShellScript,
  isSourceRef,
  source,
  type ConfigDefinition,
  type InputDefinition,
  type ModuleValue,
  type NixosModule,
  type NixosSystemDefinition,
  type PackageRef,
} from "@tsix/core";
import {
  DerivationCompiler,
  NixDriver,
  type ExternalResolver,
  type ResolvedOutput,
} from "@tsix/store";

const nixosAdapter = `{ capsule, manifest }:
let
  root = builtins.getFlake ("path:" + capsule);
  inputs = root.resolvedInputs;
  spec = builtins.fromJSON (builtins.readFile manifest);
  select = value: path: builtins.foldl' (current: name: builtins.getAttr name current) value path;
  nixpkgs = builtins.getAttr spec.nixpkgs inputs;
  lib = nixpkgs.lib;
  decode = value:
    if builtins.isList value then map decode value
    else if !builtins.isAttrs value then value
    else if value ? __tsixType then
      if value.__tsixType == "package" then
        builtins.getAttr value.output
          (select (builtins.getAttr value.input inputs)
            ([ "legacyPackages" value.system ] ++ value.attrPath))
      else if value.__tsixType == "derivation" then
        builtins.getAttr value.output (import value.drvPath)
      else if value.__tsixType == "source" then
        builtins.storePath value.path
      else if value.__tsixType == "dependency-string" then
        builtins.concatStringsSep "" (map decode value.parts)
      else if value.__tsixType == "priority" then
        (if value.mode == "default" then lib.mkDefault
         else if value.mode == "force" then lib.mkForce
         else if value.mode == "before" then lib.mkBefore
         else if value.mode == "after" then lib.mkAfter
         else throw "unknown tsix module priority") (decode value.value)
      else throw "unknown tsix tagged value"
    else builtins.mapAttrs (_: decode) value;
  loadModule = value:
    if value.kind == "config" then { config = decode value.config; }
    else if value.kind == "input" then select (builtins.getAttr value.input inputs) value.attrPath
    else if value.kind == "local" then import ((builtins.storePath value.root) + ("/" + value.file))
    else throw "unknown tsix module kind";
  evaluated = nixpkgs.lib.nixosSystem {
    system = spec.system;
    modules = map loadModule spec.modules;
    specialArgs = decode spec.specialArgs;
  };
in evaluated.config.system.build.toplevel
`;

export interface TsixLock {
  readonly version: 1;
  readonly inputsHash: string;
  readonly nixVersion: string;
  readonly lockVersion: number;
  readonly root: string;
  readonly nodes: Readonly<Record<string, unknown>>;
}

interface NixFlakeLock {
  readonly version: number;
  readonly root: string;
  readonly nodes: Record<string, unknown>;
}

export interface Capsule {
  readonly path: string;
  dispose(): Promise<void>;
}

export class LockManager {
  private readonly driver: NixDriver;
  private readonly projectRoot: string;

  constructor(driver: NixDriver, projectRoot: string) {
    this.driver = driver;
    this.projectRoot = resolve(projectRoot);
  }

  get path(): string {
    return join(this.projectRoot, "tsix.lock");
  }

  async lock(inputs: ConfigDefinition["inputs"]): Promise<TsixLock> {
    const existing = await this.read(false);
    return this.runLock(inputs, existing, undefined);
  }

  async update(
    inputs: ConfigDefinition["inputs"],
    selected: readonly string[] = [],
  ): Promise<TsixLock> {
    for (const input of selected) {
      if (!(input in inputs)) throw new Error(`Unknown input: ${input}`);
    }
    return this.runLock(inputs, await this.read(false), selected);
  }

  async requireCurrent(inputs: ConfigDefinition["inputs"]): Promise<TsixLock> {
    const lock = await this.read(true);
    const expected = hashInputs(inputs);
    if (lock.inputsHash !== expected) {
      throw new Error(
        `tsix.lock is stale (expected ${expected}, found ${lock.inputsHash}); run \`tsix flake lock\``,
      );
    }
    return lock;
  }

  async createCapsule(inputs: ConfigDefinition["inputs"], lock: TsixLock): Promise<Capsule> {
    const path = await mkdtemp(join(tmpdir(), "tsix-capsule-"));
    await writeFile(join(path, "flake.nix"), renderFlakeShim(inputs));
    await writeFile(
      join(path, "flake.lock"),
      `${JSON.stringify({ version: lock.lockVersion, root: lock.root, nodes: lock.nodes }, null, 2)}\n`,
    );
    return { path, dispose: () => rm(path, { recursive: true, force: true }) };
  }

  async read(): Promise<TsixLock>;
  async read(required: true): Promise<TsixLock>;
  async read(required: false): Promise<TsixLock | undefined>;
  async read(required = true): Promise<TsixLock | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (!required) return undefined;
      throw new Error(`Cannot read tsix.lock; run \`tsix flake lock\``, { cause: error });
    }
    if (!isTsixLock(parsed)) throw new Error("Unsupported or invalid tsix.lock");
    return parsed;
  }

  private async runLock(
    inputs: ConfigDefinition["inputs"],
    existing: TsixLock | undefined,
    update: readonly string[] | undefined,
  ): Promise<TsixLock> {
    const capsulePath = await mkdtemp(join(tmpdir(), "tsix-lock-"));
    try {
      await writeFile(join(capsulePath, "flake.nix"), renderFlakeShim(inputs));
      if (existing !== undefined) {
        await writeFile(
          join(capsulePath, "flake.lock"),
          `${JSON.stringify(
            { version: existing.lockVersion, root: existing.root, nodes: existing.nodes },
            null,
            2,
          )}\n`,
        );
      }
      if (update === undefined) {
        await this.driver.execute(["flake", "lock"], { cwd: capsulePath });
      } else {
        await this.driver.execute(["flake", "update", ...update], { cwd: capsulePath });
      }
      const nixLock = JSON.parse(
        await readFile(join(capsulePath, "flake.lock"), "utf8"),
      ) as NixFlakeLock;
      const { stdout: nixVersion } = await this.driver.execute(["--version"]);
      const lock: TsixLock = {
        version: 1,
        inputsHash: hashInputs(inputs),
        nixVersion: nixVersion.trim(),
        lockVersion: nixLock.version,
        root: nixLock.root,
        nodes: nixLock.nodes,
      };
      await atomicWrite(this.path, `${JSON.stringify(lock, null, 2)}\n`);
      return lock;
    } finally {
      await rm(capsulePath, { recursive: true, force: true });
    }
  }
}

export class NixBridge implements ExternalResolver {
  private readonly driver: NixDriver;
  private readonly capsule: Capsule;
  private readonly cache = new Map<string, Promise<ResolvedOutput>>();

  constructor(driver: NixDriver, capsule: Capsule) {
    this.driver = driver;
    this.capsule = capsule;
  }

  resolvePackage(reference: PackageRef): Promise<ResolvedOutput> {
    const key = JSON.stringify(reference);
    const existing = this.cache.get(key);
    if (existing !== undefined) return existing;
    const pending = this.resolvePackageOnce(reference);
    this.cache.set(key, pending);
    return pending;
  }

  async instantiateNixos(
    definition: NixosSystemDefinition,
    compiler: DerivationCompiler,
    _options: { readonly entryFile: string; readonly projectRoot: string },
  ): Promise<ResolvedOutput> {
    const manifest = {
      nixpkgs: definition.nixpkgs,
      system: definition.system,
      modules: await Promise.all(
        definition.modules.map((item) => this.encodeModule(item, compiler)),
      ),
      specialArgs: await this.encodeValue(definition.specialArgs ?? {}, compiler, new Set()),
    };
    const manifestPath = join(this.capsule.path, `nixos-${randomUUID()}.json`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const adapterPath = join(this.capsule.path, "nixos-adapter.nix");
    await writeFile(adapterPath, nixosAdapter);
    const expression = `import ${nixString(adapterPath)} { capsule = ${nixString(
      this.capsule.path,
    )}; manifest = ${nixString(manifestPath)}; }`;
    const shown = await this.driver.showExpression(expression);
    const outputPath = shown.outputs.out;
    if (outputPath === undefined) throw new Error("NixOS toplevel has no out output");
    return { drvPath: shown.drvPath, output: "out", outputPath };
  }

  private async resolvePackageOnce(reference: PackageRef): Promise<ResolvedOutput> {
    const selection = [reference.input, "legacyPackages", reference.system, ...reference.attrPath];
    const expression = `let
  root = builtins.getFlake ${nixString(`path:${this.capsule.path}`)};
  value = builtins.foldl' (current: name: builtins.getAttr name current)
    root.resolvedInputs [ ${selection.map(nixString).join(" ")} ];
  selected = builtins.getAttr ${nixString(reference.output)} value;
in builtins.toJSON {
  drvPath = builtins.unsafeDiscardStringContext value.drvPath;
  outputPath = builtins.unsafeDiscardStringContext (toString selected);
}`;
    const { stdout } = await this.driver.execute([
      "eval",
      "--impure",
      "--raw",
      "--expr",
      expression,
    ]);
    const parsed = JSON.parse(stdout) as { drvPath?: unknown; outputPath?: unknown };
    if (typeof parsed.drvPath !== "string" || typeof parsed.outputPath !== "string") {
      throw new Error(`Package ${reference.attrPath.join(".")} did not resolve to a derivation`);
    }
    return {
      drvPath: parsed.drvPath,
      output: reference.output,
      outputPath: parsed.outputPath,
    };
  }

  private async encodeModule(value: NixosModule, compiler: DerivationCompiler): Promise<unknown> {
    if (value.tsixKind === "config-module") {
      return {
        kind: "config",
        config: await this.encodeValue(value.config, compiler, new Set()),
      };
    }
    if (value.tsixKind === "input-module") {
      return { kind: "input", input: value.input, attrPath: value.attrPath };
    }
    validateRelativeModulePath(value.file);
    const rootRef = source(".", { root: value.root });
    const resolved = await compiler.resolveStoreRef(rootRef);
    return { kind: "local", root: resolved.outputPath, file: value.file.replaceAll("\\", "/") };
  }

  private async encodeValue(
    value: ModuleValue,
    compiler: DerivationCompiler,
    seen: Set<object>,
  ): Promise<unknown> {
    if (value === null || typeof value !== "object") {
      if (typeof value === "string" && value.includes("/nix/store/")) {
        throw new Error("Raw Nix store paths are forbidden; use a typed store reference");
      }
      return value;
    }
    if (seen.has(value)) throw new Error("Circular value in NixOS module configuration");
    if (isPackageRef(value)) {
      return {
        __tsixType: "package",
        input: value.input,
        system: value.system,
        attrPath: value.attrPath,
        output: value.output,
      };
    }
    if (isSourceRef(value)) {
      const resolved = await compiler.resolveStoreRef(value);
      return { __tsixType: "source", path: resolved.outputPath };
    }
    if (isOutputRef(value) || isDerivationRef(value)) {
      const resolved = await compiler.compileTarget(isOutputRef(value) ? value : value.out);
      return {
        __tsixType: "derivation",
        drvPath: resolved.drvPath,
        output: resolved.output,
      };
    }
    if (isPathRef(value)) {
      seen.add(value);
      const root = await this.encodeValue(value.root, compiler, seen);
      seen.delete(value);
      return { __tsixType: "dependency-string", parts: [root, value.suffix] };
    }
    if (isShellScript(value)) {
      seen.add(value);
      const parts = await Promise.all(
        value.parts.map((part) => this.encodeValue(part, compiler, seen)),
      );
      seen.delete(value);
      return { __tsixType: "dependency-string", parts };
    }
    if ("tsixKind" in value && value.tsixKind === "module-priority") {
      seen.add(value);
      const encoded = await this.encodeValue(value.value, compiler, seen);
      seen.delete(value);
      return { __tsixType: "priority", mode: value.mode, value: encoded };
    }
    seen.add(value);
    const encoded = Array.isArray(value)
      ? await Promise.all(value.map((item) => this.encodeValue(item, compiler, seen)))
      : Object.fromEntries(
          await Promise.all(
            Object.entries(value).map(async ([key, item]) => [
              key,
              await this.encodeValue(item, compiler, seen),
            ]),
          ),
        );
    seen.delete(value);
    return encoded;
  }
}

function hashInputs(inputs: Readonly<Record<string, InputDefinition>>): string {
  const normalized = Object.fromEntries(
    Object.entries(inputs)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, value]),
  );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function isTsixLock(value: unknown): value is TsixLock {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "inputsHash" in value &&
    typeof value.inputsHash === "string" &&
    "lockVersion" in value &&
    typeof value.lockVersion === "number" &&
    "root" in value &&
    typeof value.root === "string" &&
    "nodes" in value &&
    typeof value.nodes === "object" &&
    value.nodes !== null &&
    "nixVersion" in value &&
    typeof value.nixVersion === "string"
  );
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}-${path.split(sep).at(-1) ?? "lock"}`);
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

function validateRelativeModulePath(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    isAbsolute(path) ||
    normalized.split("/").includes("..") ||
    normalized.startsWith("~/")
  ) {
    throw new Error(`Local module file must stay within its root: ${path}`);
  }
}

function nixString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("${", "\\${")}"`;
}

function renderFlakeShim(inputs: ConfigDefinition["inputs"]): string {
  const declarations = Object.entries(inputs)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, input]) => {
      if ((input.url === undefined) === (input.follows === undefined)) {
        throw new Error(`Input ${name} must define exactly one of url or follows`);
      }
      const field = input.url === undefined ? "follows" : "url";
      const value = input.url ?? input.follows!;
      return `  inputs.${nixString(name)}.${field} = ${nixString(value)};`;
    })
    .join("\n");
  return `{\n${declarations}\n  outputs = inputs: {\n    resolvedInputs = builtins.removeAttrs inputs [ "self" ];\n  };\n}\n`;
}

export function targetKind(target: unknown): "native" | "nixpkgs" | "unknown" {
  if (isDerivationRef(target) || isOutputRef(target)) return "native";
  if (isPackageRef(target)) return "nixpkgs";
  return "unknown";
}

export function assertWithinProject(projectRoot: string, path: string): void {
  const value = relative(resolve(projectRoot), resolve(path));
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`Path escapes project root: ${path}`);
  }
}
