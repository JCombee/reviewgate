# ReviewGate

A local, browser-based code review gate that opens as soon as Claude Code wants to
commit. Claude Code cannot commit without a human decision having been made.

The diff opens in a browser UI with syntax highlighting, unified and split view,
comments at line and range level, and one action button that switches between
**Approve** and **Request changes**. On Request changes all feedback comes back into
the Claude Code session in a structured form; it then makes the fixes and tries to
commit again.

Everything runs on `127.0.0.1`. No hosting, no accounts, no data leaving the machine
beyond what the assistant itself asks Claude.

## How it works

A PreToolUse hook intercepts every `Bash` command, recognises a `git commit`, and
blocks synchronously until a decision is made in the UI:

| Decision in the UI | Hook output | Effect |
| --- | --- | --- |
| Approve | `permissionDecision: "allow"` | the command simply runs |
| Request changes | `deny` plus all feedback in `permissionDecisionReason` | Claude sees the review as feedback and starts fixing |
| Timeout | `deny` with a short explanation | Claude waits for you and does not commit |

A `deny` from a PreToolUse hook holds in *every* permission mode, including under
`--dangerously-skip-permissions`. The gate cannot be bypassed by the agent.

## Installation

```bash
pnpm install
pnpm build
```

Then switch the hook on. In a project with the plugin:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/reviewgate/plugin/bin/reviewgate-hook.mjs\"",
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

The wrapper is a Node script and is started explicitly with `node`: that way the gate
works identically on macOS, Linux and Windows, without depending on a POSIX shell.

### Recommended project settings

Put in your project's `CLAUDE.md` that staging and committing should be separate
commands. With `git add -A && git commit` nothing is in the index at hook time, so the
gate reviews the whole working tree instead of what is being committed.

Add `--no-verify` to your project's deny rules. The gate already refuses it with a
clear message, but a deny rule saves the attempt.

## Use without committing

```
reviewgate open [revision]  read in a review scope and open it
    --staged                (default) the staged changes
    --working               index plus working tree against HEAD
    --amend                 the changes of an amend
    <rev>                   a revision expression, e.g. main...HEAD
    --json                  print the typed diff structure and stop
    --no-open               do not open the browser, just print the URL
    -U, --context <n>       context lines (default 5)
    -C, --cwd <path>        work in another repo

reviewgate serve            start the server without a review
reviewgate status           the running server and open reviews
reviewgate hook             PreToolUse hook: reads hook JSON from stdin and blocks
```

## Inside the review

- **Placing comments.** Click in the gutter for a comment on that line, or drag across
  several lines for a range. It works on both sides of the diff.
- **Questions.** Tick "This is a question". Questions arrive in the feedback with a `?`,
  so Claude answers them instead of fixing blindly.
- **The commit message** is both editable and commentable, independently of each other:
  set it right yourself, *or* ask Claude to revise it, or both.
- **Suggestions.** As soon as the screen opens, a read-only assistant does a review pass
  and places its findings as *suggestions*, not as comments. They do not count and do
  not go to Claude until you accept them. Dismissed suggestions stay visible and do not
  come back in a later round.
- **The conversation** next to the diff answers questions about the change. The
  assistant reads the repo and the transcript of the session that wrote the code, and
  changes nothing.
- **Approve is impossible with open comments.** No escape hatch: resolve or delete them
  first. That is enforced server-side, not only in the UI.

### Keyboard

| Key | Does |
| --- | --- |
| `j` / `k` | next / previous hunk |
| `n` / `p` | next / previous file |
| `u` | switch between unified and split |
| `⌘↵` | send (a comment or a question) |
| `⌘⇧↵` | perform the primary action |

## Configuration

`.reviewgate.json` in the repo root. Everything is optional:

```json
{
  "timeoutMs": 3300000,
  "minLines": 0,
  "ignore": ["pnpm-lock.yaml", "dist/**", "**/*.min.js"],
  "autoOpen": true,
  "autoReview": { "perLines": 25, "min": 2, "max": 20 },
  "dedupe": { "overlapping": 0.6, "anywhere": 0.8 },
  "theme": "system"
}
```

| Key | Meaning |
| --- | --- |
| `timeoutMs` | how long the hook blocks at most |
| `minLines` | diffs smaller than this go through unreviewed; 0 turns it off |
| `ignore` | paths that do not count; `**` spans directories, `*` stays inside one segment |
| `autoOpen` | open the browser automatically |
| `autoReview` | `false` turns the automatic pass off; an object sets its bounds |
| `dedupe` | thresholds for recognising repeated suggestions |
| `theme` | `system`, `light` or `dark` |

A broken or unreadable config yields the defaults. A mistake in the configuration must
not block the work, at most keep it from being reviewed the way it was meant to be.

### Environment variables

| Variable | Does |
| --- | --- |
| `REVIEWGATE_SKIP=1` | skip the gate entirely |
| `REVIEWGATE_TIMEOUT_MS` | overrides `timeoutMs` |
| `REVIEWGATE_NO_OPEN=1` | do not open the browser |
| `REVIEWGATE_AUTO_REVIEW=0` | turn the automatic pass off |

## What ends up on disk

Everything under `.git/reviewgate/`, a path that is already outside version control:

| File | Contents |
| --- | --- |
| `reviews/<id>.json` | the review: rounds, comments, suggestions, conversation |
| `approved/<diffHash>.json` | proof that *this* diff was approved; lapses after 24 hours |
| `server.json` | port, pid and admin token of the running server |
| `COMMIT_EDITMSG` | the commit message you adjusted |
| `hook.log` | failures inside the hook |
| `dedupe.log` | automatically dismissed suggestions with their similarity score |

## Development

```bash
pnpm build          # core, server, cli and the web bundle
pnpm test           # vitest: unit and integration
pnpm test:e2e       # playwright: happy path and approve path
pnpm typecheck
```

The hook can be tested on its own, without Claude Code:

```bash
echo '{"tool_name":"Bash","cwd":"'$PWD'","tool_input":{"command":"git commit -m test"}}' \
  | reviewgate hook
```

## Limits

- One user, one machine. No remote reviews, no accounts.
- No GitHub or GitLab integration.
- No editing of code in the UI. The UI produces feedback; the agent makes the changes.
- Only `git commit` is a gate, `git push` is not.
- No git-native `pre-commit` hook: commits you make yourself from the terminal go
  through untouched. The gate watches the agent, not you.
