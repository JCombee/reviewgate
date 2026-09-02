/**
 * The entry point of the compiled binary.
 *
 * `bun build --compile` bundles from source, so it starts here rather than at
 * bin/reviewgate.mjs, which reads the tsc output.
 */
import { main } from "./index.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const e = err as { stack?: string };
    process.stderr.write(`reviewgate: ${e?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
