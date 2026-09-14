# Changelog

All notable changes to ReviewGate are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Entries describe what changed for someone using the gate, not which files moved.

## [Unreleased]

## [0.3.0] - 2026-09-14

### Added

- The final review page now shows the ReviewGate logo and name, matching the system,
  light or dark theme.
- ReviewGate checks once a day whether a newer release is out. When one is, a button
  appears in the header; it opens the exact `reviewgate update` command to run, with a
  one-click copy.
- The repo's own `pre-commit` hook, if it has one, now runs before the review opens. A
  failing hook denies the commit immediately, before any review starts; a hook that
  rewrites files is reflected in the diff you review. Repos without a `pre-commit` hook
  are unaffected.
- `reviewgate update` now also updates the Claude Code plugin — the equivalent of
  `claude plugin marketplace update reviewgate` and `claude plugin update
  reviewgate@reviewgate` runs as part of the same command. A missing `claude` is
  reported rather than failing the binary update.
- Releases are published as drafts first and can be pulled by an authenticated
  maintainer via `reviewgate update --version <version>` with `GH_TOKEN` set, so a
  release can be tried through the real updater before it goes out to everyone.

### Removed

- Suggestions are no longer automatically dismissed as duplicates of ones from an
  earlier round. Every suggestion now stays until you resolve or dismiss it yourself.

## [0.2.0] - 2026-09-14

### Added

- The panel on the right now holds a second tab: every comment and suggestion in the
  review in one list, filtered by open, resolved, outdated or (for suggestions)
  dismissed, and grouped per file. Suggestions carry their own badge and severity color
  and never touch the approval gate. Clicking one takes you to the thread in the diff —
  it unfolds a collapsed file and opens the outdated section if that is where the
  comment lives.
- A review can now hold several independent, named chats instead of one flat thread,
  each with its own model — ask a fast model one thing and a stronger one another
  without losing either conversation.
- `npm run install:local` compiles the working tree and installs it over the reviewgate
  you already have, for anyone working on ReviewGate itself. With `--wrapper` it skips
  the compiler and installs a launcher that runs the checkout — the way in on WSL, where
  bun cannot compile a checkout that lives on a Windows drive.

### Changed

- Approving or requesting changes now replaces the whole screen with a plain decision
  message, instead of only swapping the footer while the diff and panels stayed
  underneath. It is now unambiguous that the review is done and the window can close.

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

[Unreleased]: https://github.com/JCombee/reviewgate/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/JCombee/reviewgate/releases/tag/v0.3.0
[0.2.0]: https://github.com/JCombee/reviewgate/releases/tag/v0.2.0
[0.1.2]: https://github.com/JCombee/reviewgate/releases/tag/v0.1.2
[0.1.1]: https://github.com/JCombee/reviewgate/releases/tag/v0.1.1
[0.1.0]: https://github.com/JCombee/reviewgate/releases/tag/v0.1.0
