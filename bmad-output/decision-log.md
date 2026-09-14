# Decision Log — ReviewGate

A threaded, append-only record of decisions made across BMAD planning workflows.
Every later skill (brief, PRD, architecture, stories) appends here so the reasoning
behind the plan stays visible and consistent.

**How to use:** add a new entry at the top of the log (newest first). Never rewrite
or delete past entries — supersede them with a new entry that references the old one.

## Entry format

```
### YYYY-MM-DD — <short title>
- **Decision:** <what was decided>
- **Rationale:** <why; alternatives considered>
- **Made by:** <skill/workflow, e.g. bmad-init, prd, architecture>
- **Supersedes:** <link to prior entry, if any>
```

---

### 2026-09-14 — Round 2 build: all 5 stories implemented and merged across 3 waves
- **Decision:** Built all 5 `ready-for-dev` stories from the wave plan below via isolated
  git-worktree dev agents (one per story, `general-purpose` subagent, full tool access),
  in wave order: Wave 1 {4.1, 5.1} → Wave 2 {5.2, 6.1} → Wave 3 {7.1}, merging each wave
  into `main` before starting the next. Final state: all 5 stories `done`, `main` at
  `1ea871d`, full suite green (25 test files / 319 tests) and typecheck clean after each
  wave's merge.
- **Rationale / notable deviations from a clean build:**
  - Commit signing: the repo's configured commit-signing path (SSH signing via a
    Windows-side 1Password binary) is unreachable from this sandboxed environment —
    plain `git commit` fails outright (`fatal: failed to write commit object`), not a
    silent unsigned commit. The user explicitly authorized `--no-gpg-sign` for this
    session's build commits after two rounds of confirmation; every commit in this build
    (dev-agent commits and my own merge commits) used it under that authorization. This
    is a session-scoped exception, not a standing policy change.
  - Two of five worktrees (5.1, 7.1) started from a stale base behind `main`'s actual tip
    and had to be synced mid-flight (rebase for 5.1, merge for 7.1) before their story
    work could safely land — resolved by each dev agent, verified by full test+typecheck
    after.
  - A recurring, unrelated sandbox restriction (`.claude/skills/release/SKILL.md` is
    read-only inside worktrees) corrupted that one file's content in two worktrees' sync
    commits. Fixed at merge time via git plumbing (`commit-tree` with a manually
    corrected tree) rather than a normal `git merge`, keeping `main`'s version of that
    file untouched — the fix never touched the restricted path directly, only rebuilt
    the git object graph around it.
  - `npm run typecheck`'s root script (`tsc -b --noEmit ...`) hit a real but pre-existing
    TypeScript build-mode limitation (`TS6310: Referenced project ... may not disable
    emit`) whenever a referenced composite project's build cache was invalidated by a
    story's changes (6.1, 7.1 both touched `packages/core`). Not a code defect — running
    a plain `npm run build:ts` first (which `npm test`'s `pretest` already does) refreshes
    the cache and the typecheck passes clean. Flagged here since it will recur for any
    future change to `packages/core`/`packages/server` and is worth fixing in the script
    itself at some point (out of scope for this build).
  - Cleanup of the 5 agent worktrees (`git worktree remove`/`prune`) fails on every one
    with `Device or resource busy`, including two unrelated pre-existing stale entries —
    a filesystem/sandbox-level lock, not caused by any specific worktree's content. Left
    as a known non-blocking loose end; all branches are already merged into `main`.
- **Made by:** 5 dev-agent subagents (implementation) + orchestrator (merge, conflict
  resolution, verification)
- **Supersedes:** none (extends the story-planning entry below)

### 2026-09-14 — Round 2 stories authored, audited, and sequenced into a 3-wave build plan
- **Decision:** Compiled the 5 Round 2 story files (4.1, 5.1, 5.2, 6.1, 7.1) via parallel
  `story-author` subagents (one per epic), ran `scope-conflict-check.sh` across the full
  backlog, ran independent `readiness-auditor` passes over all 5 stories, fixed the
  findings (added a missing `Shared/contended` flag + conflict-cluster note to both
  Story 5.1's and Story 7.1's Owned File/Module Scope sections for `packages/core/src/index.ts`,
  corrected a stale claim in Story 6.1's Dev Notes, corrected `epics.md`'s Notes section
  to document the 5.1↔6.1↔7.1 `index.ts` 3-way conflict cluster it was previously
  missing), flipped all 5 stories' Status to `ready-for-dev`, and ran
  `build-dependency-graph.py` + `plan-parallel-waves.py` (backed by a new
  `sprint-status.yaml` marking Epics 1-3 `done` and Epics 4-7 `ready-for-dev`) to produce
  `bmad-output/parallelization-plan.md`: **Wave 1** = {4.1, 5.1} · **Wave 2** = {5.2, 6.1}
  · **Wave 3** = {7.1}.
- **Rationale:** All 5 stories are semantically independent; the 3-wave split exists
  solely to avoid file-level conflicts caught by the tool (`App.tsx` between 4.1/5.2, and
  a 3-way `packages/core/src/index.ts` export-barrel conflict among 5.1/6.1/7.1) and one
  explicit dependency (5.2 needs 5.1's endpoint to exist). Independent audits before
  flipping status to `ready-for-dev` caught two real documentation gaps (5.1 and 7.1 both
  under-flagged the `index.ts` conflict) that the story-author agents and my own
  `epics.md` edit had missed — worth the audit pass's cost.
- **Made by:** bmad-epics-and-stories (story compilation) + readiness-auditor (audit) +
  bmad-parallel-plan (wave sequencing)
- **Supersedes:** none (extends the 2026-09-14 tech-spec entry below)

### 2026-09-14 — Tech spec Round 2: four issue-backlog epics scoped
- **Decision:** Updated `bmad-output/tech-spec.md` to v2.0, adding FR-007..FR-010 and a
  "Round 2" problem/solution covering four GitHub issues, each scoped as its own epic:
  final-page branding (#15), a daily cached update check with an in-app prompt (#14),
  running the repo's `pre-commit` hook before the review UI opens (#7), and removing the
  suggestion cross-round duplicate-suppression mechanism (#3). Added Story List rows
  10-14 (bringing the running total to 14, within the Quick Flow ceiling of 15).
- **Rationale:** All four issues are independent of Round 1's (done) chat/comments work
  and of each other — none share a file or module — so scoping them as separate epics
  keeps each story small and lets all four be built in parallel. Fixing tech-spec.md in
  place (rather than starting a second document) keeps a single source of truth per the
  project's Quick Flow track.
- **Made by:** bmad-tech-spec (Update intent)
- **Supersedes:** none (extends the 2026-09-13 tech spec entry)

### 2026-09-13 — Epics and stories sharded from the tech spec
- **Decision:** Sharded `tech-spec.md`'s 9-story list into `bmad-output/epics.md` (3 epics:
  Multiple Chats, Per-Chat Model, Suggestions-in-Comments) and 9 ready-for-dev story files
  under `bmad-output/stories/`. Epic 1's stories are ordered by layer (data model → server
  → API → UI), each `Blocked-by` the previous; Epic 2 is `Blocked-by` Epic 1 (needs the
  `Chat` type and per-chat agent map); Epic 3 is fully independent of Epics 1-2.
- **Rationale:** The scope-conflict checker confirmed every same-file overlap in the
  backlog (`api.ts`, `session.ts`, `app.ts`, `ChatPanel.tsx`, `CommentsPanel.tsx`) is
  already covered by an explicit `Blocked-by` link, so no story pair sharing a file is
  ever scheduled in parallel; stories with disjoint scope (e.g. Epic 3 vs. Epics 1-2) may
  run concurrently.
- **Made by:** bmad-epics-and-stories
- **Supersedes:** none

### 2026-09-13 — Tech spec: chat/model/suggestions merge scoping
- **Decision:** Scoped three features into `bmad-output/tech-spec.md`: (1) multiple
  named chats per review (`review.chat` → `review.chats`), (2) a per-chat model field
  threaded into the SDK's `Options.model`, one `ReviewAgent` per chat id instead of one
  per review, and (3) suggestions merged into `CommentsPanel.tsx`'s grouped list as a
  visually distinct row kind, without changing the `Comment`/`Suggestion` types or the
  approval-gate logic.
- **Rationale:** Model selection uses a fixed curated alias list (not free text, not a
  live SDK query) to keep the security surface small and avoid an extra round-trip.
  Chats need fully independent SDK sessions since sharing one session across chats would
  leak context between unrelated threads. Suggestions stay a separate type from Comment
  so they can never silently affect the Approve/Request-changes gate — only accepted
  suggestions (already promoted via the existing `acceptSuggestion` flow) count, exactly
  as today.
- **Made by:** bmad-tech-spec
- **Supersedes:** none

### 2026-09-13 — Track selected: quick-flow
- **Decision:** Initialized this project on the **quick-flow** track.
- **Rationale:** Solo builder (one person, no teams to coordinate), no
  compliance/infra requirements, and the near-term work is estimated at roughly
  1–15 stories (a handful of focused features/enhancements) rather than a full
  product slice — a tech-spec plus stories is sufficient without a PRD or
  architecture doc. User confirmed the suggested default directly.
- **Made by:** bmad-init
- **Supersedes:** none
