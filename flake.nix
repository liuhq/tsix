{
  description = "tsix development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 pkgs.pnpm_11 ];
            shellHook = ''
              node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
              pnpm_major="$(pnpm --version | cut -d. -f1)"
              if [ "$node_major" != 24 ] || [ "$pnpm_major" != 11 ]; then
                echo "tsix requires Node 24 and pnpm 11" >&2
                return 1
              fi
            '';
          };
        });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
