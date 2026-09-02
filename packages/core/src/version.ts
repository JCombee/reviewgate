/**
 * The version of this build.
 *
 * The release build replaces `__REVIEWGATE_VERSION__` with the tag it is cutting
 * (`bun build --define`). A build from source has no such define, and `typeof` on an
 * undeclared identifier is the one safe way to notice that without a ReferenceError.
 */
declare const __REVIEWGATE_VERSION__: string;

export const VERSION: string =
  typeof __REVIEWGATE_VERSION__ === "string" ? __REVIEWGATE_VERSION__ : "0.0.0-dev";

/** The GitHub repo releases are cut from; the updater and the update check read it. */
export const REPO = "JCombee/reviewgate";
