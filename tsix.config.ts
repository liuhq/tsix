import { defineConfig, module, nixosSystem, packageRef, runCommand, sh } from "@tsix/core";

const system = "x86_64-linux";
const bash = packageRef("nixpkgs", system, "bash");
const coreutils = packageRef("nixpkgs", system, "coreutils");
const hello = packageRef("nixpkgs", system, "hello");

const greeting = runCommand(
  {
    name: "tsix-greeting",
    system,
    shell: bash,
    path: [coreutils, hello],
  },
  sh`mkdir -p $out/bin; hello > $out/message`,
);

export default defineConfig({
  inputs: {
    nixpkgs: {
      url: "github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188?narHash=sha256-9i%2FVTdusq%2F%2BNM%2Ftz%2BJ1Re%2BojkMB8MBf0QshnYfzHz30%3D",
    },
  },
  packages: {
    [system]: {
      default: greeting,
      hello,
    },
  },
  checks: {
    [system]: { greeting },
  },
  nixosConfigurations: {
    demo: nixosSystem({
      nixpkgs: "nixpkgs",
      system,
      modules: [
        module({
          boot: { loader: { grub: { devices: ["/dev/vda"] } } },
          environment: { systemPackages: [hello, greeting] },
          fileSystems: { "/": { device: "/dev/vda1", fsType: "ext4" } },
          networking: { hostName: "demo" },
          system: { stateVersion: "26.05" },
        }),
      ],
    }),
  },
});
