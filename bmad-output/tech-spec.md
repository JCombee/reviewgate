# Technical Specification: ReviewGate — Chat & Comments Enhancements

**Date:** 2026-09-13
**Author:** Jerke Combee (with Claude Code)
**Version:** 1.0
**Track:** Quick Flow (1-15 stories)
**Status:** Draft

> **Quick Flow track** — this document replaces a separate PRD and architecture file for
> small-scope work. If scope grows beyond ~15 stories, migrate to the BMad Method track
> (bmad-prd + bmad-architecture) before continuing.

---

## Related Documents

- Project context: `bmad-output/project-context.md`
- Decision log: `bmad-output/decision-log.md`
- Brownfield scan: `bmad-output/project-documentation.md`

---

## Problem & Solution

### Problem Statement

The review UI's conversation and suggestion surfaces are more rigid than the review
workflow needs:

1. A review has exactly one flat chat thread (`review.chat: ChatMessage[]`). A reviewer
   who wants to hold two separate lines of discussion (e.g. "why is this file structured
   this way" vs. "walk me through the auth change") has to interleave both in one thread,
   losing context as the conversation grows.
2. The reviewer assistant always runs on the SDK's default model. There's no way to pick
   a faster/cheaper model for a quick question or a stronger model for a deep dive — the
   choice made once at server-start (implicitly, by omission) applies to every chat.
3. `review.suggestions` (AI-proposed findings from the automatic pass) and
   `review.comments` (real reviewer feedback) render in two disconnected places: comments
   in `CommentsPanel.tsx`, suggestions inline in `Overview.tsx`/via `SuggestionCard`. A
   reviewer scanning "everything waiting for my attention" via the comments list misses
   pending suggestions entirely unless they also scroll the diff.

### Proposed Solution

1. Turn `review.chat` into `review.chats: Chat[]`, each an independently named thread
   with its own message list, so a reviewer can start, switch between, and close
   multiple concurrent conversations with the assistant.
2. Give each `Chat` a `model` field (a Claude model id/alias, or `null` for "server
   default") that is threaded into the `ReviewAgent`'s SDK `Options.model` for every
   `ask()` call made in that chat's context, and exposed as a picker in the chat UI.
3. Extend `CommentsPanel.tsx`'s existing grouped list to also render
   `review.suggestions`, tagged with a small "Suggestion" badge, dashed-border styling,
   and severity color already established in `SuggestionCard.tsx` — reusing the same
   accept/dismiss/discuss actions in place, without duplicating look-and-feel rules.

### Goals

- A reviewer can open more than one chat per review and pick up any of them later
  without losing history.
- A reviewer can choose which model answers a given chat, per chat, without changing
  any server configuration.
- The comments panel becomes the single place to see everything waiting for a decision
  (comments AND suggestions), while suggestions remain unambiguously non-binding.

---

## Scope

### In Scope

- Data model: replace `review.chat` with `review.chats` (list of named threads with a
  per-chat model field); migration of any existing single-thread review state.
- Server: chat-id-aware endpoints and `ReviewAgent`/`Session` changes to run one SDK
  session per chat, with per-chat model selection passed to the SDK.
- Web UI: a chat list/switcher, a "new chat" action, a model picker per chat, and
  suggestions merged into `CommentsPanel.tsx`'s existing grouped, filterable list.

### Out of Scope

- Cross-chat search or merging chat histories.
- Persisting a user-level "favorite model" preference across reviews (each chat's model
  choice is local to that chat; no global settings surface is added).
- Changing how the automatic suggestion *pass* itself runs (still one pass per round,
  unaffected by chat model choice) — only how its output is *displayed*.
- Any change to the read-only tool restriction (`Read`/`Grep`/`Glob` only) on the
  reviewer assistant — model choice affects which model reasons, not what it can touch.

---

## Requirements

### Functional Requirements

#### FR-001: Multiple chats per review [MUST]

A review can hold more than one chat thread. Each thread has its own ordered message
list and is independently addressable.

**Acceptance Criteria:**
- Starting a new chat does not alter or clear any existing chat's messages.
- Sending a message in one chat streams tokens (`chat-token` SSE event) without
  appending to any other chat's message list.
- A review created before this feature (single flat `chat` array) opens without error,
  with its existing messages visible as one thread (see Data Model migration note).

#### FR-002: Switch between chats [MUST]

The reviewer can see a list of existing chats and switch the visible thread without
losing scroll position expectations or in-flight streaming state of the others.

**Acceptance Criteria:**
- The chat panel shows a list/selector of chats (at minimum: a title and message count
  or last-activity indicator).
- Switching chats while a different chat is mid-stream does not drop or misattribute
  the streamed tokens once the reviewer switches back.

#### FR-003: Per-chat model selection [MUST]

Each chat can be configured to use a specific Claude model, independent of other chats
in the same review.

**Acceptance Criteria:**
- A model picker is visible in the chat UI, offering at least the server-default option
  plus a small fixed list of known aliases (e.g. `sonnet`, `opus`, `fable`, `haiku`).
- Changing the model for a chat applies to the next message sent in that chat; it does
  not retroactively change already-streamed answers.
- If a chosen model id is invalid or unavailable, the chat surfaces the SDK's error
  (via the existing `AgentUnavailable` path) rather than silently falling back.

#### FR-004: New chat creation and (optionally) closing/renaming [SHOULD]

A reviewer can start a new, empty chat from the panel at any time.

**Acceptance Criteria:**
- "New chat" creates a chat with no messages and the server-default model.
- New chats appear immediately in the chat switcher (FR-002).
- Renaming/closing a chat is a nice-to-have; if not delivered, chats may be identified
  by an auto-generated title (e.g. first question's opening words) with no fallback.

#### FR-005: Suggestions appear in the comments list [MUST]

`CommentsPanel.tsx`'s grouped list includes both `review.comments` and
`review.suggestions`, grouped and ordered consistently with how comments are grouped
today (general / commit message / per file, in diff order).

**Acceptance Criteria:**
- A pending or dismissed suggestion appears in the same file/section group as a comment
  on the same file would.
- Suggestions are visually distinguishable at a glance (badge + dashed border + severity
  color, consistent with `SuggestionCard.tsx`'s existing treatment) — a reviewer must
  never mistake a suggestion row for a binding comment.
- Suggestions in the list keep their existing actions (Accept / Dismiss / Discuss /
  Reopen) rather than exposing comment-only actions (Resolve/Reopen-as-comment) on them.
- The existing filter tabs (Open/All/Resolved/Outdated) either gain suggestion-aware
  filtering (pending/dismissed as analogues of open/resolved) or suggestions always show
  under a clearly separate filter state — pick whichever keeps the filter semantics
  from becoming confusing; document the choice made during implementation.

#### FR-006: Suggestions in the list never affect the Approve/Request-changes gate [MUST]

**Acceptance Criteria:**
- Rendering suggestions in `CommentsPanel.tsx` does not change `openComments()` or any
  other logic that gates the action button — only accepted suggestions (already promoted
  to real `Comment`s via the existing `acceptSuggestion` flow) count toward that gate,
  exactly as today.

### Non-Functional Requirements

#### Performance

No new performance budget is introduced. Multiple concurrent chats each hold their own
SDK session (`resume` id); the existing `MAX_TRANSCRIPT_CHARS`/`MAX_DIFF_CHARS` caps in
`agent.ts` continue to apply per chat's first message, unchanged.

#### Security

No change to the reviewer assistant's tool sandboxing
(`allowedTools: ["Read","Grep","Glob"]`, explicit `disallowedTools`). Model selection is
restricted to a fixed, server-defined list of aliases — the UI must not accept an
arbitrary free-text model string forwarded uninspected to the SDK, to avoid surprising
API/billing behavior from a typo or a malicious value if the UI is ever scripted.

#### Accessibility / Compliance

Not applicable beyond ReviewGate's existing single-user, local-only posture (see
`project-context.md` — no accounts, no hosting, no compliance scope).

#### Other

Backward compatibility: reviews persisted before this change have `chat: ChatMessage[]`
on disk. The server must read old review JSON and migrate it in memory (and on next
save) into `chats: [{ id, title, model: null, messages: [...] }]` — a single migrated
chat, so no history is lost and no manual migration step is required of the user.

---

## Technical Approach

### Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Domain model | TypeScript types in `packages/core/src/review/types.ts` | `ChatMessage` stays; a new `Chat` wrapper type is added, `Review.chat` → `Review.chats` |
| Server | Hono routes in `packages/server/src/app.ts`, `Session`/`ReviewAgent` in `packages/server/src/session.ts` / `agent.ts` | chat-id becomes a route/method parameter; one `ReviewAgent` (and one SDK `resume` session) per chat instead of one per review |
| SDK | `@anthropic-ai/claude-agent-sdk` `^0.3.252` | `Options.model?: string` already exists — no SDK upgrade needed |
| Web UI | React 19 components in `packages/web/src/components/` | `ChatPanel.tsx` gains a chat switcher + model picker; `CommentsPanel.tsx` gains suggestion rows reusing `SuggestionCard.tsx`'s visual language |

### Architecture Overview

Today, `Session` (server/src/session.ts) owns exactly one `ReviewAgent` for the whole
review, created once in `Session.start`/`Session.resume` with a single SDK `resume`
session id tracked by `ReviewAgent#sessionId`. `chat(message)` always talks to that one
agent and appends to the single `review.chat` array.

The change makes `Session` own a **map of `ReviewAgent` instances keyed by chat id**,
lazily created on first use, each tracking its own `#sessionId` (so each chat truly is
an independent SDK conversation) and constructed with the model recorded on that `Chat`.
`review.chats` becomes the source of truth for which chat ids exist, their titles, their
model, and their messages; the automatic suggestion pass (`runReviewPass`) is unaffected
— it already uses its own one-off `ask()` call and does not live inside a named chat.

On the web side, `App.tsx`'s single `streaming: string | null` state becomes keyed by
chat id (e.g. `Record<string, string>`) so token streams from different chats never
collide; `ChatPanel.tsx` receives the active chat id plus a list of chat summaries for
the switcher, and gains a model `<select>` bound to the active chat.

`CommentsPanel.tsx` keeps its existing `groupComments`-based structure but the grouping
function accepts a merged list of `{ kind: "comment", data: Comment } | { kind:
"suggestion", data: Suggestion }` rows instead of `Comment[]` only, and `CommentRow`
gains a sibling `SuggestionRow` (or `CommentRow` becomes polymorphic) that renders the
suggestion badge/border/severity styling already defined in `SuggestionCard.tsx`.

### Key Components

#### `Chat` type (new) — `packages/core/src/review/types.ts`

**Purpose:** Represent one independent conversation thread within a review.

**Responsibilities:**
- Hold an id, a display title, an optional model override, and its ordered messages.
- Replace the review-wide `chat: ChatMessage[]` field with `chats: Chat[]`.

**Interfaces / Contracts:**
```ts
export interface Chat {
  id: string;
  title: string;
  /** null = use the server default model. */
  model: string | null;
  messages: ChatMessage[];
  createdAt: string;
}
// Review.chat: ChatMessage[]  →  Review.chats: Chat[]
```

---

#### `Session` chat-map — `packages/server/src/session.ts`

**Purpose:** Own one `ReviewAgent` per chat id instead of one per review.

**Responsibilities:**
- Lazily create a `ReviewAgent` per chat id on first message, passing that chat's
  `model` into the agent's constructor/options.
- Route `chat(chatId, message)` to the right agent and append to the right `Chat`'s
  `messages`.
- Provide `createChat(title?)` / (optionally) `renameChat`/`closeChat`.

**Interfaces / Contracts:**
- `chat(chatId: string, message: string): Promise<Review>`
- `createChat(title?: string, model?: string | null): Promise<Review>`

---

#### `ReviewAgent` model option — `packages/server/src/agent.ts`

**Purpose:** Let a chat's chosen model reach the SDK call.

**Responsibilities:**
- Accept `model?: string | null` in `AgentContext` (or as a constructor param).
- Include it in `#options()`'s returned `Options` object as `model` when non-null.

**Interfaces / Contracts:**
- `#options(executable)` gains: `...(this.context.model ? { model: this.context.model } : {})`.

---

#### `ChatPanel.tsx` switcher + model picker — `packages/web/src/components/ChatPanel.tsx`

**Purpose:** Let the reviewer see, switch, and create chats, and pick a model per chat.

**Responsibilities:**
- Render a compact chat list/tabs above the message thread.
- Render a model `<select>` (fixed alias list + "default") bound to the active chat.
- Keep the existing "Ask the author" comment-conversion action scoped to the active
  chat's current draft, unchanged in behavior.

**Interfaces / Contracts:**
- New props: `chats: Chat[]`, `activeChatId: string`, `onSelectChat`, `onNewChat`,
  `onChangeModel(chatId, model)`.

---

#### `CommentsPanel.tsx` merged rows — `packages/web/src/components/CommentsPanel.tsx`

**Purpose:** Show suggestions alongside comments in one scannable list.

**Responsibilities:**
- Merge `review.comments` and `review.suggestions` before grouping, tagging each row
  with its kind.
- Render suggestion rows with the existing `SuggestionCard` visual markers (badge,
  dashed border, severity color) and existing suggestion actions.

**Interfaces / Contracts:**
- `groupComments` (or a renamed `groupRows`) accepts `ReviewRow[]` where
  `ReviewRow = { kind: "comment"; comment: Comment } | { kind: "suggestion"; suggestion: Suggestion }`.

### Data Model

`packages/core/src/review/types.ts`:

- Add `Chat` (see above).
- `Review.chat: ChatMessage[]` → `Review.chats: Chat[]`.
- No changes to `Comment` or `Suggestion` shapes — Feature 3 is presentation-only on the
  web side plus a merge step in `CommentsPanel.tsx`; no new persisted field is needed to
  tell a suggestion from a comment because they are already distinct types/arrays.
- Migration: wherever review JSON is loaded from disk (`packages/core`'s store/load
  path), detect a legacy `chat: ChatMessage[]` field and wrap it into
  `chats: [{ id: <generated>, title: "Chat", model: null, messages: chat, createdAt:
  <round 1's or file's timestamp> }]` before the rest of the app ever sees the review.

### API Design

`packages/server/src/app.ts`:

- `POST /api/review/:id/chat` → `POST /api/review/:id/chats/:chatId/messages`
  (or keep one route and add `chatId` to the JSON body — either is acceptable; a path
  param is more RESTful and keeps SSE event payloads consistent with chat-id tagging).
- New: `POST /api/review/:id/chats` — create a chat (`{ title?, model? }`), returns the
  updated `Review`.
- New (optional, FR-004 SHOULD): `PATCH /api/review/:id/chats/:chatId` — rename or
  change model without sending a message.
- SSE (`GET /api/review/:id/events`): the `chat-token` event gains a `chatId` field so
  the client can route streamed tokens to the right chat's streaming buffer.

### Error Handling Strategy

Unchanged pattern: `AgentUnavailable` surfaces to the chat UI as today (the SDK/model
error becomes the message shown in that chat). An invalid/rejected model id is expected
to arrive as an `AgentUnavailable`-wrapped SDK error (per `agent.ts`'s existing catch-all
in `ask()`) rather than needing new error types — model validation is enforced up front
in the UI (fixed alias list) rather than requiring server-side alias validation.

---

## Story List

| # | Epic | Story Title | Notes |
|---|------|-------------|-------|
| 1 | Multiple Chats | Replace `review.chat` with `review.chats` + legacy migration | Core data model change; touches core types and the review load path |
| 2 | Multiple Chats | Server: one `ReviewAgent` per chat id in `Session` | `session.ts` chat-map, `createChat`/`chat(chatId, message)` |
| 3 | Multiple Chats | API: chat-id-aware chat routes + SSE `chatId` tagging | `app.ts` routes, `reviewClient.ts` client, SSE payload shape |
| 4 | Multiple Chats | Web: chat switcher UI in `ChatPanel.tsx` | List/tabs of chats, "new chat" action, per-chat streaming state in `App.tsx` |
| 5 | Per-Chat Model | Thread `model` through `AgentContext`/`ReviewAgent` options | `agent.ts` change plus wiring from `Session`'s chat map |
| 6 | Per-Chat Model | Model picker UI bound to the active chat | `ChatPanel.tsx`, fixed alias list, calls `onChangeModel` |
| 7 | Suggestions-in-Comments | Merge suggestions into `CommentsPanel.tsx`'s grouped list | `groupComments`/`groupRows`, merged row type |
| 8 | Suggestions-in-Comments | Suggestion row rendering + actions reused from `SuggestionCard.tsx` | Visual distinction (badge/dashed border/severity), Accept/Dismiss/Discuss/Reopen wired |
| 9 | Suggestions-in-Comments | Filter tabs behavior for suggestions (Open/All/Resolved/Outdated analogues) | Decide & implement pending/dismissed mapping per FR-005 |

**Total stories:** 9 (Quick Flow ceiling: 15)

---

## Testing Strategy

### Unit Testing Focus

- Core: legacy `chat` → `chats` migration function (old shape in, new shape out,
  idempotent on already-migrated data).
- Core: `groupComments`/`groupRows` merge logic — correct grouping and ordering when
  comments and suggestions share a file, and when only one kind is present.
- Server: `Session.chat(chatId, message)` routes to the correct `ReviewAgent` and does
  not cross-contaminate another chat's messages; per-chat `model` is passed into
  `ReviewAgent`'s constructed `Options`.

### Integration / End-to-End Scenarios

- Open a review, create a second chat, send a message in each, confirm both threads
  retain independent history after a page reload (state is read back from the persisted
  `Review`, not just in-memory).
- Set chat A to `opus` and chat B to `sonnet` (or the server-default), send a message in
  each, confirm no error and that switching the model on one chat does not affect the
  other's next answer.
- Run the automatic suggestion pass, confirm resulting suggestions appear in
  `CommentsPanel.tsx` grouped correctly next to comments on the same file, are visually
  marked as suggestions, and that accepting one promotes it to a real comment exactly as
  it does today (no regression to `acceptSuggestion`).
- Load a pre-existing (pre-feature) review fixture with the old `chat` shape and confirm
  it opens without error, showing its prior messages as a single migrated chat.

### Performance / Load Considerations

Not a concern at this scale — a handful of concurrent chats per review, single-user,
local-only. No load testing planned.

### Security Testing Notes

Confirm the model picker only ever sends one of the fixed known aliases (or omits the
field) — add a test asserting the client rejects/ignores an out-of-list value rather
than forwarding arbitrary user input as the SDK `model` string.

---

## Dependencies

### External Dependencies

| Dependency | Version / Constraint | Purpose | Risk |
|------------|---------------------|---------|------|
| `@anthropic-ai/claude-agent-sdk` | `^0.3.252` (already installed) | Provides `Options.model` used for per-chat model selection | Low — field already exists in the installed version, no upgrade needed |

### Internal / Shared Dependencies

- `packages/core` review types are consumed by `server`, `cli`, and `web` — the
  `chat` → `chats` rename is a breaking change across all three packages and must land
  as one coordinated change (not incrementally), consistent with the monorepo's
  workspace structure.
- `reviewClient.ts` (`packages/web/src/lib/`) is the sole client-side API surface used
  by `App.tsx`/`ChatPanel.tsx` — its `chat` method signature change is the seam between
  Stories 3 and 4.

---

## Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Legacy `chat` → `chats` migration misses an edge case (e.g. empty chat, malformed timestamp) and drops history on load | High (data loss for existing reviews) | Low-Medium | Write the migration as a pure, unit-tested function first (Story 1) before any server/UI code depends on `chats`; keep it defensive (never throw, always produce at least an empty `chats: []`) |
| Multiple concurrent SDK sessions (one per chat) increase per-review resource/token usage beyond what a single-chat reviewer expects | Medium (cost/perf surprise) | Medium | Agents are created lazily per chat only on first message (matches today's lazy single-agent pattern) — an unused chat costs nothing |
| Merging suggestions into `CommentsPanel.tsx`'s filter tabs (FR-005/Story 9) muddies the Open/Resolved semantics reviewers already rely on | Medium (UX confusion, possibly undermining the "single action button" clarity principle noted in `project-documentation.md`) | Medium | Prototype both options (shared filter vs. separate suggestion visibility) during Story 9 and pick based on how it reads, not on implementation convenience; suggestions must never appear to affect the gate (FR-006) |
| Invalid/typo'd model alias sent to the SDK produces a confusing error inside a specific chat | Low | Low | UI restricts input to a fixed, known-good list of aliases (FR-003); server-side error path already exists via `AgentUnavailable` |

---

## Assumptions & Constraints

### Assumptions

1. A "chat" is scoped to one `Review`, not shared across reviews or persisted beyond a
   review's lifetime — consistent with the existing one-JSON-file-per-review model.
2. The fixed model alias list (sonnet/opus/fable/haiku/server-default) is acceptable
   without needing to query the SDK for a live model list; this keeps the picker simple
   and avoids an extra round-trip on chat-panel load.
3. Suggestions rendered inline in `Overview.tsx`/the diff view are not being removed —
   Feature 3 adds them to the comments list as an additional surface, it does not
   replace the existing inline rendering (out of scope unless the user says otherwise).

### Constraints

1. Must not change or weaken the read-only reviewer assistant boundary (`Read`/`Grep`/
   `Glob` only) — model choice affects reasoning quality/cost only, never capability.
2. Must not change what counts toward the Approve/Request-changes gate — only real,
   `open` `Comment`s do, exactly as today (FR-006).
3. Must remain a JSON-file-per-review, no-database persistence model — the `Chat`/
   `chats` change is a shape change to that JSON, not an architecture change.

---

## Success Criteria

How we know this work is complete:

- [ ] A reviewer can hold two or more independent chats in one review and switch
      between them without losing any history.
- [ ] A reviewer can pick a model per chat and see that choice actually reflected in
      the SDK call (verified via the SDK's own model-echo in a `system` message, or by
      observed behavior/cost differences between models).
- [ ] `CommentsPanel.tsx` lists suggestions alongside comments, visually distinct, with
      existing accept/dismiss/discuss actions intact, and with no change to gate logic.
- [ ] All MUST functional requirements implemented and accepted.
- [ ] Non-functional targets met (see NFR section).
- [ ] All 9 stories reach `done` status.

---

## Decisions Log Summary

| Decision | Rationale | Date |
|----------|-----------|------|
| Model selection uses a fixed, curated alias list in the UI rather than a free-text field or a live SDK model query | Keeps the security/NFR surface small (no arbitrary strings reach the SDK) and avoids an extra round-trip; matches the project's "local, low-friction" design principle | 2026-09-13 |
| One `ReviewAgent` (and one SDK `resume` session) per chat id, replacing the current one-per-review agent | Chats must be genuinely independent conversations (separate context, separate model) — sharing one SDK session across chats would leak context between unrelated threads | 2026-09-13 |
| Suggestions are merged into `CommentsPanel.tsx` as an additional row kind rather than migrating them into the `Comment` type | Suggestions and comments have deliberately different semantics (non-binding vs. binding, per `SuggestionCard.tsx`'s own doc comment) — unifying the types would risk suggestions silently affecting the approval gate | 2026-09-13 |

---

## Next Steps

This tech spec is the Quick Flow planning artifact. Proceed to story creation:

1. Use **bmad-epics-and-stories** to expand the Story List into full story files under
   `bmad-output/stories/`.
2. Story file naming: `{epic}.{story}.{slug}.story.md`
   (e.g., `1.1.chats-data-model.story.md`)
3. Once stories reach `ready-for-dev` status, hand off to your dev tool / plugin.

If scope has grown beyond 15 stories, switch to the BMad Method track before creating
stories: run **bmad-prd** to capture full requirements, then **bmad-architecture** to
design the system, then return to story planning.

---

*Technical Specification — Quick Flow Track — BMAD Method by the BMAD Code Organization*
