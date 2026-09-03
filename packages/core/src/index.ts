export type System = string;
export type Primitive = string | number | boolean | null;

export interface InputDefinition {
  readonly url?: string;
  readonly follows?: string;
}

export interface SourceOptions {
  readonly root?: string | URL;
  readonly name?: string;
}

export interface SourceRef {
  readonly tsixKind: "source";
  readonly path: string;
  readonly root?: string;
  readonly name?: string;
}

export interface PackageRef {
  readonly tsixKind: "package";
  readonly input: string;
  readonly system: System;
  readonly attrPath: readonly string[];
  readonly output: string;
}

export type StoreRef = SourceRef | PackageRef | DerivationRef<string> | OutputRef<string>;

export interface PathRef {
  readonly tsixKind: "path-ref";
  readonly root: StoreRef | PathRef;
  readonly suffix: string;
}

export type DependencyPart = string | StoreRef | PathRef;

export interface ShellScript {
  readonly tsixKind: "shell-script";
  readonly parts: readonly DependencyPart[];
}

export type ShellInterpolation = Primitive | StoreRef | PathRef | ShellScript;
export type StringValue = ShellInterpolation;

export interface DerivationOptions<Outputs extends string = "out"> {
  readonly name: string;
  readonly system: System;
  readonly builder: StoreRef | PathRef;
  readonly args?: readonly StringValue[];
  readonly env?: Readonly<Record<string, StringValue>>;
  readonly outputs?: readonly Outputs[];
  readonly inputs?: readonly StoreRef[];
}

export interface DerivationRef<Outputs extends string = "out"> {
  readonly tsixKind: "derivation";
  readonly spec: DerivationOptions<Outputs>;
  readonly outputs: Readonly<{ [K in Outputs]: OutputRef<K> }>;
  readonly out: OutputRef<Outputs extends "out" ? "out" : Outputs>;
}

export interface OutputRef<Name extends string = string> {
  readonly tsixKind: "output";
  readonly derivation: DerivationRef<string>;
  readonly output: Name;
}

export interface RunCommandOptions<Outputs extends string = "out"> {
  readonly name: string;
  readonly system: System;
  readonly shell: StoreRef;
  readonly path?: readonly StoreRef[];
  readonly env?: Readonly<Record<string, StringValue>>;
  readonly outputs?: readonly Outputs[];
  readonly inputs?: readonly StoreRef[];
}

export type ModuleValue =
  | Primitive
  | StoreRef
  | PathRef
  | ShellScript
  | readonly ModuleValue[]
  | { readonly [key: string]: ModuleValue }
  | ModulePriority;

export interface ConfigModule {
  readonly tsixKind: "config-module";
  readonly config: Readonly<Record<string, ModuleValue>>;
}

export interface InputModule {
  readonly tsixKind: "input-module";
  readonly input: string;
  readonly attrPath: readonly string[];
}

export interface LocalNixModule {
  readonly tsixKind: "local-module";
  readonly root: string;
  readonly file: string;
}

export type NixosModule = ConfigModule | InputModule | LocalNixModule;

export interface ModulePriority {
  readonly tsixKind: "module-priority";
  readonly mode: "default" | "force" | "before" | "after";
  readonly value: ModuleValue;
}

export interface NixosSystemDefinition {
  readonly tsixKind: "nixos-system";
  readonly nixpkgs: string;
  readonly system: System;
  readonly modules: readonly NixosModule[];
  readonly specialArgs?: Readonly<Record<string, ModuleValue>>;
}

export type BuildTarget = DerivationRef<string> | OutputRef<string> | PackageRef;

export interface ConfigDefinition {
  readonly tsixConfig: true;
  readonly inputs: Readonly<Record<string, InputDefinition>>;
  readonly packages: Readonly<Record<System, Readonly<Record<string, BuildTarget>>>>;
  readonly checks: Readonly<Record<System, Readonly<Record<string, BuildTarget>>>>;
  readonly nixosConfigurations: Readonly<Record<string, NixosSystemDefinition>>;
}

export interface ConfigOptions {
  readonly inputs?: Readonly<Record<string, InputDefinition>>;
  readonly packages?: Readonly<Record<System, Readonly<Record<string, BuildTarget>>>>;
  readonly checks?: Readonly<Record<System, Readonly<Record<string, BuildTarget>>>>;
  readonly nixosConfigurations?: Readonly<Record<string, NixosSystemDefinition>>;
}

function splitAttrPath(path: string | readonly string[]): readonly string[] {
  const parts = typeof path === "string" ? path.split(".") : path;
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new TypeError("Attribute paths must contain non-empty components");
  }
  return [...parts];
}

function assertOutputName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_+.-]*$/.test(name)) {
    throw new TypeError(`Invalid derivation output name: ${name}`);
  }
}

export function source(path: string, options: SourceOptions = {}): SourceRef {
  if (path.length === 0) throw new TypeError("Source path cannot be empty");
  return {
    tsixKind: "source",
    path,
    ...(options.root === undefined ? {} : { root: String(options.root) }),
    ...(options.name === undefined ? {} : { name: options.name }),
  };
}

export function packageRef(
  input: string,
  system: System,
  attrPath: string | readonly string[],
  output = "out",
): PackageRef {
  assertOutputName(output);
  return { tsixKind: "package", input, system, attrPath: splitAttrPath(attrPath), output };
}

export function pathRef(strings: TemplateStringsArray, root: StoreRef | PathRef): PathRef {
  if (strings.length !== 2 || strings[0] !== "") {
    throw new TypeError("pathRef must start with exactly one store reference");
  }
  if (!(isStoreRef(root) || isPathRef(root))) {
    throw new TypeError("pathRef interpolation must be a typed store reference");
  }
  const suffix = strings[1]!;
  if (suffix !== "" && !suffix.startsWith("/")) {
    throw new TypeError("pathRef suffix must be empty or start with /");
  }
  if (suffix.includes("\0") || suffix.split("/").includes("..")) {
    throw new TypeError("pathRef suffix must remain within the referenced store object");
  }
  return Object.freeze({ tsixKind: "path-ref", root, suffix });
}

export function sh(
  strings: TemplateStringsArray,
  ...holes: readonly ShellInterpolation[]
): ShellScript {
  const parts: DependencyPart[] = [];
  strings.forEach((text, index) => {
    if (text.length !== 0) parts.push(text);
    const hole = holes[index];
    if (hole === undefined) return;
    if (isShellScript(hole)) parts.push(...hole.parts);
    else if (isStoreRef(hole) || isPathRef(hole)) parts.push(hole);
    else if (isPrimitive(hole)) {
      const renderedPrimitive = hole === null ? "" : String(hole);
      if (renderedPrimitive.length !== 0) parts.push(renderedPrimitive);
    } else throw new TypeError("sh interpolation must be a primitive or typed store reference");
  });
  return Object.freeze({ tsixKind: "shell-script", parts: Object.freeze(parts) });
}

export function derivation<const Outputs extends string = "out">(
  options: DerivationOptions<Outputs>,
): DerivationRef<Outputs> {
  const names = (options.outputs ?? ["out"]) as readonly Outputs[];
  if (names.length === 0) throw new TypeError("A derivation must have at least one output");
  names.forEach(assertOutputName);
  if (new Set(names).size !== names.length)
    throw new TypeError("Derivation outputs must be unique");

  const reference = {
    tsixKind: "derivation" as const,
    spec: { ...options, outputs: [...names] },
  } as unknown as DerivationRef<Outputs>;
  const outputs = Object.fromEntries(
    names.map((name) => [
      name,
      { tsixKind: "output", derivation: reference as DerivationRef<string>, output: name },
    ]),
  ) as { [K in Outputs]: OutputRef<K> };
  const outputRecord = outputs as Readonly<Record<string, OutputRef<Outputs>>>;
  Object.defineProperties(reference, {
    outputs: { value: Object.freeze(outputs), enumerable: true },
    out: {
      value: outputRecord.out ?? outputRecord[names[0]!],
      enumerable: true,
    },
  });
  return Object.freeze(reference);
}

export function runCommand<const Outputs extends string = "out">(
  options: RunCommandOptions<Outputs>,
  script: ShellScript,
): DerivationRef<Outputs> {
  const path = options.path ?? [];
  if (!isShellScript(script)) {
    throw new TypeError("runCommand script must be created with the sh template tag");
  }
  const pathText: ShellScript = {
    tsixKind: "shell-script",
    parts: path.flatMap((item, index) => [
      ...(index === 0 ? [] : [":" as const]),
      item,
      "/bin" as const,
    ]),
  };
  return derivation({
    name: options.name,
    system: options.system,
    builder: makePathRef(options.shell, "/bin/bash"),
    args: ["-e", "-c", script],
    env: {
      ...(path.length === 0 ? {} : { PATH: pathText }),
      ...options.env,
    },
    ...(options.outputs === undefined ? {} : { outputs: options.outputs }),
    inputs: [...(options.inputs ?? []), ...path],
  });
}

export function module(config: Readonly<Record<string, ModuleValue>>): ConfigModule {
  return { tsixKind: "config-module", config };
}

export function inputModule(input: string, attrPath: string | readonly string[]): InputModule {
  return { tsixKind: "input-module", input, attrPath: splitAttrPath(attrPath) };
}

export function localNixModule(root: string, file: string): LocalNixModule {
  if (root.length === 0 || file.length === 0) {
    throw new TypeError("Local module root and file must be non-empty");
  }
  return { tsixKind: "local-module", root, file };
}

function priority(mode: ModulePriority["mode"], value: ModuleValue): ModulePriority {
  return { tsixKind: "module-priority", mode, value };
}

export const defaultValue = (value: ModuleValue): ModulePriority => priority("default", value);
export const force = (value: ModuleValue): ModulePriority => priority("force", value);
export const before = (value: ModuleValue): ModulePriority => priority("before", value);
export const after = (value: ModuleValue): ModulePriority => priority("after", value);

export function nixosSystem(
  definition: Omit<NixosSystemDefinition, "tsixKind">,
): NixosSystemDefinition {
  return { tsixKind: "nixos-system", ...definition };
}

export function defineConfig(options: ConfigOptions): ConfigDefinition {
  return {
    tsixConfig: true,
    inputs: options.inputs ?? {},
    packages: options.packages ?? {},
    checks: options.checks ?? {},
    nixosConfigurations: options.nixosConfigurations ?? {},
  };
}

export function isSourceRef(value: unknown): value is SourceRef {
  return isTagged(value, "source");
}

export function isPackageRef(value: unknown): value is PackageRef {
  return isTagged(value, "package");
}

export function isDerivationRef(value: unknown): value is DerivationRef<string> {
  return isTagged(value, "derivation");
}

export function isOutputRef(value: unknown): value is OutputRef<string> {
  return isTagged(value, "output");
}

export function isPathRef(value: unknown): value is PathRef {
  return isTagged(value, "path-ref");
}

export function isShellScript(value: unknown): value is ShellScript {
  return isTagged(value, "shell-script");
}

function isStoreRef(value: unknown): value is StoreRef {
  return isSourceRef(value) || isPackageRef(value) || isDerivationRef(value) || isOutputRef(value);
}

function isPrimitive(value: unknown): value is Primitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function makePathRef(root: StoreRef | PathRef, suffix: string): PathRef {
  return Object.freeze({ tsixKind: "path-ref", root, suffix });
}

function isTagged(value: unknown, kind: string): boolean {
  return (
    typeof value === "object" && value !== null && "tsixKind" in value && value.tsixKind === kind
  );
}
