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

One command. It downloads a single self-contained binary, verifies its SHA-256, puts
it on your PATH and installs the Claude Code plugin. Nothing else has to be on the
machine: no Node, no npm, no checkout.

**macOS and Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.ps1 | iex
```

Restart Claude Code afterwards so it picks up the hook, and open a new terminal if the
installer says it changed your PATH. Then check it landed:

```bash
reviewgate --version
```

The binary goes to `~/.local/bin` on macOS and Linux — the script prints the line to
add if that is not on your PATH, and never edits a shell profile behind your back. On
Windows it goes to `%LOCALAPPDATA%\Programs\reviewgate` and the script does extend your
user PATH, because nothing else there would.

Flags, environment variables and the full list of what the script touches are in
[`scripts/README.md`](scripts/README.md).

### Platforms

| Platform | Asset |
| --- | --- |
| macOS, Apple silicon | `reviewgate-darwin-arm64` |
| macOS, Intel | `reviewgate-darwin-x64` |
| Linux, x86-64 | `reviewgate-linux-x64` |
| Linux, arm64 | `reviewgate-linux-arm64` |
| Windows, x86-64 | `reviewgate-win32-x64.exe` |

Windows on ARM gets the x64 binary and runs it under emulation. Every asset is
published with a `.sha256` beside it on the
[releases page](https://github.com/JCombee/reviewgate/releases), which both installers
check before they put anything in place.

The binaries are not code-signed. `curl` and `Invoke-WebRequest` do not set the
quarantine flag, so the gate runs straight after the install script; a binary you
download by hand through a browser will need Gatekeeper's approval on macOS.

## Updating

```bash
reviewgate update           # replace the binary with the newest release
reviewgate update --check   # only look, do not install
reviewgate --version        # what you have now
```

The updater resolves the newest release, verifies the checksum and only then swaps the
binary — a failed download leaves the working install untouched. Rerunning the install
script does the same thing.

The plugin itself is managed by Claude Code, separately from the binary. After a
release that changes the commands or the hook:

```bash
claude plugin marketplace update reviewgate
claude plugin update reviewgate@reviewgate
```

Restart Claude Code to apply it. Most releases change only the binary, which
`reviewgate update` covers on its own.

## Installing without the script

The plugin and the binary are separate things: the plugin wires `reviewgate hook` into
Claude Code, the binary does the work. Inside Claude Code:

```
/plugin marketplace add JCombee/reviewgate
/plugin install reviewgate@reviewgate
```

Then put a `reviewgate` on your PATH, either from the
[releases](https://github.com/JCombee/reviewgate/releases) or from source:

```bash
git clone https://github.com/JCombee/reviewgate.git
cd reviewgate
npm install
npm run build
npm link --workspace @reviewgate/cli
```

Both give the same `reviewgate hook` command, so the plugin does not care which one
you have.

### Uninstalling

Remove the plugin, then delete the binary:

```bash
claude plugin uninstall reviewgate@reviewgate
rm ~/.local/bin/reviewgate                                    # macOS, Linux
```

```powershell
Remove-Item "$env:LOCALAPPDATA\Programs\reviewgate" -Recurse  # Windows
```

Reviews live in `.git/reviewgate/` of each repo and go with the repo, not with the
install.

## Recommended project settings

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
  "ignore": ["package-lock.json", "dist/**", "**/*.min.js"],
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
npm run build         # core, server, cli and the web bundle
npm test              # vitest: unit and integration
npm run test:e2e      # playwright: happy path and approve path
npm run typecheck
npm run build:binaries  # the release binaries (needs bun)
```

The hook can be tested on its own, without Claude Code:

```bash
echo '{"tool_name":"Bash","cwd":"'$PWD'","tool_input":{"command":"git commit -m test"}}' \
  | reviewgate hook
```

### Releasing

`bun build --compile` turns the CLI into one executable per platform, with the web
build inlined by `scripts/embed-web.mjs` (a binary has no `dist` next to it). Bun is
needed only to compile; everything else runs on npm.

```bash
npm run build:web
node scripts/build-binaries.mjs --version 0.2.0     # all targets, into release/
node scripts/build-binaries.mjs --target bun-linux-x64
```

Cutting a release: bump `version` in `package.json` (the workflow refuses a tag that
disagrees with it), commit, then push the tag.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` runs the tests, compiles the five targets, writes a
`.sha256` next to each one and publishes them as a GitHub release. That release is
what the installer and `reviewgate update` read.

## Limits

- One user, one machine. No remote reviews, no accounts.
- No GitHub or GitLab integration.
- No editing of code in the UI. The UI produces feedback; the agent makes the changes.
- Only `git commit` is a gate, `git push` is not.
- No git-native `pre-commit` hook: commits you make yourself from the terminal go
  through untouched. The gate watches the agent, not you.
