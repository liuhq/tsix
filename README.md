# tsix

tsix is a TypeScript frontend for the Nix store. Native tsix builds compile directly to
store derivation JSON and are registered with `nix derivation add`; tsix does not print a
Nix expression for them. A narrow evaluator bridge resolves existing nixpkgs packages and
evaluates existing NixOS modules.

TypeScript configuration is trusted host code. Reproducibility comes from typed store
references, explicit source inputs, and the committed `tsix.lock` input graph.

## Configuration

The default entry point is `tsix.config.ts`:

```ts
import { defineConfig, packageRef, pathRef, runCommand, sh, source } from "@tsix/core";

const system = "x86_64-linux";
const bash = packageRef("nixpkgs", system, "bash");
const coreutils = packageRef("nixpkgs", system, "coreutils");
const hello = packageRef("nixpkgs", system, "hello");

const greeting = runCommand(
  { name: "greeting", system, shell: bash, path: [hello] },
  sh`hello > $out`,
);

export default defineConfig({
  inputs: { nixpkgs: { url: "github:NixOS/nixpkgs/nixos-unstable" } },
  packages: { [system]: { default: greeting, hello } },
});
```

`derivation()` is the lower-level interface. Builders, arguments and environment strings
accept typed `source()`, package, derivation and output references. Use `pathRef` to address
a path inside a store object and `sh` for shell scripts; interpolated references are retained
structurally and become derivation dependencies automatically:

```ts
const executable = pathRef`${source("./tool")}/bin/runme`;
const install = runCommand(
  { name: "install", system, shell: bash, path: [coreutils] },
  sh`install ${executable} $out/bin/runme`,
);
```

`sh` interpolation is deliberately not shell-escaped. Bare commands such as `install` are
provided explicitly through `path`; only typed interpolations are dependency-tracked. Raw
`/nix/store` strings are rejected because they lose dependency information.

NixOS configurations use `nixosSystem()` and `module()`. Existing modules can be imported
with `inputModule()` or `localNixModule()`. TypeScript modules support option assignments
and the `defaultValue()`, `force()`, `before()` and `after()` merge wrappers; arbitrary Nix
functions remain in imported `.nix` modules.

See [tsix.config.ts](./tsix.config.ts) for a native package that uses nixpkgs dependencies
and is also consumed by a NixOS configuration.

## CLI

tsix intentionally does not create a project `flake.nix`. Flake-style operations live under
the tsix CLI:

```sh
pnpm build
pnpm exec tsix flake lock
pnpm exec tsix flake show
pnpm exec tsix flake build packages.x86_64-linux.default
pnpm exec tsix flake check
pnpm exec tsix flake update nixpkgs
```

Use `--config <file>` before `flake` to select another entry point. `flake check` instantiates
all packages and NixOS configurations, then builds every declared check. Building a NixOS
closure is explicit:

```sh
pnpm exec tsix flake build nixosConfigurations.demo
```

Requirements: Nix 2.23 or newer with `nix-command` and `flakes`, Node 24, and pnpm 11.
The derivation JSON interface is experimental in Nix, so all protocol handling is isolated
behind the versioned store driver.

## Development

The checked-in development flake provides Node and pnpm; it is separate from `tsix.lock`:

```sh
nix develop
pnpm install --frozen-lockfile
pnpm check
```
