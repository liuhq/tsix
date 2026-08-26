#!/usr/bin/env node
import { build, check } from "./index.js";

function usage(): never {
  console.error(
    "Usage: tsix build <entry> [--out-dir <dir> | --stdout]\n       tsix check <entry>",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, entry, ...args] = process.argv.slice(2);
  if ((command !== "build" && command !== "check") || entry === undefined) usage();
  if (command === "check") {
    if (args.length !== 0) usage();
    await check(entry);
    return;
  }
  let outDirectory: string | undefined;
  let stdout = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--stdout") stdout = true;
    else if (argument === "--out-dir" && args[index + 1] !== undefined)
      outDirectory = args[++index];
    else usage();
  }
  if (stdout && outDirectory !== undefined) usage();
  const output = await build(entry, {
    ...(outDirectory === undefined ? {} : { outDirectory }),
    stdout,
  });
  if (stdout) process.stdout.write(output);
  else console.log(output);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
