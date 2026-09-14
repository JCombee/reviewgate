# Epics — ReviewGate

> The epic MAP. A thin index, not a context object. Each epic lists its goal, the
> requirements it covers (cited to tech-spec.md), its ordered stories, and cross-epic
> dependencies. Story detail lives in the individual {epic}.{story}.{slug}.story.md files.
>
> Track: Quick Flow
> Sources: tech-spec.md (this track has no separate prd.md/architecture.md)

---

## Epic 1: Multiple Chats

**Goal:** A reviewer can hold and switch between more than one independent chat thread
per review.

**In scope (cited):**
- FR-001 — Multiple chats per review [Source: tech-spec.md#fr-001-multiple-chats-per-review-must]
- FR-002 — Switch between chats [Source: tech-spec.md#fr-002-switch-between-chats-must]
- FR-004 — New chat creation [Source: tech-spec.md#fr-004-new-chat-creation-and-optionally-closingrenaming-should]

**Architecture touchpoints:** `packages/core/src/review/types.ts` (data model), `packages/server/src/session.ts` (per-chat `ReviewAgent` map), `packages/server/src/app.ts` + `packages/web/src/lib/reviewClient.ts` (chat-id-aware API), `packages/web/src/components/ChatPanel.tsx` + `packages/web/src/App.tsx` (chat switcher UI) [Source: tech-spec.md#technical-approach]

**Out of scope:** Per-chat model selection (Epic 2). Suggestion display (Epic 3). Cross-chat search/merge (tech-spec Out of Scope).

**Stories (ordered):**

| ID | Slug | Intent | Status |
|------|------|--------|--------|
| 1.1 | chats-data-model | Replace `review.chat` with `review.chats` + legacy migration | ready-for-dev |
| 1.2 | server-chat-map | One `ReviewAgent` per chat id in `Session` | ready-for-dev |
| 1.3 | chat-api-routes | Chat-id-aware API routes + SSE `chatId` tagging | ready-for-dev |
| 1.4 | chat-switcher-ui | Web chat switcher UI in `ChatPanel.tsx`/`App.tsx` | ready-for-dev |

**Cross-epic dependencies:**
- Blocked by: none (foundational epic)
- Blocks: Epic 2 (per-chat model needs the `Chat` type and chat-id plumbing from this epic)

---

## Epic 2: Per-Chat Model

**Goal:** A reviewer can choose which Claude model answers a given chat, independent of
other chats in the same review.

**In scope (cited):**
- FR-003 — Per-chat model selection [Source: tech-spec.md#fr-003-per-chat-model-selection-must]

**Architecture touchpoints:** `packages/server/src/agent.ts` (`AgentContext`/`Options.model`), `packages/server/src/session.ts` (pass chat's `model` when constructing its `ReviewAgent`), `packages/web/src/components/ChatPanel.tsx` (model picker) [Source: tech-spec.md#technical-approach]

**Out of scope:** Live SDK model discovery/listing (tech-spec uses a fixed curated alias list, not a live query) [Source: tech-spec.md#assumptions].

**Stories (ordered):**

| ID | Slug | Intent | Status |
|------|------|--------|--------|
| 2.1 | agent-model-option | Thread `model` through `AgentContext`/`ReviewAgent` options | ready-for-dev |
| 2.2 | model-picker-ui | Model picker UI bound to the active chat | ready-for-dev |

**Cross-epic dependencies:**
- Blocked by: Epic 1 — needs the `Chat` type (with its `model` field) and the per-chat `ReviewAgent` map to exist first
- Blocks: none

---

## Epic 3: Suggestions-in-Comments

**Goal:** Suggestions from the automatic review pass appear in the same list as real
comments, visually distinguishable, without affecting the approval gate.

**In scope (cited):**
- FR-005 — Suggestions appear in the comments list [Source: tech-spec.md#fr-005-suggestions-appear-in-the-comments-list-must]
- FR-006 — Suggestions never affect the approval gate [Source: tech-spec.md#fr-006-suggestions-in-the-list-never-affect-the-approverequest-changes-gate-must]

**Architecture touchpoints:** `packages/web/src/components/CommentsPanel.tsx` (merged row grouping), `packages/web/src/components/SuggestionCard.tsx` (reused visual treatment/actions) [Source: tech-spec.md#technical-approach]

**Out of scope:** Removing suggestions from their existing inline rendering in `Overview.tsx`/the diff view (tech-spec assumption: additive, not a replacement) [Source: tech-spec.md#assumptions].

**Stories (ordered):**

| ID | Slug | Intent | Status |
|------|------|--------|--------|
| 3.1 | merge-suggestion-rows | Merge suggestions into `CommentsPanel.tsx`'s grouped list | ready-for-dev |
| 3.2 | suggestion-row-rendering | Suggestion row rendering + actions reused from `SuggestionCard.tsx` | ready-for-dev |
| 3.3 | suggestion-filter-semantics | Filter tab behavior for suggestions (Open/All/Resolved/Outdated analogues) | ready-for-dev |

**Cross-epic dependencies:**
- Blocked by: none (independent of chat work; touches different files)
- Blocks: none

---

## Epic 4: Final Page Branding

**Goal:** A reviewer landing on the final (post-decision) page sees the ReviewGate mark
and name, not plain text.

**In scope (cited):**
- FR-007 — Logo + app name on the final page [Source: tech-spec.md#fr-007-logo--app-name-on-the-final-page-should]

**Architecture touchpoints:** `packages/web/src/App.tsx` (the `decision != null` branch's
`<Centered>` block only), `packages/web/public/logo-dark.svg` / `logo-light.svg`
(existing assets, reused as-is), `packages/web/src/styles.css` (existing `data-theme`
switching pattern, reused as-is) [Source: tech-spec.md#final-page-brand-mark-round-2--packageswebsrcapptsx]

**Out of scope:** Any change to the approve/request-changes status wording; any new
logo asset (reuses the existing pair).

**Stories (ordered):**

| ID | Slug | Intent | Status |
|------|------|--------|--------|
| 4.1 | final-page-logo | Render the logo + "ReviewGate" name in the final-page block | backlog |

**Cross-epic dependencies:**
- Blocked by: none
- Blocks: none
- **Same-file note:** Story 4.1 and Story 5.2 both touch `App.tsx` (different regions —
  the decision branch vs. the header mount point for the update prompt). Not schedulable
  in the same parallel wave; safe to merge sequentially (see `parallelization-plan.md`
  once generated).

---

## Epic 5: Update Checks

**Goal:** A reviewer sees, inside the web UI they already use daily, that a newer
ReviewGate release exists — checked at most once per day — and can get the update
command with one click.

**In scope (cited):**
- FR-008 — Daily, cached update check with an in-app prompt [Source: tech-spec.md#fr-008-daily-cached-update-check-with-an-in-app-prompt-must]

**Architecture touchpoints:** `packages/cli/src/commands/update.ts` (`latestTag`/
`isNewer`/`VERSION` relocated to a shared module), `packages/server/src/app.ts` (new
`GET /api/update-check` route), `packages/server/src/lockfile.ts` (`stateDir(gitDir)`
reused for the cached-result file), `packages/web/src/lib/reviewClient.ts` (client call),
new `packages/web/src/components/UpdatePrompt.tsx`, `packages/web/src/App.tsx` (mount
point only) [Source: tech-spec.md#update-check-endpoint-round-2--shared-logic--packagesserversrcappts]

**Out of scope:** Auto-installing the update; any change to `reviewgate update`'s own
CLI behavior beyond relocating shared logic.

**Stories (ordered):**

| ID | Slug | Intent | Status |
|------|------|--------|--------|
| 5.1 | update-check-endpoint | Relocate `latestTag`/`isNewer`; add cached `GET /api/update-check` | backlog |
| 5.2 | update-prompt-ui | Web `UpdatePrompt.tsx`: button → modal → copy-to-clipboard | backlog |

**Cross-epic dependencies:**
- Blocked by: none (5.2 is Blocked-by 5.1 within the epic)
- Blocks: none
- **Same-file note:** see Epic 4 — Story 5.2 shares `App.tsx` with Story 4.1 (mount
  point only, disjoint region).

---

## Epic 6: Hook Ordering

**Goal:** The repo's own `pre-commit` hook runs before the review UI opens, so the
diff a human reviews matches what will actually be committed, and a doomed commit is
denied before any review time is spent.

**In scope (cited):**
- FR-009 — Run local git hooks before opening the review UI [Source: tech-spec.md#fr-009-run-local-git-hooks-before-opening-the-review-ui-must]

**Architecture touchpoints:** `packages/cli/src/commands/hook.ts` (`decide()`), a new
hook-runner helper (likely `packages/core/src/hook/`, exported via
`packages/core/src/index.ts`), `NodeGitClient`/`loadConfig` (existing, reused for
`core.hooksPath` / cwd resolution) [Source: tech-spec.md#pre-commit-hook-runner-round-2--packagesclisrccommandshookts-packagescoresrchook]

**Out of scope:** Moving `commit-msg` or any other hook earlier; changing the
`--no-verify` denial path itself (the new denial reuses the same `Verdict` shape).

**Stories (ordered):**

| ID | Slug | Intent | Status |
|------|------|--------|--------|
| 6.1 | precommit-hook-runner | Run `pre-commit` before diff capture; deny early on failure | backlog |

**Cross-epic dependencies:**
- Blocked by: none
- Blocks: none (fully independent — touches only `cli`'s hook command and a new `core`
  hook-runner module, disjoint from every other epic's files)

---

## Epic 7: Suggestion Dedupe Removal

**Goal:** An automatic suggestion pass no longer suppresses a finding because it
resembles one dismissed in an earlier round.

**In scope (cited):**
- FR-010 — Remove suggestion "remembering" (cross-round duplicate suppression) [Source: tech-spec.md#fr-010-remove-suggestion-remembering-cross-round-duplicate-suppression-must]

**Architecture touchpoints:** `packages/core/src/review/suggestions.ts`
(`findDuplicate`/`similarity`/`normalize`/`words`/`rangesOverlap`/`DedupeConfig`/
`DEFAULT_DEDUPE` removed; `addSuggestions` simplified), `packages/core/src/config.ts`
(`dedupe` field removed from `ReviewGateConfig`/`DEFAULT_CONFIG`/`mergeConfig`),
`packages/web/src/components/SuggestionCard.tsx` (`auto`/`auto_duplicate` handling
simplified) [Source: tech-spec.md#suggestion-dedupe-removal-round-2--packagescoresrcreviewsuggestionsts]

**Out of scope:** Any change to `applyCap`, severity ordering, or the
accept/dismiss/reopen lifecycle — only the dedupe step is removed.

**Stories (ordered):**

| ID | Slug | Intent | Status |
|------|------|--------|--------|
| 7.1 | remove-suggestion-dedupe | Delete dedupe logic + config field + UI handling | backlog |

**Cross-epic dependencies:**
- Blocked by: none
- Blocks: none (fully independent — touches only `suggestions.ts`, `config.ts`, and
  `SuggestionCard.tsx`, disjoint from every other epic's files)

---

## Delivery Tracking (count-based)

No story points, velocity, or burndown. Track by COUNT only:

- Total stories: 14
- Done: 9 (Epics 1-3, Round 1 — shipped)
- Remaining: 5 (Epics 4-7, Round 2 — backlog)
- Completion rate: 9/14

## Notes

Epic 1 is foundational for Epic 2 (the `Chat.model` field and per-chat `ReviewAgent` map
are introduced in Epic 1's stories and only *used* by Epic 2). Epic 3 is fully independent
and can be built in parallel with Epics 1-2 — it touches only `CommentsPanel.tsx` and
`SuggestionCard.tsx`, disjoint from the chat-related files (confirmed by the scope-conflict
check below). Within Epic 1, stories are ordered by layer (data model → server → API → UI)
per the sizing rule's "split by layer" heuristic, each Blocked-by the previous.

**Round 2 (Epics 4-7):** four independent epics, one per source GitHub issue (#15, #14,
#7, #3 respectively). None share a file or module with Epics 1-3 (all `done`). Epics 4,
5, 6, and 7 are mutually independent and may all build in parallel, with two exceptions:

1. Story 4.1 and Story 5.2 both touch `packages/web/src/App.tsx` (disjoint regions — the
   final-page block vs. the header mount point) and so cannot share a parallel wave under
   the blunt file-level scope-conflict rule, even though they don't semantically collide.
   Story 5.2 is additionally `Blocked-by` Story 5.1 within Epic 5.
2. `packages/core/src/index.ts` is a shared export barrel touched by three otherwise
   unrelated stories — Story 5.1 (adds `latestTag`/`isNewer`/`LatestTag` exports), Story
   6.1 (adds `runPreCommitHook`/`PreCommitOutcome` exports), and Story 7.1 (removes the
   dedupe-related exports) — forming a 3-way file-level conflict cluster (5.1↔6.1,
   5.1↔7.1, 6.1↔7.1). Confirmed by `scope-conflict-check.sh` across the full backlog.
   None of the three pairs may share a parallel wave, even though the edits are disjoint
   regions of the same file and carry no semantic dependency on each other.
