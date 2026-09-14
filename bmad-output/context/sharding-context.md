# Sharding Context — ReviewGate Round 2 (Issue Backlog)

Shared context for the story-author subagents compiling stories for Epics 4-7.

- **Project:** ReviewGate
- **Track:** Quick Flow — there is no `prd.md`/`architecture.md`. Cite
  `bmad-output/tech-spec.md` in Dev Notes exactly where a story-author would cite
  `prd.md#FR-XX` or `architecture.md#anchor` on other tracks, e.g.
  `[Source: tech-spec.md#fr-009-run-local-git-hooks-before-opening-the-review-ui-must]`.
- **Output folder:** `bmad-output/` (stories in `bmad-output/stories/`, map in
  `bmad-output/epics.md`).

## Source documents (read in full before writing any story)

1. `bmad-output/project-context.md` — project constitution: constraints (local-only,
   127.0.0.1, no DB, read-only reviewer assistant, fail-open on gate errors), glossary.
2. `bmad-output/tech-spec.md` — read the **"Round 2 — Problem & Solution"** section, all
   of **FR-007 through FR-010**, the four **"(Round 2)"** Key Components subsections, and
   the Round 2 additions to Testing Strategy / Dependencies / Risks / Assumptions &
   Constraints / Decisions Log Summary. Round 1 content (FR-001..006) is unrelated,
   already `done`, and not needed for these stories.
3. `bmad-output/epics.md` — read **Epic 4, Epic 5, Epic 6, Epic 7** and the Round 2 notes
   at the bottom of the file for the file-overlap flag between Story 4.1 and Story 5.2.
4. `bmad-output/decision-log.md` — the 2026-09-14 entries (Round 2 scoping rationale).

## Codebase grounding already done by the orchestrator (cite these facts as [Inference]
unless you re-derive them from the actual file — prefer reading the real file yourself
when writing Dev Notes)

- **Epic 4 (final page):** the post-decision block is the `decision != null` branch in
  `packages/web/src/App.tsx`, rendering inside a local `Centered` component (defined at
  the bottom of the same file). Existing assets: `packages/web/public/logo-dark.svg`,
  `packages/web/public/logo-light.svg`. Theme switching is CSS-driven via
  `data-theme` attribute / `prefers-color-scheme` in `packages/web/src/styles.css`
  (see the `:root:not([data-theme="light"])` / `:root[data-theme="dark"]` pattern
  already used there for other theme-conditional rules).
- **Epic 5 (update checks):** `packages/cli/src/commands/update.ts` already has
  `latestTag()` (calls `https://api.github.com/repos/${REPO}/releases/latest`),
  `isNewer(candidate, current)`, and the `VERSION`/`REPO` constants from
  `@reviewgate/core`. `packages/server/src/lockfile.ts` exports `stateDir(gitDir)`,
  the existing convention for the server's own local state file
  (`server.json`, via `serverRecordPath`) — reuse this directory for a new
  day-stamped cached update-check result file. `packages/web/src/lib/reviewClient.ts`
  is the sole client-side API surface today.
- **Epic 6 (hook ordering):** `packages/cli/src/commands/hook.ts`'s `decide()` function
  is the PreToolUse gate: it currently checks `analysis.noVerify` (deny), then
  `info.inMergeOrRebase` (let through), then loads config, computes the diff via
  `git.rawDiff(analysis.scope, options)`, and only then opens the review session. The
  new pre-commit hook run belongs after the `noVerify`/merge-or-rebase checks and
  before `git.rawDiff` is called, so a rewritten working tree is what gets diffed.
  `analyzeCommand` (in `packages/core/src/hook/command.ts`) already derives `scope`
  (`staged`/`working`/`amend`) and `noVerify`. The existing `Verdict` union
  (`{ kind: "allow" } | { kind: "deny"; reason }`) is what the new failure path reuses.
  The project's fail-open principle (`project-context.md` §11, and `hook.ts`'s own
  top-level try/catch returning `0`) means a hook-runner error unrelated to the hook's
  own exit code must not block the commit.
- **Epic 7 (dedupe removal):** `packages/core/src/review/suggestions.ts` exports
  `findDuplicate`, `similarity`, `normalize`, `words`, `rangesOverlap`, `DedupeConfig`,
  `DEFAULT_DEDUPE`, and `addSuggestions` (which currently calls `findDuplicate` per
  incoming suggestion before applying the cap, and returns a `duplicates` array in
  `AddSuggestionsResult`). `packages/core/src/config.ts` has a `dedupe: { overlapping,
  anywhere }` field on `ReviewGateConfig`/`DEFAULT_CONFIG`, parsed in `mergeConfig`.
  `packages/web/src/components/SuggestionCard.tsx` reads
  `suggestion.dismissedReason === "auto_duplicate"` to render an "auto" indicator.
  Whoever calls `addSuggestions` with a `dedupe` option (check `packages/server/src`,
  likely `agent.ts` or `session.ts`, for the automatic suggestion pass) also needs its
  call site updated once the option is removed.

## Sizing rule (reminder)

One dev-day max per story (~2-8h). 3-7 Acceptance Criteria. If a story would span two
independently-shippable layers (e.g. server endpoint + web UI), split it — Epic 5
already reflects this split (5.1 server, 5.2 web).

## Existing story conventions to follow (from the `done` Round 1 stories)

- Story files cite `tech-spec.md` anchors exactly as shown above.
- "Owned File/Module Scope" lists exact files, never `src/**`.
- Cross-file overlaps are called out explicitly as "Shared/contended" per the template.
