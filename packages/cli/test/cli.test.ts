import { describe, expect, it } from "vitest";
import { defineConfig, packageRef } from "@tsix/core";
import { findTarget, listTargets } from "../src/index.js";

describe("CLI target discovery", () => {
  const target = packageRef("nixpkgs", "x86_64-linux", "hello");
  const config = defineConfig({
    packages: { "x86_64-linux": { "hello.debug": target } },
  });

  it("lists target paths and implementation kinds", () => {
    expect(listTargets(config)).toEqual([
      {
        path: "packages.x86_64-linux.hello.debug",
        kind: "nixpkgs",
        system: "x86_64-linux",
      },
    ]);
  });

  it("resolves dotted target names", () => {
    expect(findTarget(config, "packages.x86_64-linux.hello.debug")).toEqual({
      kind: "build",
      value: target,
    });
  });

  it("rejects unknown targets", () => {
    expect(() => findTarget(config, "packages.x86_64-linux.missing")).toThrow("Unknown target");
  });
});
