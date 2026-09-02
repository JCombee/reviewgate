---
name: release
description: Cut a ReviewGate release — update the CHANGELOG, bump every version, verify the build, then tag and publish. Use when the user asks to release, cut a version, ship a release, tag a version, or publish the binaries.
---

# Releasing ReviewGate

A release is a git tag. Pushing `v<x.y.z>` runs `.github/workflows/release.yml`, which
builds the five binaries and publishes them as a GitHub release. Everything below
exists to make sure that tag points at something worth shipping.

Work through the steps in order. Do not skip a verification because the change looks
small: the tag is what every user's `reviewgate update` will download.

## 1. Preflight

Stop and report if any of these fails; do not fix them silently.

```bash
git status --short                 # must be empty
git rev-parse --abbrev-ref HEAD    # must be main
git fetch origin && git status -sb # must be up to date with origin/main
gh auth status                     # must be logged in
gh run list --limit 3              # the last run on main must be green
```

A release is cut from `main` only. If the user asks for one from a branch, say that
the workflow only publishes tags and ask them to merge first.

## 2. Pick the version

```bash
git describe --tags --abbrev=0
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

Read the commits and choose:

- **patch** — fixes, docs, CI, installer changes; nothing new for the user to learn.
- **minor** — a new feature, a new command or flag, a new config key.
- **major** — a break: a removed command or flag, a changed config key, a changed hook
  contract.

Propose the version and the reason to the user in one line, then continue. Do not ask
them to choose unless the commits genuinely allow two readings.

## 3. Update the CHANGELOG

`CHANGELOG.md` is the deliverable here, not an afterthought — it comes before the
version bump and before the tag.

1. Turn `## [Unreleased]` into `## [<version>] - <YYYY-MM-DD>`, using today's date.
2. Add a fresh, empty `## [Unreleased]` above it.
3. Fold in anything from `git log` that is not represented yet, under
   `Added` / `Changed` / `Fixed` / `Removed` / `Documentation`.
4. Update the link definitions at the bottom: point `[Unreleased]` at
   `compare/v<version>...HEAD` and add a line for the new version.

Write for someone using the gate, not for someone reading the diff: what they can now
do, what stopped hurting, what they have to change on their side. Drop commits that
change nothing observable (a refactor, a test-only change) rather than padding the
list with them.

## 4. Bump every version

They must all agree — the workflow refuses a tag that disagrees with the root
`package.json`, and a plugin version that lags makes Claude Code think it is current.

| File | Field |
| --- | --- |
| `package.json` | `version` |
| `packages/core/package.json` | `version` |
| `packages/server/package.json` | `version` |
| `packages/cli/package.json` | `version` |
| `packages/web/package.json` | `version` |
| `plugin/.claude-plugin/plugin.json` | `version` |

Then sync the lockfile, which carries those versions too:

```bash
npm install --package-lock-only
```

The binary does not read any of these: its version comes from the tag through
`--define`. They matter for the workflow's guard, for the plugin, and for anyone
reading the repo.

## 5. Verify

```bash
npm run build
npm test
npm run typecheck
```

All three must pass. The suite spawns the built CLI, so the build genuinely has to
come first.

For a release that touches the server, the CLI or the web UI, also compile and run the
host binary — the compiled build is a different environment from `node dist/`, and
this is the cheapest place to catch that:

```bash
node scripts/build-binaries.mjs --version <version> --target bun-windows-x64   # or bun-linux-x64, bun-darwin-arm64
./release/reviewgate-win32-x64.exe --version
```

`release/` is gitignored, so nothing has to be cleaned up. Bun is only needed here and
in CI; say so if it is missing rather than installing it unasked.

## 6. Commit and push

One commit, carrying the CHANGELOG and every version bump:

```bash
git add CHANGELOG.md package.json package-lock.json packages/*/package.json plugin/.claude-plugin/plugin.json
git commit -m "release: v<version>"
git push origin main
```

Follow the repo's commit conventions for the trailers.

## 7. Tag and publish

Only after the commit is pushed:

```bash
git tag -a v<version> -m "v<version> — <one line from the CHANGELOG>"
git push origin v<version>
```

Then watch it through:

```bash
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
gh release view v<version> --json assets --jq '.assets[] | "\(.name) \(.size)"'
```

The release must carry ten assets: five binaries (`darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, `win32-x64.exe`) each with a `.sha256`.

## 8. Afterwards

Report to the user: the version, the release URL, and what an existing install has to
do — `reviewgate update` for the binary, and `claude plugin marketplace update
reviewgate` plus `claude plugin update reviewgate@reviewgate` when the release changed
the plugin's hook, command or skill.

If the machine has ReviewGate installed, confirm the release is really reachable:

```bash
reviewgate update --check
```

## When the workflow fails

Fix the cause on `main` and push it. Then:

- **No release was published** — the tag points at a broken commit and nothing
  downstream has seen it. Move it: `git tag -d v<version>`,
  `git push origin :refs/tags/v<version>`, re-tag on the fix, push again.
- **A release was published** — leave the tag alone, always. Cut the next patch
  version instead, starting again at step 2. A tag that users may already have
  downloaded never changes.
