# Changelog

All notable changes to ReviewGate are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Entries describe what changed for someone using the gate, not which files moved.

## [Unreleased]

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

[Unreleased]: https://github.com/JCombee/reviewgate/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/JCombee/reviewgate/releases/tag/v0.1.1
[0.1.0]: https://github.com/JCombee/reviewgate/releases/tag/v0.1.0
