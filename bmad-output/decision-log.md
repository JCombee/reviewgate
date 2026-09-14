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
