import { defineFlake, defineNixosSystem, nix } from "@tsix/dsl";

const baseModule = nix.attrs({
  boot: { loader: { grub: { devices: ["/dev/vda"] } } },
  environment: { systemPackages: [nix.package("hello")] },
  fileSystems: { "/": { device: "/dev/vda1", fsType: "ext4" } },
  system: { stateVersion: "26.05" },
});

export default defineFlake({
  description: "A minimal tsix flake",
  inputs: {
    nixpkgs: { url: "github:NixOS/nixpkgs/nixos-unstable" },
  },
  nixosConfigurations: {
    demo: defineNixosSystem({
      system: "x86_64-linux",
      modules: [
        baseModule,
        nix.attrs({
          networking: { hostName: "demo" },
        }),
      ],
    }),
    secondary: defineNixosSystem({
      system: "x86_64-linux",
      modules: [baseModule, nix.attrs({ networking: { hostName: "secondary" } })],
    }),
  },
});
