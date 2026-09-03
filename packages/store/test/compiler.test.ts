import { describe, expect, it } from "vitest";
import { basename, resolve } from "node:path";
import { derivation, packageRef, pathRef, runCommand, sh, source } from "@tsix/core";
import {
  DerivationCompiler,
  NixDriver,
  type DerivationJsonV4,
  type ResolvedOutput,
  type ShownDerivation,
} from "../src/index.js";

class FakeDriver extends NixDriver {
  readonly added: DerivationJsonV4[] = [];

  override async addSource(path: string, name?: string): Promise<string> {
    return `/nix/store/${"s".repeat(32)}-${name ?? basename(path)}`;
  }

  override async addDerivation(value: DerivationJsonV4): Promise<string> {
    this.added.push(value);
    return `/nix/store/${"d".repeat(32)}-${value.name}.drv`;
  }

  override async showDerivation(path: string): Promise<ShownDerivation> {
    const value = this.added.at(-1)!;
    return {
      drvPath: path,
      name: value.name,
      outputs: Object.fromEntries(
        Object.keys(value.outputs).map((name) => [
          name,
          `/nix/store/${"o".repeat(32)}-${value.name}${name === "out" ? "" : `-${name}`}`,
        ]),
      ),
      json: { version: 4, name: value.name, outputs: {} },
    };
  }
}

function resolved(name: string, output = "out"): ResolvedOutput {
  return {
    drvPath: `/nix/store/${name[0]!.repeat(32)}-${name}.drv`,
    output,
    outputPath: `/nix/store/${name.at(-1)!.repeat(32)}-${name}`,
  };
}

describe("derivation compiler", () => {
  it("infers derivation inputs from typed strings", async () => {
    const driver = new FakeDriver();
    const bash = packageRef("nixpkgs", "x86_64-linux", "bash");
    const hello = packageRef("nixpkgs", "x86_64-linux", "hello");
    const payload = packageRef("nixpkgs", "x86_64-linux", "payload");
    const compiler = new DerivationCompiler(driver, {
      entryFile: "/workspace/tsix.config.ts",
      projectRoot: "/workspace",
      resolver: {
        resolvePackage: async (reference) =>
          resolved(reference.attrPath.join("-"), reference.output),
      },
    });
    const command = runCommand(
      { name: "greeting", system: "x86_64-linux", shell: bash, path: [hello] },
      sh`install ${payload} $out`,
    );

    await compiler.compileTarget(command);

    expect(driver.added).toHaveLength(1);
    const json = driver.added[0]!;
    expect(json.version).toBe(4);
    expect(json.outputs).toEqual({ out: {} });
    expect(Object.keys(json.inputs.drvs)).toHaveLength(3);
    expect(Object.keys(json.inputs.drvs)).toContain(`${"p".repeat(32)}-payload.drv`);
    expect(json.builder).toMatch(/-bash\/bin\/bash$/);
    expect(json.env.PATH).toMatch(/-hello\/bin$/);
  });

  it("preserves selected outputs of native dependencies", async () => {
    const driver = new FakeDriver();
    const shell = packageRef("nixpkgs", "x86_64-linux", "bash");
    const compiler = new DerivationCompiler(driver, {
      entryFile: "/workspace/tsix.config.ts",
      projectRoot: "/workspace",
      resolver: { resolvePackage: async () => resolved("bash") },
    });
    const dependency = derivation({
      name: "dependency",
      system: "x86_64-linux",
      builder: pathRef`${shell}/bin/bash`,
      args: ["-c", "touch $out $dev"],
      outputs: ["out", "dev"] as const,
    });
    const consumer = derivation({
      name: "consumer",
      system: "x86_64-linux",
      builder: pathRef`${shell}/bin/bash`,
      args: ["-c", sh`cp ${dependency.outputs.dev} $out`],
    });

    await compiler.compileTarget(consumer);

    const consumerJson = driver.added.at(-1)!;
    const input = Object.values(consumerJson.inputs.drvs).find(({ outputs }) =>
      outputs.includes("dev"),
    );
    expect(input?.outputs).toEqual(["dev"]);
  });

  it("tracks source references interpolated into shell scripts", async () => {
    const driver = new FakeDriver();
    const shell = packageRef("nixpkgs", "x86_64-linux", "bash");
    const projectRoot = resolve(".");
    const compiler = new DerivationCompiler(driver, {
      entryFile: resolve("tsix.config.ts"),
      projectRoot,
      resolver: { resolvePackage: async () => resolved("bash") },
    });
    const payload = source("README.md", { root: projectRoot });
    const consumer = runCommand(
      { name: "source-consumer", system: "x86_64-linux", shell },
      sh`install ${payload} $out`,
    );

    await compiler.compileTarget(consumer);

    expect(driver.added[0]!.inputs.srcs).toEqual([`${"s".repeat(32)}-README.md`]);
    expect(driver.added[0]!.args.at(-1)).toContain(`/nix/store/${"s".repeat(32)}-README.md`);
  });

  it("rejects untyped store paths", async () => {
    const driver = new FakeDriver();
    const shell = packageRef("nixpkgs", "x86_64-linux", "bash");
    const compiler = new DerivationCompiler(driver, {
      entryFile: "/workspace/tsix.config.ts",
      projectRoot: "/workspace",
      resolver: { resolvePackage: async () => resolved("bash") },
    });
    const value = derivation({
      name: "unsafe",
      system: "x86_64-linux",
      builder: shell,
      args: ["/nix/store/untyped-input"],
    });
    await expect(compiler.compileTarget(value)).rejects.toThrow("Raw Nix store paths");
  });

  it("rejects dependency cycles", async () => {
    const driver = new FakeDriver();
    const shell = packageRef("nixpkgs", "x86_64-linux", "bash");
    const compiler = new DerivationCompiler(driver, {
      entryFile: "/workspace/tsix.config.ts",
      projectRoot: "/workspace",
      resolver: { resolvePackage: async () => resolved("bash") },
    });
    const first = derivation({ name: "first", system: "x86_64-linux", builder: shell });
    const second = derivation({
      name: "second",
      system: "x86_64-linux",
      builder: shell,
      inputs: [first],
    });
    (first.spec as { inputs?: unknown }).inputs = [second];
    await expect(compiler.compileTarget(first)).rejects.toThrow("dependency cycle");
  });
});
