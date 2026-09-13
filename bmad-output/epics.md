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

## Delivery Tracking (count-based)

No story points, velocity, or burndown. Track by COUNT only:

- Total stories: 9
- Done: 0
- Remaining: 9
- Completion rate: 0/9

## Notes

Epic 1 is foundational for Epic 2 (the `Chat.model` field and per-chat `ReviewAgent` map
are introduced in Epic 1's stories and only *used* by Epic 2). Epic 3 is fully independent
and can be built in parallel with Epics 1-2 — it touches only `CommentsPanel.tsx` and
`SuggestionCard.tsx`, disjoint from the chat-related files (confirmed by the scope-conflict
check below). Within Epic 1, stories are ordered by layer (data model → server → API → UI)
per the sizing rule's "split by layer" heuristic, each Blocked-by the previous.
