#!/usr/bin/env node
// Dunne bin-shim. Node-script, geen shellscript: npm genereert hier op Windows
// zelf een .cmd-shim omheen, dus de CLI werkt op alle drie de platforms (§4, §15.9).
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
