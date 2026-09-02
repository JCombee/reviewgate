import { createHash } from "node:crypto";

/**
 * `diffHash` = sha256 over the normalised patch text (§2).
 *
 * Normalised means: without index lines and without the blob hashes that differ per
 * checkout, and with CRLF flattened. The same content twice has to give the same
 * hash, on another machine too — otherwise the approval artifact is worthless.
 */
export function diffHash(patch: string): string {
  return createHash("sha256").update(normalizePatch(patch), "utf8").digest("hex");
}

export function normalizePatch(patch: string): string {
  const out: string[] = [];
  for (const raw of patch.split(/\r?\n/)) {
    // "index 83db48f..bf269f4 100644" says nothing about the content of the change.
    if (raw.startsWith("index ")) continue;
    out.push(raw);
  }
  // Trailing empty lines do not matter.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
