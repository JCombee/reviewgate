#!/usr/bin/env node
// A thin bin shim. A Node script, not a shell script: on Windows npm generates a
// .cmd shim around this itself, so the CLI works on all three platforms (§4, §15.9).
import { main } from "../dist/index.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`reviewgate: ${err?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
