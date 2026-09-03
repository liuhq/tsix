#!/usr/bin/env node
import { build, check, lock, show, update } from "./index.js";

function usage(): never {
  console.error(`Usage:
  tsix [--config <file>] flake lock
  tsix [--config <file>] flake update [input...]
  tsix [--config <file>] flake show
  tsix [--config <file>] flake build <attr-path> [--out-link <path>]
  tsix [--config <file>] flake check`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let entry: string | undefined;
  if (args[0] === "--config") {
    if (args[1] === undefined) usage();
    entry = args[1];
    args.splice(0, 2);
  }
  if (args.shift() !== "flake") usage();
  const command = args.shift();
  const options = entry === undefined ? {} : { entry };
  if (command === "lock" && args.length === 0) return lock(options);
  if (command === "update") return update(args, options);
  if (command === "show" && args.length === 0) {
    console.log(JSON.stringify(await show(options), null, 2));
    return;
  }
  if (command === "check" && args.length === 0) return check(options);
  if (command === "build") {
    const target = args.shift();
    if (target === undefined) usage();
    let outLink: string | undefined;
    while (args.length !== 0) {
      const argument = args.shift();
      if (argument === "--out-link" && args[0] !== undefined) outLink = args.shift();
      else usage();
    }
    const paths = await build(target, outLink === undefined ? {} : { outLink }, options);
    paths.forEach((path) => console.log(path));
    return;
  }
  usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
