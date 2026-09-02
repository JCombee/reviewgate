/**
 * The web build, embedded in the binary.
 *
 * A stub in a source checkout: the server then reads the assets from
 * `packages/web/dist` instead. `scripts/embed-web.mjs` overwrites this file with the
 * real thing right before the release build, so a single-file binary carries the UI
 * with it and needs nothing on disk.
 *
 * Generated file. Do not edit by hand.
 */
export const EMBEDDED_WEB_ASSETS: Readonly<Record<string, string>> = {};
