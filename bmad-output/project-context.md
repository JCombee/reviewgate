# Project Context — ReviewGate

> The project **constitution**. This document is loaded by every BMAD planning skill
> so they all share the same ground truth. Keep it tight, current, and authoritative.
> When a major decision changes scope, update this file and append the change to
> `decision-log.md`.

- **Track:** quick-flow  _(quick-flow | bmad-method | enterprise)_
- **Created:** 2026-09-13T16:20:35Z

---

## Project Goal

ReviewGate is a local, browser-based code review gate for Claude Code: a PreToolUse
hook intercepts every `git commit`, opens a diff review UI, and blocks the commit
until a human explicitly approves or requests changes. Done and successful means the
gate stays impossible for the agent to bypass while the review experience (diff view,
comments, chat with a read-only reviewer, suggestions) stays fast and low-friction
enough that developers don't disable it.

## Primary Users

Individual developers using Claude Code who want a mandatory human checkpoint before
any commit an agent makes. Single-machine, single-user by design — everything runs on
`127.0.0.1`, no accounts, no hosting.

## Scope

Four packages: `core` (domain model, git access, diff parsing, the hook itself),
`server` (Hono API + SSE + the read-only Claude Agent SDK reviewer), `cli`
(`reviewgate open/serve/status/hook/update`), `web` (the React review UI). Plus the
Claude Code plugin package (`plugin/`) that wires the hook and a `/review` command in,
and the release tooling that ships single-file per-platform binaries.

## Core Constraints

- The gate must hold under every Claude Code permission mode, including
  `--dangerously-skip-permissions` — this is the product's core guarantee and no
  feature should weaken it.
- Everything runs locally on `127.0.0.1`; no data leaves the machine beyond what the
  reviewer assistant itself sends to Claude.
- The AI "reviewer assistant" (chat panel, automatic suggestion pass) is read-only by
  design — restricted to `Read`/`Grep`/`Glob`, explicitly no `Edit`/`Write`/`Bash` —
  so it can never change code out from under a review in progress.
- Cross-platform: macOS, Linux, Windows (including WSL), distributed as
  self-contained binaries via Bun, with npm/tsc as the source-build path.
- No database, no queues, no external storage — review state is one JSON file per
  review under `.git/reviewgate/reviews/<id>.json`.

## Non-Goals

- Not a hosted/multi-user code review tool (no accounts, no team dashboards).
- Not a general-purpose AI coding assistant — the built-in reviewer never edits code.
- Not aiming to replace GitHub/GitLab PR review; this gates local commits before they
  ever reach a remote.

## Key Stakeholders / Roles

One builder (Jerke Combee) — solo project, decides, builds, and reviews. Quick Flow
track: tech-spec + stories only, no PRD/architecture overhead expected for the
feature-sized work currently planned.

## Glossary

- **Review** — one review session tied to a diff scope (staged/working/amend/range),
  containing rounds, comments, suggestions, and chat.
- **Round** — one commit attempt / re-review cycle within a Review; each round has a
  diff hash, a commit message, and eventually a Decision.
- **Decision** — `approve` | `request_changes` | `timeout`, recorded per round.
- **Comment** — reviewer feedback, scoped `global` | `line` | `commit_message`, kind
  `issue` | `question`; drives the Approve/Request-changes button state via its
  `open`/`resolved`/`outdated` status.
- **Suggestion** — an AI-proposed comment (`severity`: blocker/consideration/nit) that
  a human can accept (promoting it to a Comment), dismiss, or reopen.
- **Anchor** — the mechanism (`anchorSnippet`) that re-locates a comment's line across
  diff rounds as the underlying code changes.

---

## Decision Thread

Running decisions live in [`decision-log.md`](./decision-log.md). The first entry is
the track choice from initialization. Consult it before making decisions that might
contradict earlier ones.

## Planning Status (count-based)

- **Track:** quick-flow
- **Stories defined:** _(updated by sprint-planning / story creation)_
- **Stories remaining:** _(count-based delivery — no points, no velocity)_

_This document plans the work. Implementation is handed to external dev tools via
ready-for-dev story files; the planning plugin never writes or tests application code._
