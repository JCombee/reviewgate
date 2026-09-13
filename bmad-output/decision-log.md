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
