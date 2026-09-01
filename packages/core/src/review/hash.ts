import { createHash } from "node:crypto";

/**
 * `diffHash` = sha256 over de genormaliseerde patchtekst (§2).
 *
 * Genormaliseerd betekent: zonder index-regels en zonder de blob-hashes die per
 * checkout verschillen, en met CRLF platgeslagen. Twee keer dezelfde inhoud moet
 * dezelfde hash geven, ook op een andere machine — anders is het approval-artifact
 * waardeloos.
 */
export function diffHash(patch: string): string {
  return createHash("sha256").update(normalizePatch(patch), "utf8").digest("hex");
}

export function normalizePatch(patch: string): string {
  const out: string[] = [];
  for (const raw of patch.split(/\r?\n/)) {
    // "index 83db48f..bf269f4 100644" zegt niets over de inhoud van de wijziging.
    if (raw.startsWith("index ")) continue;
    out.push(raw);
  }
  // Afsluitende lege regels doen er niet toe.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
