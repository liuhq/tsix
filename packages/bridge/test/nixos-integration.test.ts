import { basename, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  defaultValue,
  defineConfig,
  inputModule,
  localNixModule,
  module,
  nixosSystem,
  packageRef,
  pathRef,
  runCommand,
  sh,
} from "@tsix/core";
import { DerivationCompiler, NixDriver } from "@tsix/store";
import { LockManager, NixBridge, type Capsule } from "../src/index.js";

let capsule: Capsule | undefined;

afterEach(async () => capsule?.dispose());

it("bridges nixpkgs packages and native derivations into NixOS", { timeout: 60_000 }, async () => {
  const projectRoot = resolve(".");
  const entryFile = resolve("tsix.config.ts");
  const config = defineConfig({
    inputs: {
      nixpkgs: {
        url: "github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188?narHash=sha256-9i%2FVTdusq%2F%2BNM%2Ftz%2BJ1Re%2BojkMB8MBf0QshnYfzHz30%3D",
      },
    },
  });
  const driver = new NixDriver();
  const locks = new LockManager(driver, projectRoot);
  capsule = await locks.createCapsule(config.inputs, await locks.requireCurrent(config.inputs));
  const bridge = new NixBridge(driver, capsule);
  const compiler = new DerivationCompiler(driver, {
    entryFile,
    projectRoot,
    resolver: bridge,
  });
  const bash = packageRef("nixpkgs", "x86_64-linux", "bash");
  const native = runCommand(
    { name: "tsix-nixos-integration", system: "x86_64-linux", shell: bash },
    sh`echo bridged > $out`,
  );
  const definition = nixosSystem({
    nixpkgs: "nixpkgs",
    system: "x86_64-linux",
    modules: [
      inputModule("nixpkgs", "nixosModules.notDetected"),
      localNixModule("packages/bridge/test/fixtures/module", "default.nix"),
      module({
        boot: { loader: { grub: { devices: ["/dev/vda"] } } },
        fileSystems: { "/": { device: "/dev/vda1", fsType: "ext4" } },
        networking: { hostName: defaultValue("fallback") },
        systemd: {
          services: {
            "tsix-path": { serviceConfig: { ExecStart: pathRef`${native}/bin/runme` } },
            "tsix-script": { script: sh`test -e ${native}` },
          },
        },
        system: { stateVersion: "26.05" },
      }),
    ],
  });

  const nativeResolved = await compiler.compileTarget(native);
  const system = await bridge.instantiateNixos(definition, compiler, { entryFile, projectRoot });
  const recursive = await driver.execute(["derivation", "show", "-r", system.drvPath]);

  expect(recursive.stdout).toContain(basename(nativeResolved.drvPath));
  expect(system.outputPath).toContain("nixos-system-tsix-local");
});
