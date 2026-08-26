import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExprNode, FlakeDefinition, NixExpr, PathSource, TemplateParts } from "@tsix/ir";

export interface EmitOptions {
  readonly entryFile: string;
  readonly projectRoot?: string;
  readonly assetsDir?: string;
  readonly preserveRoot?: string;
}

export interface EmitResult {
  readonly nix: string;
  readonly assets: readonly { source: string; name: string }[];
}

function nixString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("${", "\\${").replaceAll("\n", "\\n")}"`;
}

function attr(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name) ? name : nixString(name);
}

function indent(value: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function baseDirectory(base: string | undefined, entryFile: string): string {
  if (base === undefined) return dirname(entryFile);
  if (base.startsWith("file:")) return dirname(fileURLToPath(base));
  return dirname(resolve(base));
}

function validateRelativePath(path: string, label: string): void {
  if (path.length === 0 || isAbsolute(path) || path.startsWith("~/") || path === "~") {
    throw new Error(`${label} must be a non-empty relative path: ${path}`);
  }
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts.includes("..")) throw new Error(`${label} cannot contain '..': ${path}`);
}

function validatePathTemplate(template: TemplateParts, label: string): void {
  const first = template.strings[0] ?? "";
  if (first.startsWith("/") || first.startsWith("~/"))
    throw new Error(`${label} cannot be absolute`);
  for (const fragment of template.strings) {
    if (fragment.replaceAll("\\", "/").split("/").includes(".."))
      throw new Error(`${label} cannot contain '..'`);
  }
}

async function updateTreeHash(
  path: string,
  root: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const info = await lstat(path);
  const rel = relative(root, path).replaceAll(sep, "/");
  hash.update(`${rel}\0${info.mode & 0o7777}\0`);
  if (info.isSymbolicLink()) hash.update(`link\0${await readlink(path)}\0`);
  else if (info.isDirectory()) {
    hash.update("dir\0");
    for (const child of (await readdir(path)).toSorted())
      await updateTreeHash(join(path, child), root, hash);
  } else if (info.isFile()) hash.update(await readFile(path));
  else throw new Error(`Unsupported asset type: ${path}`);
}

async function hashTree(path: string): Promise<string> {
  const hash = createHash("sha256");
  await updateTreeHash(path, path, hash);
  return hash.digest("hex");
}

async function validateSymlinks(path: string, sourceRoot: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = resolve(dirname(path), await readlink(path));
    const canonicalTarget = await realpath(target).catch(() => {
      throw new Error(`Broken symbolic link in asset: ${path}`);
    });
    if (!within(sourceRoot, canonicalTarget))
      throw new Error(`Symbolic link escapes asset root: ${path}`);
    return;
  }
  if (info.isDirectory())
    for (const name of await readdir(path)) await validateSymlinks(join(path, name), sourceRoot);
}

interface Context {
  entryFile: string;
  projectRoot: string;
  preserveRoot?: string;
  assets: Map<string, { source: string; name: string }>;
}

async function materialize(
  source: PathSource & { mode: "copy" | "copy-template" },
  context: Context,
): Promise<string> {
  const raw = source.mode === "copy" ? source.path : source.root;
  validateRelativePath(raw, "asset path");
  const sourcePath = resolve(baseDirectory(source.base, context.entryFile), raw);
  const canonicalProject = await realpath(context.projectRoot);
  const canonicalSource = await realpath(sourcePath).catch(() => {
    throw new Error(`Asset does not exist: ${sourcePath}`);
  });
  if (!within(canonicalProject, canonicalSource))
    throw new Error(`Asset escapes project root: ${raw}`);
  const info = await stat(canonicalSource);
  const assetRoot = info.isDirectory() ? canonicalSource : dirname(canonicalSource);
  await validateSymlinks(canonicalSource, assetRoot);
  const hash = await hashTree(canonicalSource);
  const name = `${hash.slice(0, 16)}-${basename(canonicalSource)}`;
  context.assets.set(name, { source: canonicalSource, name });
  return `./assets/${name}`;
}

async function emitTemplate(
  parts: TemplateParts,
  context: Context,
  pathMode: boolean,
): Promise<string> {
  let output = "";
  for (let index = 0; index < parts.strings.length; index++) {
    const text = parts.strings[index] ?? "";
    output += pathMode
      ? text.replaceAll("\\", "/")
      : text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("${", "\\${");
    const hole = parts.holes[index];
    if (hole !== undefined) output += `\${${await emitNode(valueNode(hole), context)}}`;
  }
  return output;
}

function valueNode(value: TemplateParts["holes"][number]): ExprNode {
  return typeof value === "object" && value !== null && "node" in value
    ? value.node
    : { kind: "literal", value };
}

async function emitPath(source: PathSource, context: Context): Promise<string> {
  if (source.mode === "copy") return materialize(source, context);
  if (source.mode === "copy-template") {
    validatePathTemplate(source.template, "path template");
    const root = await materialize(source, context);
    const suffix = await emitTemplate(source.template, context, true);
    return `${root}${suffix.startsWith("/") ? "" : "/"}${suffix}`;
  }
  validatePathTemplate(source.template, "preserved path");
  const rendered = await emitTemplate(source.template, context, true);
  if (!rendered.startsWith("./")) throw new Error("Preserved paths must start with './'");
  if (source.template.holes.length === 0 && context.preserveRoot !== undefined) {
    const target = resolve(context.preserveRoot, rendered);
    if (!within(context.preserveRoot, target))
      throw new Error("Preserved path escapes output directory");
    await stat(target).catch(() => {
      throw new Error(`Preserved path does not exist in output: ${rendered}`);
    });
  }
  return rendered;
}

async function emitNode(node: ExprNode, context: Context): Promise<string> {
  switch (node.kind) {
    case "literal":
      return typeof node.value === "string"
        ? nixString(node.value)
        : node.value === null
          ? "null"
          : String(node.value);
    case "ident":
      return node.name;
    case "select":
      return `${await emitNode(node.from, context)}.${node.path.map(attr).join(".")}`;
    case "apply":
      return `${await emitNode(node.fn, context)} ${node.args.length === 1 ? await emitNode(node.args[0]!, context) : (await Promise.all(node.args.map((item) => emitNode(item, context)))).map((item) => `(${item})`).join(" ")}`;
    case "lambda":
      return `${node.argument}: ${await emitNode(node.body, context)}`;
    case "let":
      return `let\n${indent((await Promise.all(Object.entries(node.bindings).map(async ([key, value]) => `${attr(key)} = ${await emitNode(value, context)};`))).join("\n"))}\nin ${await emitNode(node.body, context)}`;
    case "attrset":
      return `{\n${indent((await Promise.all(Object.entries(node.attrs).map(async ([key, value]) => `${attr(key)} = ${await emitNode(value, context)};`))).join("\n"))}\n}`;
    case "list":
      return `[ ${(await Promise.all(node.items.map((item) => emitNode(item, context)))).join(" ")} ]`;
    case "string-template":
      return `"${await emitTemplate(node.template, context, false)}"`;
    case "path":
      return emitPath(node.source, context);
  }
}

export async function emitExpression(
  expression: NixExpr<unknown>,
  options: EmitOptions,
): Promise<EmitResult> {
  const context: Context = {
    entryFile: resolve(options.entryFile),
    projectRoot: resolve(options.projectRoot ?? dirname(options.entryFile)),
    ...(options.preserveRoot === undefined ? {} : { preserveRoot: resolve(options.preserveRoot) }),
    assets: new Map(),
  };
  return { nix: await emitNode(expression.node, context), assets: [...context.assets.values()] };
}

export async function emitFlake(flake: FlakeDefinition, options: EmitOptions): Promise<EmitResult> {
  const context: Context = {
    entryFile: resolve(options.entryFile),
    projectRoot: resolve(options.projectRoot ?? dirname(options.entryFile)),
    ...(options.preserveRoot === undefined ? {} : { preserveRoot: resolve(options.preserveRoot) }),
    assets: new Map(),
  };
  const inputLines = Object.entries(flake.inputs).flatMap(([name, input]) => [
    ...(input.url === undefined ? [] : [`${attr(name)}.url = ${nixString(input.url)};`]),
    ...(input.follows === undefined
      ? []
      : [`${attr(name)}.follows = ${nixString(input.follows)};`]),
  ]);
  const hosts = await Promise.all(
    Object.entries(flake.nixosConfigurations).map(async ([name, host]) => {
      const modules = await Promise.all(
        host.modules.map(
          async (module) => `({ config, lib, pkgs, ... }: ${await emitNode(module.node, context)})`,
        ),
      );
      const specialArgs =
        host.specialArgs === undefined
          ? ""
          : `\n  specialArgs = ${await emitNode(host.specialArgs.node, context)};`;
      return `${attr(name)} = nixpkgs.lib.nixosSystem {\n  system = ${nixString(host.system)};${specialArgs}\n  modules = [\n${modules.map((module) => indent(module, 4)).join("\n")}\n  ];\n};`;
    }),
  );
  const args = ["self", ...Object.keys(flake.inputs)]
    .filter((value, index, all) => all.indexOf(value) === index)
    .map(attr)
    .join(", ");
  const nix = `{\n${flake.description === undefined ? "" : `  description = ${nixString(flake.description)};\n`}  inputs = {\n${indent(inputLines.join("\n"), 4)}\n  };\n\n  outputs = { ${args}, ... }:\n    {\n      nixosConfigurations = {\n${indent(hosts.join("\n"), 8)}\n      };\n    };\n}\n`;
  return { nix, assets: [...context.assets.values()] };
}

export async function copyAssets(
  assets: EmitResult["assets"],
  outputDirectory: string,
): Promise<void> {
  if (assets.length === 0) return;
  const target = join(outputDirectory, "assets");
  await mkdir(target, { recursive: true });
  for (const asset of assets)
    await cp(asset.source, join(target, asset.name), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
}

export async function writeEmission(result: EmitResult, outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "flake.nix"), result.nix);
  await copyAssets(result.assets, outputDirectory);
}
