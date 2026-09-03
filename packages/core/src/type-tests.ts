import {
  derivation,
  packageRef,
  pathRef,
  runCommand,
  sh,
  source,
  type OutputRef,
  type PathRef,
} from "./index.js";

const multi = derivation({
  name: "multi",
  system: "x86_64-linux",
  builder: source("./builder"),
  outputs: ["out", "dev"] as const,
});

const development: OutputRef<"dev"> = multi.outputs.dev;

// @ts-expect-error The derivation did not declare a documentation output.
const documentation = multi.outputs.doc;

const developmentHeaders: PathRef = pathRef`${multi.outputs.dev}/include`;
const bash = packageRef("nixpkgs", "x86_64-linux", "bash");

const invalidScript = runCommand(
  { name: "valid", system: "x86_64-linux", shell: bash },
  sh`test -d ${developmentHeaders}`,
);

runCommand(
  { name: "invalid", system: "x86_64-linux", shell: bash },
  // @ts-expect-error runCommand requires a dependency-aware shell template.
  "test -d /tmp",
);

// @ts-expect-error pathRef requires a typed store reference.
const invalidPathRoot = pathRef`${"plain string"}/bin`;

// @ts-expect-error pathRef permits exactly one interpolation.
const invalidPathInterpolation = pathRef`${multi}/bin/${"tool"}`;

void development;
void documentation;
void developmentHeaders;
void invalidScript;
void invalidPathRoot;
void invalidPathInterpolation;
