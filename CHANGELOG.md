# Changelog

All notable changes to ReviewGate are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Entries describe what changed for someone using the gate, not which files moved.

## [Unreleased]

### Fixed

- A build from source now serves the web assets next to it, so `npm run build:web` is
  all a checkout needs to see its own UI. A leftover embed — `embed-web.mjs` runs as
  part of building a binary and overwrites a file in the tree — used to shadow that
  build silently, and `REVIEWGATE_WEB_DIST` could not override it either, though it
  said it could. A binary still serves only the copy compiled into it.

- The gate kept waiting after you approved or requested changes. The hook waited for
  the browser launcher to finish, and a launcher does not finish until the browser it
  started closes. The review page said the commit could go through, while Claude Code
  sat on a hook that had not started watching for a decision yet. ReviewGate now
  starts the browser detached and never waits on it.
- A decision reaches the commit within milliseconds. The hook watches the review file
  instead of only reading it every 400 milliseconds, and it flushes its verdict and
  exits rather than waiting for the last timer, socket or subprocess to finish.

## [0.1.2] - 2026-09-03

### Fixed

- The chat and the automatic pass failed in the released binaries with "Native CLI
  binary for linux-x64 not found". The Agent SDK looked for its own CLI in a
  `node_modules` that a single-file binary does not have. ReviewGate now uses the
  `claude` on your machine, found on the `PATH` or in the native installer's
  locations, and `REVIEWGATE_CLAUDE_PATH` points it elsewhere. Without a `claude` the
  chat says which one it is missing instead of talking about npm.

## [0.1.1] - 2026-09-02

### Fixed

- Approving took about 25 seconds to reach the commit. The verdict was on stdout at
  once, but the open review page kept a heartbeat timer pending in the hook's process,
  and Claude Code waits for that process to end. Approve now lands in a fraction of a
  second.
- The Windows installer read the published checksum as a byte array instead of text,
  so a perfectly good download failed on a checksum mismatch.
- Both installers hid the output of the plugin step, which turned a failed clone into
  a confusing "marketplace not found" further down.

### Documentation

- The README covers what the install script does per platform, which asset each
  platform gets, how to update the plugin next to the binary, and how to remove both.
- Cutting a release is a documented skill (`.claude/skills/release`), and this
  changelog exists. The release workflow refuses a tag that any manifest disagrees
  with, or that the changelog has never heard of.

## [0.1.0] - 2026-09-02

The first release, and the first one you can install without a checkout.

### Added

- A PreToolUse hook that intercepts `git commit`, opens the diff in the browser and
  blocks until you approve or request changes. The deny holds in every permission
  mode, so the agent cannot get around it.
- A review UI with syntax highlighting, unified and split view, comments at line and
  range level, questions, an editable commit message, and keyboard navigation.
- A read-only assistant that does a review pass on open and places its findings as
  suggestions, plus a chat panel that answers questions about the change.
- Several review rounds per commit attempt, with comments anchored to their new lines
  and marked outdated when the line is gone.
- `.reviewgate.json` for timeouts, ignored paths, the automatic pass and the theme.
- A single self-contained binary per platform, published on GitHub releases with a
  SHA-256 beside it, plus install scripts for macOS, Linux and Windows.
- `reviewgate update` to replace the binary with the newest release, checksum
  verified.
- The Claude Code plugin: the `PreToolUse` hook, the `/review` command and the
  `reviewgate` skill.

[Unreleased]: https://github.com/JCombee/reviewgate/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/JCombee/reviewgate/releases/tag/v0.1.2
[0.1.1]: https://github.com/JCombee/reviewgate/releases/tag/v0.1.1
[0.1.0]: https://github.com/JCombee/reviewgate/releases/tag/v0.1.0
