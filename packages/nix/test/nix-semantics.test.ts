import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("Nix distinguishes path/string and propagates string context", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsix-nix-semantics-"));
  await writeFile(join(root, "asset"), "asset");
  const expression = `let
    drv = derivation { name = "context-test"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "echo ok > $out" ]; };
    plain = "plain";
    fromDrv = "\${drv}/bin/tool";
    pathValue = ./asset;
    fromPath = "\${pathValue}";
  in {
    plainType = builtins.typeOf plain;
    pathType = builtins.typeOf pathValue;
    plainContext = builtins.getContext plain;
    drvContext = builtins.getContext fromDrv;
    pathContext = builtins.getContext fromPath;
  }`;
  const { stdout } = await execute("nix", ["eval", "--impure", "--json", "--expr", expression], {
    cwd: root,
  });
  const result = JSON.parse(stdout) as Record<string, unknown>;
  expect(result.plainType).toBe("string");
  expect(result.pathType).toBe("path");
  expect(result.plainContext).toEqual({});
  expect(Object.keys(result.drvContext as object)).toHaveLength(1);
  expect(Object.keys(result.pathContext as object)).toHaveLength(1);
});
