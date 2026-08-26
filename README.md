# tsix

TypeScript-first, structured Nix flake generation. Phase 1 compiles a trusted
`defineFlake()` configuration into a self-contained `flake.nix` plus content-addressed
local assets. The public DSL deliberately has no raw Nix-code escape hatch.

## Development

The checked-in Nix flake is the authoritative toolchain definition (Node 24 and pnpm 11):

```sh
nix develop
pnpm install --frozen-lockfile
pnpm check
```

After the first dependency resolution, commit `pnpm-lock.yaml`; CI must always use
`--frozen-lockfile`.

## CLI

```sh
pnpm build
pnpm exec tsix build ./tsix.config.ts
pnpm exec tsix check ./tsix.config.ts
```

`build` writes `dist/tsix/flake.nix` and any copied files under `assets/`. Use `--stdout`
only for configurations that do not copy assets. `check` builds in a temporary directory
and runs `nix flake check --no-write-lock-file`.
Typescript ❤ Nix
