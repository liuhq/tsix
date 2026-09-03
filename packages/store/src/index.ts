import { spawn } from "node:child_process";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isDerivationRef,
  isOutputRef,
  isPackageRef,
  isPathRef,
  isShellScript,
  isSourceRef,
  type BuildTarget,
  type DerivationRef,
  type PackageRef,
  type SourceRef,
  type StoreRef,
  type StringValue,
} from "@tsix/core";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export class NixCommandError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string) {
    super(`nix ${args.join(" ")} failed${stderr.trim() === "" ? "" : `:\n${stderr.trim()}`}`);
    this.name = "NixCommandError";
    this.args = args;
    this.stderr = stderr;
  }
}

export interface ExecuteOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly maxBuffer?: number;
}

export class NixDriver {
  readonly command: string;
  private compatibility: Promise<void> | undefined;

  constructor(command = "nix") {
    this.command = command;
  }

  async execute(args: readonly string[], options: ExecuteOptions = {}): Promise<CommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.command, [...args], {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let settled = false;

      const append = (target: Buffer[], chunk: Buffer): void => {
        size += chunk.length;
        if (size > maxBuffer && !settled) {
          settled = true;
          child.kill();
          reject(new Error(`nix command output exceeded ${maxBuffer} bytes`));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (code === 0) resolvePromise(result);
        else reject(new NixCommandError(args, result.stderr));
      });
      child.stdin.end(options.input);
    });
  }

  async assertCompatible(): Promise<void> {
    this.compatibility ??= this.checkCompatibility();
    return this.compatibility;
  }

  private async checkCompatibility(): Promise<void> {
    const { stdout } = await this.execute(["--version"]);
    const match = /Nix\)\s+(\d+)\.(\d+)/.exec(stdout);
    if (match === null) throw new Error(`Cannot parse Nix version: ${stdout.trim()}`);
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < 2 || (major === 2 && minor < 23)) {
      throw new Error(`tsix requires Nix 2.23 or newer; found ${major}.${minor}`);
    }
    const probe = await this.execute([
      "derivation",
      "show",
      "--expr",
      'derivation { name = "tsix-protocol-probe"; system = "x86_64-linux"; builder = "/bin/false"; }',
    ]);
    const protocol = JSON.parse(probe.stdout) as { version?: unknown };
    if (protocol.version !== 4) {
      throw new Error(`tsix requires derivation JSON v4; Nix returned ${String(protocol.version)}`);
    }
  }

  async addSource(path: string, name?: string): Promise<string> {
    const args = ["store", "add", path];
    if (name !== undefined) args.push("--name", name);
    return (await this.execute(args)).stdout.trim();
  }

  async addDerivation(derivation: DerivationJsonV4): Promise<string> {
    const { stdout } = await this.execute(["derivation", "add"], {
      input: `${JSON.stringify(derivation)}\n`,
    });
    return stdout.trim();
  }

  async showDerivation(path: string): Promise<ShownDerivation> {
    return this.parseShown((await this.execute(["derivation", "show", path])).stdout);
  }

  async showExpression(expression: string): Promise<ShownDerivation> {
    return this.parseShown(
      (await this.execute(["derivation", "show", "--impure", "--expr", expression])).stdout,
    );
  }

  async build(
    installable: string,
    options: { readonly outLink?: string; readonly noLink?: boolean } = {},
  ): Promise<readonly string[]> {
    const args = ["build", installable, "--print-out-paths"];
    if (options.noLink) args.push("--no-link");
    else if (options.outLink !== undefined) args.push("--out-link", options.outLink);
    const { stdout } = await this.execute(args);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private parseShown(raw: string): ShownDerivation {
    const parsed = JSON.parse(raw) as DerivationShowJson;
    if (parsed.version !== 4) {
      throw new Error(`Unsupported Nix derivation JSON version: ${String(parsed.version)}`);
    }
    const entries = Object.entries(parsed.derivations);
    if (entries.length !== 1) {
      throw new Error(`Expected one derivation from Nix, received ${entries.length}`);
    }
    const [drvName, value] = entries[0]!;
    if (value.version !== 4) throw new Error("Nix returned a non-v4 derivation");
    const outputs = Object.fromEntries(
      Object.entries(value.outputs).map(([name, output]) => {
        if (typeof output.path !== "string" || output.path.length === 0) {
          throw new Error(`Nix did not resolve output ${name}`);
        }
        const path = output.path.startsWith("/") ? output.path : `/nix/store/${output.path}`;
        return [name, path];
      }),
    );
    return {
      drvPath: drvName.startsWith("/") ? drvName : `/nix/store/${drvName}`,
      name: value.name,
      outputs,
      json: value,
    };
  }
}

export interface DerivationJsonV4 {
  readonly version: 4;
  readonly name: string;
  readonly outputs: Readonly<Record<string, Readonly<Record<string, never>>>>;
  readonly inputs: {
    readonly srcs: readonly string[];
    readonly drvs: Readonly<
      Record<string, { readonly outputs: readonly string[]; readonly dynamicOutputs: object }>
    >;
  };
  readonly system: string;
  readonly builder: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface DerivationShowJson {
  readonly version: number;
  readonly derivations: Record<
    string,
    {
      readonly version: number;
      readonly name: string;
      readonly outputs: Record<string, { readonly path?: string }>;
      readonly [key: string]: unknown;
    }
  >;
}

export interface ShownDerivation {
  readonly drvPath: string;
  readonly name: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly json: DerivationShowJson["derivations"][string];
}

export interface ResolvedOutput {
  readonly drvPath: string;
  readonly output: string;
  readonly outputPath: string;
}

export interface ExternalResolver {
  resolvePackage(reference: PackageRef): Promise<ResolvedOutput>;
}

export interface CompilerOptions {
  readonly entryFile: string;
  readonly projectRoot?: string;
  readonly resolver: ExternalResolver;
}

interface Rendered {
  readonly text: string;
  readonly drvs: Map<string, Set<string>>;
  readonly srcs: Set<string>;
}

export class DerivationCompiler {
  private readonly driver: NixDriver;
  private readonly options: CompilerOptions;
  private readonly derivations = new WeakMap<DerivationRef<string>, Promise<ShownDerivation>>();
  private readonly sources = new WeakMap<SourceRef, Promise<string>>();

  constructor(driver: NixDriver, options: CompilerOptions) {
    this.driver = driver;
    this.options = options;
  }

  async compileTarget(target: BuildTarget): Promise<ResolvedOutput> {
    if (isPackageRef(target)) return this.options.resolver.resolvePackage(target);
    if (isOutputRef(target)) return this.resolveOutput(target.derivation, target.output, new Set());
    return this.resolveOutput(target, target.out.output, new Set());
  }

  async resolveStoreRef(
    reference: StoreRef,
    ancestors = new Set<DerivationRef<string>>(),
  ): Promise<ResolvedOutput | { readonly outputPath: string }> {
    if (isPackageRef(reference)) return this.options.resolver.resolvePackage(reference);
    if (isSourceRef(reference)) return { outputPath: await this.resolveSource(reference) };
    if (isOutputRef(reference)) {
      return this.resolveOutput(reference.derivation, reference.output, ancestors);
    }
    return this.resolveOutput(reference, reference.out.output, ancestors);
  }

  private async resolveOutput(
    reference: DerivationRef<string>,
    output: string,
    ancestors: ReadonlySet<DerivationRef<string>>,
  ): Promise<ResolvedOutput> {
    const shown = await this.compile(reference, ancestors);
    const outputPath = shown.outputs[output];
    if (outputPath === undefined) {
      throw new Error(`Derivation ${shown.name} has no output named ${output}`);
    }
    return { drvPath: shown.drvPath, output, outputPath };
  }

  private compile(
    reference: DerivationRef<string>,
    ancestors: ReadonlySet<DerivationRef<string>>,
  ): Promise<ShownDerivation> {
    if (ancestors.has(reference)) {
      return Promise.reject(new Error(`Derivation dependency cycle at ${reference.spec.name}`));
    }
    const existing = this.derivations.get(reference);
    if (existing !== undefined) return existing;
    const next = new Set(ancestors);
    next.add(reference);
    const pending = this.compileOnce(reference, next);
    this.derivations.set(reference, pending);
    return pending;
  }

  private async compileOnce(
    reference: DerivationRef<string>,
    ancestors: ReadonlySet<DerivationRef<string>>,
  ): Promise<ShownDerivation> {
    const { spec } = reference;
    assertDerivationName(spec.name);
    const outputNames = spec.outputs ?? ["out"];
    const builder = await this.render(spec.builder, ancestors);
    if (!builder.text.startsWith("/nix/store/")) {
      throw new Error(`Derivation builder must resolve to a Nix store path: ${spec.name}`);
    }
    const renderedArgs = await Promise.all(
      (spec.args ?? []).map((value) => this.render(value, ancestors)),
    );
    const renderedEnv = await Promise.all(
      Object.entries(spec.env ?? {}).map(
        async ([name, value]) => [name, await this.render(value, ancestors)] as const,
      ),
    );
    const reserved = new Set(["builder", "name", "system", ...outputNames]);
    for (const [name] of renderedEnv) {
      if (reserved.has(name)) throw new Error(`Environment variable ${name} is managed by tsix`);
    }

    const all = [builder, ...renderedArgs, ...renderedEnv.map(([, value]) => value)];
    for (const input of spec.inputs ?? []) all.push(await this.render(input, ancestors));
    const drvs = new Map<string, Set<string>>();
    const srcs = new Set<string>();
    for (const rendered of all) {
      for (const sourcePath of rendered.srcs) srcs.add(sourcePath);
      for (const [drvPath, outputs] of rendered.drvs) {
        const current = drvs.get(drvPath) ?? new Set<string>();
        outputs.forEach((output) => current.add(output));
        drvs.set(drvPath, current);
      }
    }

    const json: DerivationJsonV4 = {
      version: 4,
      name: spec.name,
      outputs: Object.fromEntries(outputNames.map((name) => [name, {}])),
      inputs: {
        srcs: [...srcs].map((path) => basename(path)).toSorted(),
        drvs: Object.fromEntries(
          [...drvs.entries()]
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([path, outputs]) => [
              basename(path),
              { outputs: [...outputs].toSorted(), dynamicOutputs: {} },
            ]),
        ),
      },
      system: spec.system,
      builder: builder.text,
      args: renderedArgs.map(({ text }) => text),
      env: {
        builder: builder.text,
        name: spec.name,
        system: spec.system,
        ...Object.fromEntries(renderedEnv.map(([name, { text }]) => [name, text])),
        ...Object.fromEntries(outputNames.map((name) => [name, ""])),
      },
    };
    const drvPath = await this.driver.addDerivation(json);
    return this.driver.showDerivation(drvPath);
  }

  private async render(
    value: StringValue,
    ancestors: ReadonlySet<DerivationRef<string>>,
  ): Promise<Rendered> {
    if (isShellScript(value)) {
      const rendered = await Promise.all(value.parts.map((part) => this.render(part, ancestors)));
      return mergeRendered(rendered);
    }
    if (isPathRef(value)) {
      const root = await this.render(value.root, ancestors);
      return { ...root, text: `${root.text}${value.suffix}` };
    }
    if (isSourceRef(value) || isPackageRef(value) || isOutputRef(value) || isDerivationRef(value)) {
      const resolved = await this.resolveStoreRef(value, new Set(ancestors));
      if ("drvPath" in resolved) {
        return {
          text: resolved.outputPath,
          drvs: new Map([[resolved.drvPath, new Set([resolved.output])]]),
          srcs: new Set(),
        };
      }
      return { text: resolved.outputPath, drvs: new Map(), srcs: new Set([resolved.outputPath]) };
    }
    const text = value === null ? "" : String(value);
    if (text.includes("/nix/store/")) {
      throw new Error("Raw Nix store paths are forbidden; use a typed store reference");
    }
    return { text, drvs: new Map(), srcs: new Set() };
  }

  private resolveSource(reference: SourceRef): Promise<string> {
    const existing = this.sources.get(reference);
    if (existing !== undefined) return existing;
    const pending = this.resolveSourceOnce(reference);
    this.sources.set(reference, pending);
    return pending;
  }

  private async resolveSourceOnce(reference: SourceRef): Promise<string> {
    const entryDirectory = dirname(resolve(this.options.entryFile));
    const root =
      reference.root === undefined ? entryDirectory : resolveRoot(reference.root, entryDirectory);
    const projectRoot = await realpath(resolve(this.options.projectRoot ?? entryDirectory));
    const target = await realpath(resolve(root, reference.path)).catch(() => {
      throw new Error(`Source does not exist: ${reference.path}`);
    });
    if (!within(projectRoot, target))
      throw new Error(`Source escapes project root: ${reference.path}`);
    const info = await lstat(target);
    await validateSymlinks(target, info.isDirectory() ? target : dirname(target));
    return this.driver.addSource(target, reference.name);
  }
}

function mergeRendered(values: readonly Rendered[]): Rendered {
  const drvs = new Map<string, Set<string>>();
  const srcs = new Set<string>();
  for (const value of values) {
    for (const sourcePath of value.srcs) srcs.add(sourcePath);
    for (const [drvPath, outputs] of value.drvs) {
      const current = drvs.get(drvPath) ?? new Set<string>();
      outputs.forEach((output) => current.add(output));
      drvs.set(drvPath, current);
    }
  }
  return { text: values.map(({ text }) => text).join(""), drvs, srcs };
}

function resolveRoot(root: string, entryDirectory: string): string {
  if (root.startsWith("file:")) return dirname(fileURLToPath(root));
  return isAbsolute(root) ? root : resolve(entryDirectory, root);
}

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function validateSymlinks(path: string, sourceRoot: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = await realpath(resolve(dirname(path), await readlink(path))).catch(() => {
      throw new Error(`Broken symbolic link in source: ${path}`);
    });
    if (!within(sourceRoot, target)) throw new Error(`Symbolic link escapes source root: ${path}`);
    return;
  }
  if (info.isDirectory()) {
    for (const child of await readdir(path)) {
      await validateSymlinks(resolve(path, child), sourceRoot);
    }
  }
}

function assertDerivationName(name: string): void {
  if (name.length === 0 || name.length > 211 || name.endsWith(".drv") || name.includes("/")) {
    throw new TypeError(`Invalid derivation name: ${name}`);
  }
}
