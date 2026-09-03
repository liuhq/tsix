import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LockManager, NixBridge, targetKind } from "@tsix/bridge";
import { type BuildTarget, type ConfigDefinition, type NixosSystemDefinition } from "@tsix/core";
import { DerivationCompiler, NixDriver, type ResolvedOutput } from "@tsix/store";
import { tsImport } from "tsx/esm/api";

export async function loadConfig(entry = "tsix.config.ts"): Promise<ConfigDefinition> {
  const entryFile = resolve(entry);
  const loaded = (await tsImport(pathToFileURL(entryFile).href, import.meta.url)) as {
    default?: unknown;
  };
  const value = loaded.default;
  if (
    typeof value !== "object" ||
    value === null ||
    !("tsixConfig" in value) ||
    value.tsixConfig !== true
  ) {
    throw new TypeError(`${entry} must default-export defineConfig()`);
  }
  return value as ConfigDefinition;
}

export interface ListedTarget {
  readonly path: string;
  readonly kind: "native" | "nixpkgs" | "nixos" | "unknown";
  readonly system?: string;
}

export function listTargets(config: ConfigDefinition): readonly ListedTarget[] {
  const values: ListedTarget[] = [];
  for (const [system, packages] of Object.entries(config.packages)) {
    for (const [name, target] of Object.entries(packages)) {
      values.push({ path: `packages.${system}.${name}`, kind: targetKind(target), system });
    }
  }
  for (const [system, checks] of Object.entries(config.checks)) {
    for (const [name, target] of Object.entries(checks)) {
      values.push({ path: `checks.${system}.${name}`, kind: targetKind(target), system });
    }
  }
  for (const [name, definition] of Object.entries(config.nixosConfigurations)) {
    values.push({ path: `nixosConfigurations.${name}`, kind: "nixos", system: definition.system });
  }
  return values.toSorted((left, right) => left.path.localeCompare(right.path));
}

type LocatedTarget =
  | { readonly kind: "build"; readonly value: BuildTarget }
  | { readonly kind: "nixos"; readonly value: NixosSystemDefinition };

export function findTarget(config: ConfigDefinition, path: string): LocatedTarget {
  const parts = path.split(".");
  if (parts[0] === "nixosConfigurations" && parts.length >= 2) {
    const value = config.nixosConfigurations[parts.slice(1).join(".")];
    if (value !== undefined) return { kind: "nixos", value };
  }
  if ((parts[0] === "packages" || parts[0] === "checks") && parts.length >= 3) {
    const group = parts[0] === "packages" ? config.packages : config.checks;
    const value = group[parts[1]!]?.[parts.slice(2).join(".")];
    if (value !== undefined) return { kind: "build", value };
  }
  throw new Error(`Unknown target: ${path}`);
}

export interface FlakeCommandOptions {
  readonly entry?: string;
  readonly projectRoot?: string;
  readonly driver?: NixDriver;
}

export async function lock(options: FlakeCommandOptions = {}): Promise<void> {
  const context = await baseContext(options);
  await context.driver.assertCompatible();
  await context.locks.lock(context.config.inputs);
}

export async function update(
  selected: readonly string[],
  options: FlakeCommandOptions = {},
): Promise<void> {
  const context = await baseContext(options);
  await context.driver.assertCompatible();
  await context.locks.update(context.config.inputs, selected);
}

export async function show(options: FlakeCommandOptions = {}): Promise<{
  readonly inputs: ConfigDefinition["inputs"];
  readonly targets: readonly ListedTarget[];
}> {
  const { config } = await baseContext(options);
  return { inputs: config.inputs, targets: listTargets(config) };
}

export async function build(
  path: string,
  buildOptions: { readonly outLink?: string } = {},
  options: FlakeCommandOptions = {},
): Promise<readonly string[]> {
  return withRuntime(
    options,
    async ({ config, compiler, bridge, driver, entryFile, projectRoot }) => {
      const target = findTarget(config, path);
      const resolved = await resolveTarget(target, compiler, bridge, entryFile, projectRoot);
      return driver.build(
        `${resolved.drvPath}^${resolved.output}`,
        buildOptions.outLink === undefined ? {} : { outLink: buildOptions.outLink },
      );
    },
  );
}

export async function check(options: FlakeCommandOptions = {}): Promise<void> {
  await withRuntime(
    options,
    async ({ config, compiler, bridge, driver, entryFile, projectRoot }) => {
      for (const packages of Object.values(config.packages)) {
        for (const target of Object.values(packages)) await compiler.compileTarget(target);
      }
      for (const definition of Object.values(config.nixosConfigurations)) {
        await bridge.instantiateNixos(definition, compiler, { entryFile, projectRoot });
      }
      for (const checks of Object.values(config.checks)) {
        for (const target of Object.values(checks)) {
          const resolved = await compiler.compileTarget(target);
          await driver.build(`${resolved.drvPath}^${resolved.output}`, { noLink: true });
        }
      }
    },
  );
}

async function baseContext(options: FlakeCommandOptions): Promise<{
  readonly config: ConfigDefinition;
  readonly driver: NixDriver;
  readonly locks: LockManager;
  readonly entryFile: string;
  readonly projectRoot: string;
}> {
  const entryFile = resolve(options.entry ?? "tsix.config.ts");
  await access(entryFile);
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const driver = options.driver ?? new NixDriver();
  return {
    config: await loadConfig(entryFile),
    driver,
    locks: new LockManager(driver, projectRoot),
    entryFile,
    projectRoot,
  };
}

async function withRuntime<T>(
  options: FlakeCommandOptions,
  operation: (runtime: {
    readonly config: ConfigDefinition;
    readonly compiler: DerivationCompiler;
    readonly bridge: NixBridge;
    readonly driver: NixDriver;
    readonly entryFile: string;
    readonly projectRoot: string;
  }) => Promise<T>,
): Promise<T> {
  const context = await baseContext(options);
  await context.driver.assertCompatible();
  const lockFile = await context.locks.requireCurrent(context.config.inputs);
  const capsule = await context.locks.createCapsule(context.config.inputs, lockFile);
  try {
    const bridge = new NixBridge(context.driver, capsule);
    const compiler = new DerivationCompiler(context.driver, {
      entryFile: context.entryFile,
      projectRoot: context.projectRoot,
      resolver: bridge,
    });
    return await operation({ ...context, compiler, bridge });
  } finally {
    await capsule.dispose();
  }
}

async function resolveTarget(
  target: LocatedTarget,
  compiler: DerivationCompiler,
  bridge: NixBridge,
  entryFile: string,
  projectRoot: string,
): Promise<ResolvedOutput> {
  return target.kind === "build"
    ? compiler.compileTarget(target.value)
    : bridge.instantiateNixos(target.value, compiler, { entryFile, projectRoot });
}
