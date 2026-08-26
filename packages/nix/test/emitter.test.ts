import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineFlake, defineNixosSystem, nix } from "@tsix/dsl";
import { copyAssets, emitExpression, emitFlake } from "../src/index.js";

async function fixture(): Promise<{ root: string; entry: string }> {
  const root = await mkdtemp(join(tmpdir(), "tsix-emitter-"));
  const entry = join(root, "tsix.config.ts");
  await writeFile(entry, "// fixture");
  return { root, entry };
}

describe("expression emitter", () => {
  it("keeps strings, derivations and paths semantically distinct", async () => {
    const { root, entry } = await fixture();
    const hello = nix.package("hello");
    expect(
      (await emitExpression(nix.str`plain`, { entryFile: entry, projectRoot: root })).nix,
    ).toBe('"plain"');
    expect(
      (await emitExpression(nix.str`${hello}/bin/hello`, { entryFile: entry, projectRoot: root }))
        .nix,
    ).toBe('"${pkgs.hello}/bin/hello"');
    expect(
      (
        await emitExpression(nix.path.preserve("./shared/file"), {
          entryFile: entry,
          projectRoot: root,
        })
      ).nix,
    ).toBe("./shared/file");
  });

  it("copies static and dynamic roots with content-addressed names", async () => {
    const { root, entry } = await fixture();
    await mkdir(join(root, "templates"));
    await writeFile(join(root, "templates", "one"), "hello");
    const dynamic = nix.path.from("./templates")`${nix.str`name`}/file`;
    const result = await emitExpression(dynamic, { entryFile: entry, projectRoot: root });
    expect(result.nix).toMatch(/^\.\/assets\/[a-f0-9]{16}-templates\/\$\{"name"\}\/file$/);
    expect(result.assets).toHaveLength(1);
  });

  it("preserves executable bits and deduplicates identical references", async () => {
    const { root, entry } = await fixture();
    const script = join(root, "install.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n");
    await chmod(script, 0o755);
    const result = await emitExpression(
      nix.list([nix.path("./install.sh"), nix.path("./install.sh")]),
      { entryFile: entry, projectRoot: root },
    );
    expect(result.assets).toHaveLength(1);
    const output = join(root, "output");
    await copyAssets(result.assets, output);
    const copied = join(output, "assets", result.assets[0]!.name);
    expect((await lstat(copied)).mode & 0o777).toBe(0o755);
    expect(await readFile(copied, "utf8")).toContain("exit 0");
  });

  it("changes the asset name when content changes", async () => {
    const { root, entry } = await fixture();
    await writeFile(join(root, "asset"), "one");
    const first = await emitExpression(nix.path("./asset"), {
      entryFile: entry,
      projectRoot: root,
    });
    await writeFile(join(root, "asset"), "two");
    const second = await emitExpression(nix.path("./asset"), {
      entryFile: entry,
      projectRoot: root,
    });
    expect(first.assets[0]!.name).not.toBe(second.assets[0]!.name);
  });

  it("rejects traversal and escaping symlinks", async () => {
    const { root, entry } = await fixture();
    await mkdir(join(root, "tree"));
    await symlink("/etc/passwd", join(root, "tree", "escape"));
    await expect(
      emitExpression(nix.path("../outside"), { entryFile: entry, projectRoot: root }),
    ).rejects.toThrow("cannot contain '..'");
    await expect(
      emitExpression(nix.path("./tree"), { entryFile: entry, projectRoot: root }),
    ).rejects.toThrow("escapes asset root");
    await expect(
      emitExpression(nix.path.preserve("../outside"), { entryFile: entry, projectRoot: root }),
    ).rejects.toThrow("cannot contain '..'");
  });
});

describe("flake emitter", () => {
  it("emits multiple inline nixosSystem configurations", async () => {
    const { root, entry } = await fixture();
    const module = nix.attrs({
      environment: { systemPackages: [nix.package("hello"), nix.package("gcc")] },
    });
    const flake = defineFlake({
      description: "two hosts",
      inputs: {
        nixpkgs: { url: "github:NixOS/nixpkgs/nixos-unstable" },
        home: { follows: "nixpkgs" },
      },
      nixosConfigurations: {
        alpha: defineNixosSystem({ system: "x86_64-linux", modules: [module] }),
        beta: defineNixosSystem({ system: "aarch64-linux", modules: [module] }),
      },
    });
    const result = await emitFlake(flake, { entryFile: entry, projectRoot: root });
    expect(result.nix).toContain('description = "two hosts";');
    expect(result.nix).toContain('home.follows = "nixpkgs";');
    expect(result.nix).toContain("alpha = nixpkgs.lib.nixosSystem");
    expect(result.nix).toContain("beta = nixpkgs.lib.nixosSystem");
    expect(result.nix).toContain("({ config, lib, pkgs, ... }:");
    expect(result.nix).toContain("systemPackages = [ pkgs.hello pkgs.gcc ];");
  });
});
