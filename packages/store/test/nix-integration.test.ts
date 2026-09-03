import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { derivation, pathRef, sh, source } from "@tsix/core";
import { DerivationCompiler, NixDriver } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

it(
  "registers and builds a derivation without evaluating Nix source",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tsix-native-test-"));
    temporaryDirectories.push(root);
    const builder = join(root, "builder.sh");
    await writeFile(builder, '#!/bin/sh\necho native-ok > "$out"\n');
    await chmod(builder, 0o755);
    const entryFile = join(root, "tsix.config.ts");
    await writeFile(entryFile, "// test fixture\n");

    const driver = new NixDriver();
    await driver.assertCompatible();
    const compiler = new DerivationCompiler(driver, {
      entryFile,
      projectRoot: root,
      resolver: { resolvePackage: () => Promise.reject(new Error("unexpected package")) },
    });
    const target = derivation({
      name: "tsix-native-integration",
      system: "x86_64-linux",
      builder: source("./builder.sh"),
    });

    const resolved = await compiler.compileTarget(target);
    const [output] = await driver.build(`${resolved.drvPath}^out`, { noLink: true });
    const repeated = await new DerivationCompiler(driver, {
      entryFile,
      projectRoot: root,
      resolver: { resolvePackage: () => Promise.reject(new Error("unexpected package")) },
    }).compileTarget(target);

    expect(output).toBe(resolved.outputPath);
    expect(repeated).toEqual(resolved);
    expect(await readFile(output!, "utf8")).toBe("native-ok\n");
  },
);

it("registers multiple output placeholders", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tsix-native-test-"));
  temporaryDirectories.push(root);
  const builder = join(root, "builder.sh");
  await writeFile(builder, '#!/bin/sh\necho runtime > "$out"\necho development > "$dev"\n');
  await chmod(builder, 0o755);
  const entryFile = join(root, "tsix.config.ts");
  await writeFile(entryFile, "// test fixture\n");
  const driver = new NixDriver();
  const compiler = new DerivationCompiler(driver, {
    entryFile,
    projectRoot: root,
    resolver: { resolvePackage: () => Promise.reject(new Error("unexpected package")) },
  });
  const target = derivation({
    name: "tsix-multi-integration",
    system: "x86_64-linux",
    builder: source("./builder.sh"),
    outputs: ["out", "dev"] as const,
  });

  const resolved = await compiler.compileTarget(target);
  const shown = await driver.showDerivation(resolved.drvPath);
  await driver.build(`${resolved.drvPath}^*`, { noLink: true });

  expect(await readFile(shown.outputs.out!, "utf8")).toBe("runtime\n");
  expect(await readFile(shown.outputs.dev!, "utf8")).toBe("development\n");
});

it("builds with source paths tracked through tagged templates", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tsix-template-test-"));
  temporaryDirectories.push(root);
  const builder = join(root, "builder.sh");
  await writeFile(builder, '#!/bin/sh\nset -eu\neval "$1"\n');
  await chmod(builder, 0o755);
  await mkdir(join(root, "payload"));
  await writeFile(join(root, "payload", "message.txt"), "tracked-template-ok\n");
  const entryFile = join(root, "tsix.config.ts");
  await writeFile(entryFile, "// test fixture\n");

  const driver = new NixDriver();
  const compiler = new DerivationCompiler(driver, {
    entryFile,
    projectRoot: root,
    resolver: { resolvePackage: () => Promise.reject(new Error("unexpected package")) },
  });
  const payload = source("./payload");
  const message = pathRef`${payload}/message.txt`;
  const target = derivation({
    name: "tsix-template-integration",
    system: "x86_64-linux",
    builder: source("./builder.sh"),
    args: [sh`while IFS= read -r line; do printf '%s\\n' "$line"; done < ${message} > "$out"`],
  });

  const resolved = await compiler.compileTarget(target);
  const [output] = await driver.build(`${resolved.drvPath}^out`, { noLink: true });

  expect(await readFile(output!, "utf8")).toBe("tracked-template-ok\n");
});
