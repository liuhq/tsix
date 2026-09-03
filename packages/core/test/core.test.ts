import { describe, expect, it } from "vitest";
import {
  defineConfig,
  derivation,
  packageRef,
  pathRef,
  runCommand,
  sh,
  source,
} from "../src/index.js";

describe("core configuration", () => {
  it("creates a branded top-level configuration", () => {
    const config = defineConfig({ inputs: { nixpkgs: { url: "github:NixOS/nixpkgs" } } });
    expect(config.tsixConfig).toBe(true);
    expect(config.packages).toEqual({});
  });

  it("creates typed multi-output references", () => {
    const drv = derivation({
      name: "multi",
      system: "x86_64-linux",
      builder: source("./builder"),
      outputs: ["out", "dev"] as const,
    });
    expect(drv.out.output).toBe("out");
    expect(drv.outputs.dev.output).toBe("dev");
  });

  it("builds runCommand from explicit shell and path tools", () => {
    const bash = packageRef("nixpkgs", "x86_64-linux", "bash");
    const hello = packageRef("nixpkgs", "x86_64-linux", "hello");
    const command = runCommand(
      { name: "hello", system: "x86_64-linux", shell: bash, path: [hello] },
      sh`hello > $out`,
    );
    expect(command.spec.builder).toMatchObject({ tsixKind: "path-ref", suffix: "/bin/bash" });
    expect(command.spec.env?.PATH).toMatchObject({ tsixKind: "shell-script" });
  });

  it("creates store-relative paths and dependency-aware shell scripts", () => {
    const input = source("./input");
    const executable = pathRef`${input}/bin/runme`;
    const prefix = sh`install ${executable}`;
    const script = sh`${prefix} /dest ${2} ${true} ${null}`;

    expect(executable).toEqual({ tsixKind: "path-ref", root: input, suffix: "/bin/runme" });
    expect(script.parts).toEqual(["install ", executable, " /dest ", "2", " ", "true", " "]);
  });

  it("validates store-relative path templates", () => {
    const input = source("./input");
    expect(() => pathRef`prefix-${input}`).toThrow("must start");
    expect(() => pathRef`${input}suffix`).toThrow("start with /");
    expect(() => pathRef`${input}/../escape`).toThrow("remain within");
    expect(
      () =>
        // @ts-expect-error pathRef accepts exactly one interpolation.
        pathRef`${input}/${input}`,
    ).toThrow("exactly one");
    expect(
      () =>
        // @ts-expect-error pathRef requires a typed reference.
        pathRef`${"plain"}/bin`,
    ).toThrow("typed store reference");
  });

  it("requires runCommand scripts to use sh at runtime", () => {
    const bash = packageRef("nixpkgs", "x86_64-linux", "bash");
    expect(() =>
      runCommand(
        { name: "invalid", system: "x86_64-linux", shell: bash },
        // @ts-expect-error Shell scripts must retain their template structure.
        "echo invalid",
      ),
    ).toThrow("sh template tag");
  });

  it("rejects invalid output names", () => {
    expect(() =>
      derivation({
        name: "bad",
        system: "x86_64-linux",
        builder: source("./builder"),
        outputs: ["bad/output"],
      }),
    ).toThrow("Invalid derivation output name");
  });
});
