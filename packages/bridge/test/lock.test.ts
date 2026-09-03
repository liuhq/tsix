import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NixDriver, type CommandResult, type ExecuteOptions } from "@tsix/store";
import { LockManager } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

class LockDriver extends NixDriver {
  readonly calls: string[][] = [];

  override async execute(
    args: readonly string[],
    options: ExecuteOptions = {},
  ): Promise<CommandResult> {
    this.calls.push([...args]);
    if (args[0] === "--version") return { stdout: "nix (Nix) 2.35.2\n", stderr: "" };
    if (args[0] === "flake" && options.cwd !== undefined) {
      await writeFile(
        join(options.cwd, "flake.lock"),
        `${JSON.stringify({ version: 7, root: "root", nodes: { root: { inputs: {} } } })}\n`,
      );
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
}

describe("tsix lock", () => {
  it("writes and reloads a versioned lock atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsix-lock-test-"));
    temporaryDirectories.push(root);
    const driver = new LockDriver();
    const manager = new LockManager(driver, root);
    const inputs = { nixpkgs: { url: "github:NixOS/nixpkgs/nixos-unstable" } };

    const lock = await manager.lock(inputs);

    expect(lock.version).toBe(1);
    expect(await manager.requireCurrent(inputs)).toEqual(lock);
    expect(JSON.parse(await readFile(join(root, "tsix.lock"), "utf8"))).toEqual(lock);
  });

  it("rejects stale locks and unknown update inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsix-lock-test-"));
    temporaryDirectories.push(root);
    const manager = new LockManager(new LockDriver(), root);
    await manager.lock({ nixpkgs: { url: "github:NixOS/nixpkgs/one" } });

    await expect(
      manager.requireCurrent({ nixpkgs: { url: "github:NixOS/nixpkgs/two" } }),
    ).rejects.toThrow("stale");
    await expect(
      manager.update({ nixpkgs: { url: "github:NixOS/nixpkgs/two" } }, ["missing"]),
    ).rejects.toThrow("Unknown input");
  });

  it("passes selected inputs to nix flake update", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsix-lock-test-"));
    temporaryDirectories.push(root);
    const driver = new LockDriver();
    const manager = new LockManager(driver, root);
    const inputs = { nixpkgs: { url: "github:NixOS/nixpkgs/nixos-unstable" } };
    await manager.lock(inputs);

    await manager.update(inputs, ["nixpkgs"]);

    expect(driver.calls).toContainEqual(["flake", "update", "nixpkgs"]);
  });
});
