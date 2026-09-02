# ReviewGate — implementation plan

A local, browser-based code review gate that opens as soon as Claude Code wants to commit.
A GitLab-MR-like review: global comments, comments on a line or a line range, a chat panel
about the changes, and one action button that switches between **Approve** and
**Request changes**.

This document is meant as a working plan for Claude Code. Read it in full before you start,
work milestone by milestone, and commit per finished milestone (the gate reviews itself once
M3 runs).

---

## 1. Goal and scope

### In

- Claude Code cannot commit without a human decision having been made.
- The diff is presented in a browser UI with syntax highlighting, unified and split view.
- Comments: global (on the whole review) and at line level (a single line or a dragged range),
  on both the old and the new side of the diff.
- Threads per comment, with resolve/unresolve, exactly like GitLab discussions.
- A chat panel next to the diff for asking questions about the changes, with access to the repo
  and to the transcript of the session that wrote the code.
- One primary action button: **Approve** at zero open comments, changing into
  **Request changes** as soon as there is at least one open comment.
- On Request changes all feedback comes back into the Claude Code session in a structured form;
  it then makes the fixes and tries to commit again (round 2 of the same review).

### Out (for now)

- No remote/multi-user reviews, no hosting, no accounts. Everything is localhost, one user.
- No GitHub/GitLab API integration. Write it down as an explicit non-goal so the data model does
  not have to be built around it later.
- No editing of code in the UI. The UI produces feedback; the agent makes the changes. The commit
  message is the one exception: that *is* editable (§8).
- Only `git commit` is a gate. `git push` is not — once the commit moment is covered, a second
  gate on push adds little and mostly gets in the way on branches you already reviewed yourself.
- No git-native `pre-commit` hook in `.git/hooks/`. Commits you make yourself from the terminal
  go through untouched; the gate watches the agent, not you.
- No support for other agents (Cursor, Codex) in v1, but the core (CLI + server + UI) must stay
  agent-agnostic so that becomes a second adapter later.

---

## 2. The core decision: how the gate works

The whole tool hangs on one choice: **the PreToolUse hook blocks synchronously**.

The hook starts the review server, opens the browser, and keeps waiting until a decision is made
in the UI. Then it hands a verdict back to Claude Code:

| Decision in the UI      | Hook output                                                                | Effect                                            |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| Approve                 | `permissionDecision: "allow"`                                              | the `git commit` command simply runs              |
| Request changes         | `permissionDecision: "deny"` plus all feedback in `permissionDecisionReason` | Claude sees the review as feedback and starts fixing |
| Timeout / browser closed | `deny` with a short explanation                                            | Claude waits for the user and does not commit     |

Why synchronous rather than asynchronous (a hook that says "open the viewer and poll"):

- No extra round through the model is needed; nothing can slip in between.
- The feedback lands exactly where Claude has to act on it.
- A `deny` from a PreToolUse hook holds in *every* permission mode, including under
  `--dangerously-skip-permissions`. The gate cannot be bypassed by the agent.

Mind the timeout: PreToolUse hooks default to 600 seconds. That is too short for a real review.
Set `"timeout": 3600` explicitly in `hooks.json` and make it configurable.

### Hook contract

The hook receives JSON on stdin carrying, among other things, `tool_name`, `tool_input.command`,
`cwd`, `session_id` and `transcript_path`. Verify those field names against the current docs
(https://code.claude.com/docs/en/hooks) before building on them; the transcript path matters,
because it feeds the chat panel (see §9).

Output on stdout, exit 0:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<rendered review feedback in markdown>"
  }
}
```

### When the hook does and does not trigger

The matcher is `Bash`. Filter on the command inside the script itself:

- Trigger on `git commit`, including `-m`, `-am`, `--amend`.
- Trigger *also* when the command is an `&&` chain that ends in a commit
  (`git add -A && git commit -m "..."`). That is the most common shape and it means nothing is
  staged at hook time: determine the review scope on the working tree then
  (`git diff HEAD` plus untracked files), not on the index.
- Scope in order: does the command contain an `add`/`-a` → working tree;
  otherwise → `git diff --cached`; with `--amend` → `HEAD~1..` plus staged.
- Skip (allow, exit 0) on: an empty diff, changes only in ignored paths (configurable, lockfiles
  and `dist/` by default), a diff smaller than `minLines` (0 by default, so off), or when
  `REVIEWGATE_SKIP=1` is in the environment.
- `--no-verify` in the command: block it with a clear reason. Add it as a permission deny rule in
  the project settings too, because agents reach for it when something fails.

### The approval artifact

After an Approve the server writes `.git/reviewgate/approved/<diffHash>.json` with the hash of
the reviewed diff, the time and the session id. The hook lets a commit through when a valid
artifact exists for exactly this diff. That makes it idempotent: if the agent calls `git commit`
once more after an Approve (after a failing pre-commit hook of git's own, say) you need not
review again. Artifacts lapse after 24 hours and on every change to the diff.

`diffHash` = sha256 over the normalised patch text (paths plus hunks, without timestamps and
without index lines).

---

## 3. Architecture

```
  Claude Code session
        │  Bash("git add -A && git commit -m ...")
        ▼
  PreToolUse hook  ──────────►  reviewgate hook   (blocks, waits for a verdict)
        ▲                              │
        │  allow / deny + feedback     │ starts
        │                              ▼
        │                       review server (127.0.0.1:<port>)
        │                        ├── git: diff, blob, blame
        │                        ├── session store (.git/reviewgate)
        │                        └── chat agent (read-only)
        │                              │ HTTP + SSE
        └──────────────────────────────┴──►  browser UI (React)
                                                 Approve / Request changes
```

One process per repo. The server writes `.git/reviewgate/server.json` with the port and the pid;
a second invocation in the same repo reuses the running server. Port: ephemeral, bound to
`127.0.0.1`. The review URL carries a random token; requests without a token → 403.

---

## 4. Repo layout and stack

Node plus TypeScript, npm workspaces. One npm package bundling everything, plus a separate
plugin directory for the Claude Code side.

```
reviewgate/
├── packages/
│   ├── cli/            # bin: reviewgate. hook, open, serve, status
│   ├── core/           # git interaction, diff parsing, anchoring, session model, rendering
│   ├── server/         # HTTP + SSE, serves the built web assets
│   └── web/            # React UI (Vite)
├── plugin/             # Claude Code plugin (published along with it)
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── commands/review.md
│   └── skills/reviewgate/SKILL.md
├── e2e/                # Playwright
└── plan.md
```

Choices:

- **core** is pure and free of IO where possible, so diff parsing and comment anchoring are
  unit-testable with vitest. Every `git` call sits behind a single `GitClient` interface.
- Server: **Hono** on `@hono/node-server`. Native TS, `streamSSE` built in, no platform-specific
  dependencies. SSE for streaming chat, no websockets needed.
- **Platform neutrality is a hard requirement, not an afterthought.** Concretely:
  - No shell scripts in the execution path. Every bin is a `.mjs` with a shebang plus a `bin`
    entry in `package.json`, so npm generates a `.cmd` shim on Windows itself.
  - Never `child_process.exec` with a composed command string. Always `execFile`/`spawn` with an
    argv array and `shell: false`, so per-platform quoting plays no part.
  - Paths always through `node:path`; compare and store them in POSIX form (`path.posix`, forward
    slashes), because that is what `git` returns too. Convert only at actual filesystem contact.
  - Read git output as UTF-8 with `core.quotePath=false`, and split line endings on `\r?\n`.
    Account for `core.autocrlf` on Windows: parse the diff the way git hands it over, and do not
    normalise it yourself.
  - Open the browser without an `open`-style shell call: `start`/`open`/`xdg-open` per platform
    through `execFile`, with a visible fallback that prints the URL in the terminal.
  - The file lock and pid check in `.git/reviewgate/server.json` must not lean on POSIX signals;
    use `process.kill(pid, 0)` in a try/catch, which works on all three.
- Web: React + Vite + Tailwind, shiki for highlighting (server-side rendered tokens save a lot of
  bundle size and are faster on large diffs).
- Diff parsing: a hand-written parser on `git diff -U5 --no-color` output, or `parse-diff` as a
  starting point. You need your own structures for anchoring either way, so keep the parser thin.
- No database. JSON files in `.git/reviewgate/` — that path is already outside version control.

---

## 5. Data model

`.git/reviewgate/reviews/<reviewId>.json`

```ts
type Review = {
  id: string; // stable across several rounds
  repoRoot: string;
  branch: string;
  createdAt: string;
  rounds: Round[]; // every commit attempt adds a round
  comments: Comment[];
  suggestions: Suggestion[]; // from the automatic pass, not comments (§9)
  chat: ChatMessage[];
  status: "open" | "approved" | "changes_requested" | "abandoned";
};

type Round = {
  n: number;
  diffHash: string;
  scope: "staged" | "working" | "amend";
  commitMessage: string | null; // from the intercepted command
  editedCommitMessage: string | null; // adjusted by you in the UI, null = unchanged
  claudeSessionId: string;
  transcriptPath: string | null;
  decision: "approve" | "request_changes" | "timeout" | null;
  decidedAt: string | null;
  summary: string | null; // free text field alongside the decision
};

type Comment = {
  id: string;
  round: number; // the round it was placed in
  scope: "global" | "line" | "commit_message";
  kind: "issue" | "question"; // questions are rendered with a ? in the feedback
  path?: string;
  side?: "old" | "new";
  startLine?: number;
  endLine?: number;
  anchorSnippet?: string; // the actual line text, for re-anchoring
  body: string;
  author: "user" | "agent";
  status: "open" | "resolved" | "outdated";
  fromSuggestion?: string; // id of the suggestion it came out of
  replies: { author: "user" | "agent"; body: string; at: string }[];
  createdAt: string;
};

type Suggestion = {
  id: string;
  round: number;
  scope: "global" | "line" | "commit_message";
  path?: string;
  side?: "old" | "new";
  startLine?: number;
  endLine?: number;
  anchorSnippet?: string;
  body: string;
  severity: "blocker" | "consideration" | "nit";
  status: "pending" | "accepted" | "dismissed";
  dismissedReason?: "user" | "auto_duplicate" | "round_closed";
  duplicateOf?: string; // id of the suggestion dismissed earlier
  promotedToCommentId?: string;
  createdAt: string;
};
```

Suggestions are deliberately their own type and *not* a `Comment` with `author: 'agent'`. They do
not count towards the button state, they do not travel with the feedback to Claude, and they only
become a comment once you accept one. They are never removed either: dismissed suggestions stay
in the file and in the UI, so you can look back at what was proposed and what you did with it.
See §9.

### Anchoring across rounds

This is the hardest part; plan time for it and cover it with unit tests.

On a new round the line numbers shift. Per open comment:

1. Look the `anchorSnippet` back up in the new file within a window of ±40 lines around the old
   number. An exact match → move the comment.
2. Exactly one match elsewhere in the file → move it and mark it as `moved`.
3. No match or several → status `outdated`. It stays visible in the UI in an "Outdated" section,
   the way GitLab does it, and no longer counts as open.

Comments from earlier rounds stay visible with a round-number badge, so in round 2 you can see
whether your earlier points were actually addressed.

---

## 6. CLI

```
reviewgate hook                 # reads hook JSON from stdin, blocks, prints verdict JSON
reviewgate open [ref]           # a manual review: --staged (default), --working, main...HEAD
reviewgate serve                # start the server without a review (dev)
reviewgate status               # the running server, open reviews, the last decision
reviewgate approve <id>         # approve from the terminal, refuses with open comments
```

`reviewgate hook` has to be testable without Claude Code:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"'$PWD'","tool_input":{"command":"git commit -m test"}}' \
  | reviewgate hook
```

---

## 7. Server API

Everything under `/api`, the token in the `Authorization` header or in the query of the review URL.

```
GET  /api/review/:id                 → Review plus rendered diff (files, hunks, tokens)
GET  /api/review/:id/file?path=&side= → full file content for context expansion
POST /api/review/:id/comments        → a new comment (global, line or commit_message)
PATCH/DELETE /api/review/:id/comments/:cid
POST /api/review/:id/comments/:cid/replies
PUT  /api/review/:id/commit-message  → { message } → stores editedCommitMessage
POST /api/review/:id/suggestions/:sid/accept   → { body? } → promotes it to a comment
POST /api/review/:id/suggestions/:sid/dismiss
POST /api/review/:id/decision        → { decision, summary } → closes the round, unblocks the hook
GET  /api/review/:id/events          → SSE: comment and suggestion mutations, chat tokens, decision
POST /api/review/:id/chat            → { message } → the answer streams over the SSE
```

`POST /decision` with `approve` validates server-side on zero open comments and otherwise returns
`409` with the ids in question. Open suggestions block nothing: on a decision they get
`status: 'dismissed'` with `dismissedReason: 'round_closed'` and stay visible in the history.

The hook waits on a promise that `POST /decision` resolves. Work with an in-memory `Deferred` per
round plus a fallback that polls the session file, so a server restart does not leave the hook
hanging forever.

---

## 8. UI

### Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│  feature/checkout · round 2 · 7 files · +214 −38        [ Unified | Split ] │
├──────────────┬──────────────────────────────────────────┬──────────────────┤
│ Files        │  diff                                    │  Conversation    │
│              │                                          │                  │
│ ✓ Foo.php  2 │  @@ -40,7 +40,12 @@                      │  Why is the      │
│   Bar.ts     │   40   public function handle()          │  cache forgotten │
│   Baz.vue  1 │   41 + $this->cache->forget($key);   💬   │  here?           │
│              │        ┌────────────────────────────┐    │                  │
│ Overview     │        │ open · round 1             │    │  ──────────      │
│  · 1 global  │        │ This invalidation path     │    │  [ question... ] │
│              │        │ misses the tag variant.    │    │                  │
│              │        │ [Reply] [Resolve]          │    │                  │
│              │        └────────────────────────────┘    │                  │
├──────────────┴──────────────────────────────────────────┴──────────────────┤
│ 3 open · 1 outdated            [summary...]             [ Request changes ]│
└────────────────────────────────────────────────────────────────────────────┘
```

Three columns, resizable, with the file list and the chat panel collapsible. The action bar is
fixed at the bottom and always visible — that is the heart of the screen.

### Interactions

- Click the `+` icon in the gutter of a line → a comment form on that line. Drag across several
  lines → a range comment, with the range marked in the gutter.
- Comments sit inline under the line they belong to, collapsed into a bar with the author and the
  first line when a file has many comments.
- Global comments in the "Overview" tab above the file list.
- Suggestions from the automatic pass sit visually apart: a dashed border, a "Suggestion" badge
  with the severity, a muted colour, and never the same shape as a real comment. Three actions per
  suggestion: **Accept** (opens the comment form with the text prefilled and editable, so you can
  put it in your own words), **Dismiss**, and **Discuss** (sends it to the chat panel). As long as
  you do nothing it stays a suggestion and nothing changes. Dismissed suggestions stick around,
  collapsed under "Dismissed (n)" (§9).
- Context expansion: a button between hunks to load ±10 more lines, plus "show the whole file".
- Keyboard: `j`/`k` next/previous hunk, `n`/`p` next/previous file, `c` a comment on the active
  line, `⌘↵` send, `⌘⇧↵` perform the primary action.
- Visible focus states, respect `prefers-reduced-motion`. Motion only where something changes: a
  comment opening up and the switch of the primary button.

### The commit message

At the top of the "Overview" tab, above the global comments, with two independent routes:

- **Editing.** The message Claude wanted to use, taken from the intercepted command, sits in a
  text area. Whatever you type becomes the message. On Approve the hook writes your version to
  `.git/reviewgate/COMMIT_EDITMSG` and asks for one more attempt with `git commit -F <path>` — a
  file rather than `-m` avoids all the quoting misery with multi-line messages and quotation
  marks. See the note under §10 for why it is a second attempt and not a rewrite. On Request
  changes your version travels with the feedback as the message to use.
- **Commenting.** A comment button next to the field places a comment with
  `scope: 'commit_message'`. That counts as open like any other and therefore puts the button on
  Request changes. Use it when you want Claude to revise the message *himself* ("reference the
  ticket, and split this into two commits") rather than fixing it up yourself.

Both are allowed at once: an edited message plus a comment about it is a valid combination. Show a
hint on the comment in that case that the message has also been adjusted, so the feedback does not
look contradictory to Claude. The original message stays available behind a "show original"
toggle.

### The action button (state machine)

This is an explicit requirement; implement it as one button that switches roles, not as two
buttons side by side.

```
openComments = comments.filter(c => c.status === 'open').length

openComments === 0  →  primary: "Approve"          (green, ⌘⇧↵)
openComments  >  0  →  primary: "Request changes"  (orange, ⌘⇧↵)
```

- The switch is live: the moment you place the first comment the label changes, and when you
  resolve or delete your last open comment it springs back to Approve.
- Outdated and resolved comments do not count.
- Open suggestions do not count either. A suggestion you did not accept must not flip the button —
  otherwise the agent still decides whether you may approve.
- Next to the button sits the counter that explains the state ("3 open"), so the switch never
  feels like a bug.
- Animation: a short colour and label crossfade only, no layout shift. Reserve the width of the
  longest label.
- **No escape hatch.** There is no second button, no caret menu and no "approve with comments".
  With open comments, Request changes is the only possible action. If you do want to approve, you
  resolve or delete the comments first — a deliberate act that shows up in the history, rather
  than a deviation you click away.
- This is enforced server-side, not only in the UI: `POST /decision` with `decision: "approve"`
  while comments are open returns `409` with the list of open comment ids. The UI is not the only
  place where the rule lives.
- Questions are comments too and therefore keep the button on Request changes. They are marked
  with a `?` in the feedback, so Claude answers them instead of fixing blindly.

### The summary

The text field to the left of the action button. One or two sentences about the review as a whole,
which end up at the top of the feedback to Claude as `## Summary` — on Approve it travels along as
`systemMessage`.

It is deliberately something other than the comments. Comments are point-by-point and local; the
summary gives the direction and the order: "the shape holds, but sort out the cache invalidation
first — the rest follows from that", or "this is too big, split it into two commits". Exactly the
kind of framing you put in the description field of an MR and that a list of separate remarks does
not convey.

Optional, and it stays that way. The placeholder makes clear what it is for ("Direction for the
next round, optional"). If you leave it empty the heading is left out of the feedback rather than
sent along empty. No hint, no nudge and no warning when you approve without filling anything in —
an empty summary is a valid review.

### Visual direction

Not a GitLab clone and not generic SaaS cards. The screen is a reading environment for code that
opens in the terminal context of Claude Code, so: a calm, dense layout, all the room to the diff,
the chrome as thin as possible. Deliberately pick one monospace family for the code and one sans
for the UI, and tune the colours of the diff backgrounds so that they do not tire you out over
long sessions (low saturation for the surfaces, high saturation only for the per-character
highlight inside a changed line). Settle the palette and the typography as tokens in one go before
you start building, and keep the action bar at the bottom as the one genuinely outspoken place.

---

## 9. The chat panel

The panel answers questions about the changes while you review. Two things make it better than
pasting the diff into a separate chat window:

1. **Repo access.** Run the chat through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
   with `cwd` on the repo and `allowedTools: ['Read', 'Grep', 'Glob']`. Read-only, explicitly
   without Edit/Write/Bash — the main session sits blocked and waiting and nothing may change
   under its hands. Answers stream to the UI over SSE.
2. **Intent.** The hook receives the `transcript_path` of the blocking session. Give the chat that
   transcript as context (or a summary of it for large transcripts), so that "why did you wrap a
   repository around this?" is answered with what was decided in the session, rather than with a
   guess based on the code.

The chat's system prompt: you are a reviewer assistant, you explain and analyse, you change
nothing, and you are explicit about what you know from the transcript and what you infer from the
code.

The diff, the file list and the comments already placed travel along as context. Per message you
either send the full history or use the SDK's session resume.

Two links between the chat and the review, both important:

- **"Turn this into a comment"** on any chat answer → opens the comment form with the relevant
  file/line prefilled when the answer points at code.
- **"Ask the author"** → puts your question into the review as a comment with `kind: question`. On
  Request changes it goes back to the main session as a question, not as an instruction.

Fallback when the Agent SDK is unavailable or there is no auth: a direct Anthropic API call with
only the diff as context, and a notice in the UI that the repo context is missing.

### The automatic first pass

As soon as the screen opens, the same read-only agent starts a review pass over the diff and
places its findings as **suggestions**, not as comments. That distinction is the whole heart of
this feature: the agent may draw your attention to something, but it may not put a judgement into
the review on your behalf.

Concretely:

- Suggestions appear progressively over SSE while the pass runs; meanwhile you can already read
  and place comments of your own. The pass blocks nothing.
- The state of the pass sits in the header bar: "looking for suggestions…", "6 suggestions", or
  "suggestions failed" with the reason. Never a modal, never a spinner over the diff.
- A suggestion becomes a comment only when you click **Accept**, and then the comment form opens
  with the text prefilled and editable. The comment that comes out has `author: 'user'` with
  `fromSuggestion` filled in — you are the author, because you approved it. Only then does it
  count towards the button and travel with the feedback.
- Suggestions you did not accept never go to Claude. He should not get his own unfiltered review
  handed back to him.
- Severity (`blocker` / `consideration` / `nit`) is a sort order in the UI only, not behaviour.
  Sort on severity, then on file and line number.
- The pass's prompt gets the same context as the chat (diff, transcript, repo read-only) plus the
  project's `CLAUDE.md` and any `REVIEW.md`, and the instruction to hold back: concrete defects at
  `file:line`, no style preferences, nothing the linter already catches.
- The pass shares its agent session with the chat panel, so you can follow up on a suggestion in
  the chat without the context being rebuilt.
- Switchable off with `autoReview: false` in `.reviewgate.json`, and restartable by hand with a
  button in the header bar.

### How many suggestions

The cap scales with the size of the diff: **2 suggestions per 50 changed lines**.

```
changedLines = every + and − line in the review scope, ignore patterns not counted
cap = clamp(ceil(changedLines / 25), 2, 20)
```

So 50 lines → 2, 200 lines → 8, 500 lines → 20. The floor of 2 makes sure a ten-line diff cannot
automatically yield zero suggestions; the ceiling of 20 is a safety valve against a wall of text
on an enormous refactor. Both numbers configurable through `autoReview.perLines`,
`autoReview.min` and `autoReview.max`.

Two things that come with this and that you have to fix in the prompt *and* in the code:

- **It is a ceiling, not a target.** Zero suggestions is a valid and often correct outcome. Put
  that explicitly in the prompt ("name only what genuinely adds something; if there is nothing,
  return an empty list") and, at zero suggestions, show nothing in the UI beyond a quiet line in
  the header bar. No empty-state illustration, no "no problems found!" message.
- **The cap is enforced server-side**, not merely requested in the prompt. If the agent hands over
  more, you keep the highest severity, then file order and line number. The suggestions that get
  cut land in the session file for debugging, but not in the UI.
- The cap counts `pending` suggestions only. Automatically dismissed duplicates (below) do not
  count, otherwise the history crowds out the new findings.

### Repeated suggestions across rounds

Dismissed suggestions never disappear. They stay in the review file and stay visible in the UI,
and they suppress repetition in later rounds:

- The dismissed suggestions travel as context to the next round's pass, with the instruction not
  to repeat them.
- If it does anyway, the new suggestion is **dismissed automatically** rather than thrown away:
  `status: 'dismissed'`, `dismissedReason: 'auto_duplicate'`, `duplicateOf` pointing at the
  original. So it is there, with a label like "dismissed automatically — you already dismissed
  this in round 1" and a button to reopen it after all. You keep the last word; the deduplication
  only takes the clicking away.
- Matching is deterministic and unit-testable, not a model judgement. Normalise the text
  (lowercase, punctuation and line numbers out, whitespace collapsed) and compare with Jaccard
  similarity over the words. A duplicate when: the same file *and* an overlapping line range *and*
  similarity ≥ 0.6, or similarity ≥ 0.8 regardless of location. Thresholds configurable, and log
  the score on every automatic dismissal so you can adjust them.

  This said "word trigrams" at first. That was changed while building M4: trigrams are far too
  strict for these thresholds. "this fetch has no error handling" against "this fetch still has no
  proper error handling" scores 0.25 on trigrams — well below 0.6, so the deduplication would
  practically never fire. At word level that same pair is 0.75, and then the thresholds do what
  they are supposed to do.
- Only suggestions *you* dismissed (`dismissedReason: 'user'`) and duplicates dismissed
  automatically earlier suppress repetition. Suggestions closed along with a decision because you
  simply never got to them (`round_closed`) do not — you never judged those, so they may come
  back.
- In the UI, dismissed suggestions sit collapsed under "Dismissed (n)", per file and in the
  overview, with their round number. They never count towards the button.

---

## 10. The feedback format back to Claude

`permissionDecisionReason` on Request changes. Keep it compact and machine-readable enough that
Claude can work from it directly:

```markdown
# Code review: changes requested (round 2)

The commit was blocked. Work through the points below, then try to commit again.
Questions (marked with ?) are for you to answer in your reply to the user; they need no fix.

## Summary

<free text from the reviewer>

## Commit message

Use this message (adjusted by the reviewer):

    fix(checkout): invalidate cache tags on order cancellation

    Refs #412

- Split this into two commits: the cache fix and the refactor of the service do not belong together.

## General

- The new service belongs in `app/Services/`, not in `app/Support/`.

## app/Services/CheckoutService.php

- L42-48: the invalidation path misses the tag variant, so the cache sticks around.
- ? L91: why a transaction around this, when there is only one write?

## resources/js/checkout.ts

- L17: this fetch has no error handling.

## Still open from earlier rounds

- app/Models/Order.php L23: not fixed yet.
```

The "Commit message" block appears only when the message was edited or when a comment with
`scope: 'commit_message'` is open, and then carries both of those things: first the message to
use, then the comments about it.

On Approve: `allow`. By definition there are no open points left. What still travels along:

- The summary goes along as `systemMessage`, so Claude knows what was approved on.

### Note: a PreToolUse hook cannot rewrite the command

While building M3 this was checked against the docs (https://code.claude.com/docs/en/hooks): a
PreToolUse hook knows only `permissionDecision` (`allow` or `deny`) with
`permissionDecisionReason`, plus `systemMessage`. There is no `updatedInput` and no other way to
change `tool_input` before the command runs. `additionalContext` does not exist for this event
either; that is `systemMessage`.

So the edited commit message works like this:

1. On an Approve *with* an edited message the hook writes it to `.git/reviewgate/COMMIT_EDITMSG`
   and returns `deny` with exactly one instruction: commit again with
   `git commit -F <that path>`.
2. The approval artifact is already on disk at that point, so that second attempt goes through
   without a new review. The hook recognises its own message file and knows this is the second
   attempt.

It costs one extra round through the model, but only when you actually adjusted the message. On an
ordinary Approve it is simply `allow` and the commit runs.

---

## 11. Plugin packaging

```
plugin/
├── .claude-plugin/plugin.json     # this file alone belongs in .claude-plugin/
├── hooks/hooks.json
├── commands/review.md             # /reviewgate:review — start a manual review
└── skills/reviewgate/SKILL.md     # tells the agent what the gate is and how to work its feedback
```

`hooks/hooks.json` uses the same schema as the `hooks` block in `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "reviewgate hook",
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

Always use `${CLAUDE_PLUGIN_ROOT}` for files inside the plugin, never absolute paths. The hook itself
needs no file at all: the command is `reviewgate hook`, so the plugin is a thin wiring layer and the
binary on the PATH does the work. That binary is the same one on macOS, Linux and Windows, which
takes both the POSIX shell and the `exec` bit out of the picture — there is no wrapper script, and no
`.cmd` case.

The hook reads the hook JSON from stdin and on *any* internal failure exits 0 without output — a
broken gate must never block the work, only fail to review it. Log failures to
`.git/reviewgate/hook.log`.

The binary is distributed as a single self-contained executable per platform (`bun build --compile`)
from GitHub releases, so the end user installs nothing else: no Node, no npm, no checkout. The
install script and `reviewgate update` both resolve the newest release, verify its SHA-256 and
replace the binary.

Include in the README as well: put in your project's `CLAUDE.md` that staging and committing must
be separate commands, and add `--no-verify` to the deny rules.

---

## 12. Edge cases and risks

| Case                                                 | Approach                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `git add -A && git commit` in one Bash call          | the working tree as the scope (§2)                                                                                   |
| A commit from a subagent or a parallel session       | one review per `session_id`; a second session gets a deny saying "a review is already open"                           |
| The server crashes while the hook waits              | the hook has its own timeout and falls back to a deny with an explanation                                            |
| An enormous diff (>2000 lines)                       | lazy per-file loading, a warning in the UI, no full-file highlighting                                                |
| Binary files and renames                             | shown as a metadata line, still commentable at file level                                                            |
| Submodules, LFS                                      | v1: skip them with a visible note                                                                                    |
| Merge commits, rebase, `git commit` during a conflict | detect through `.git/MERGE_HEAD` and step the gate aside                                                             |
| The agent tries to bypass the gate                   | `--no-verify`, `git stash`, direct writes into `.git/` in the deny rules; a PreToolUse deny holds in bypass modes too |
| A repo without commits (no HEAD)                     | scope against the empty tree                                                                                          |
| Windows                                              | a first-class target, equal to macOS/Linux (§4). No shell scripts, `execFile` with argv, paths through `node:path`   |
| Paths with spaces or non-ASCII characters            | argv arrays instead of command strings; `core.quotePath=false` when reading git output                               |
| CRLF checkouts (`core.autocrlf=true`)                | parse the diff the way git hands it over, split on `\r?\n`, do not normalise it yourself                             |

---

## 13. Phasing

Every milestone is usable on its own and has a demo moment. Do not work ahead.

**M0 — Foundation**
Monorepo, TypeScript, vitest, a CLI skeleton, `GitClient`, the diff parser.
Done when: `reviewgate open --staged --json` prints a correct, typed diff structure for a test repo
with additions, deletions, renames and a binary file.

**M1 — Reading the diff**
Server plus web UI, unified and split view, syntax highlighting, the file list, context expansion.
Done when: `reviewgate open` opens a browser showing the staged diff correctly, including a diff of
1000+ lines without noticeable delay.

**M2 — Comments**
Global comments, line and range comments, replies, resolve, persistence, SSE sync.
Done when: comments survive a restart of the server and keep the right line.

**M3 — The gate (the first genuinely usable version)**
The action bar with the button state machine, `POST /decision` with server-side validation, the
blocking hook, the approval artifact, the editable and commentable commit message including the
`-F` route for an edited message, feedback rendering. A plugin skeleton with `hooks.json`.
Done when: in a real Claude Code session a commit blocks, you place comments, press Request
changes, and Claude receives the feedback and gets to work. From here on ReviewGate reviews its own
commits.

**M4 — Chat and suggestions**
The Agent SDK read-only, SSE streaming, transcript context, "turn this into a comment", and the
automatic first pass that yields suggestions (§9).
Done when: a question about a line is answered with a reference to a file that is not in the diff,
*and* a suggestion only puts the button on Request changes after being accepted.

**M5 — Rounds**
Several rounds per review, anchoring and `outdated` detection, history in the UI, "ask the author".
Done when: a comment from round 1 that Claude's fix shifted sits on the right new line in round 2.

**M6 — Shipping**
`.reviewgate.json` config (timeout, minLines, ignore patterns, theme, autoOpen), publishing the
plugin through a marketplace repo, a README with screenshots, a Playwright happy path, error
handling that never blocks.

---

## 14. Testing approach

- **core**: unit tests on diff parsing and anchoring, with fixtures from real patches (shifted
  lines, renamed files, removed hunks).
- **hook**: table-driven tests with real hook payloads as JSON fixtures, including the
  `add && commit` chain, `--amend`, `--no-verify` and empty diffs.
- **server**: integration tests against a temporary git repo set up per test.
- **e2e**: Playwright, one happy path (place a comment → the button switches → request changes →
  the hook gets a deny with the right markdown) and one approve path.
- The button state machine gets tests of its own: that is the requirement the whole thing is judged
  on.
- **A CI matrix over `windows-latest`, `macos-latest` and `ubuntu-latest`.** Platform neutrality
  that is not tested per commit is gone within three weeks. Include a path with a space and a
  non-ASCII file name in the fixtures, and run the hook tests under a CRLF checkout as well.

---

## 15. Settled decisions

These have been answered and worked into the plan. They sit here so the reasoning stays visible.

1. **Only `git commit` is a gate**, no push gate.
2. **No git-native `pre-commit` hook.** Your own commits from the terminal go through untouched;
   the gate watches the agent.
3. **Approve is impossible with open comments.** No escape hatch, enforced server-side.
4. **The automatic first pass yields suggestions, not comments.** Only after being accepted do they
   become comments of yours, and only then do they count and go to Claude.
5. **The commit message is both editable and commentable**, and those two can be used
   independently of each other.
6. **The cap on suggestions scales with the diff**: 2 per 50 changed lines, with 2 as a floor and
   20 as a safety valve. It is a ceiling, not a target — zero is fine.
7. **Dismissed suggestions never disappear** and they suppress repetition: a near-identical
   suggestion in a later round is dismissed automatically, but stays visible and can be reopened by
   hand.
8. **The summary is optional** and stays a free text field describing the direction of the review
   (§8), not a mandatory summary of the comments. No hint or nudge when you leave it empty.
9. **Platform-neutral, with Windows as a first-class target.** The hook wrapper is a Node script
   (`.mjs`) started explicitly with `node`, not a shell script; every subprocess goes through
   `execFile`/`spawn` with an argv array and `shell: false`; paths run through `node:path` and are
   kept internally in POSIX form. The reason: the gate sits in the commit path of every session, so
   it has to run everywhere Claude Code runs — a `.sh` that silently fails on Windows means a gate
   that appears to be there but does nothing.
10. **The server is Hono** on `@hono/node-server`, with `streamSSE` for the chat. Chosen over
    Express because it is native TypeScript, has SSE built in and brings no platform-specific
    dependencies.
11. **The hook does not rewrite the command**, because a PreToolUse hook cannot: there is no
    `updatedInput`. An edited commit message goes through a message file plus one targeted second
    attempt, covered by the approval artifact (see the note under §10).

### To adjust during use

No open design questions left. There is one setting that can only be determined with real data:
the thresholds for duplicate detection (0.6 on overlapping lines, 0.8 outside that). Log every
automatic dismissal with the file, both texts and the score to `.git/reviewgate/dedupe.log`, and
adjust after a week of real use. Too low means you miss new findings because they resemble old
ones; too high means you click the same remark away every round. The log makes visible which of
the two you have.
