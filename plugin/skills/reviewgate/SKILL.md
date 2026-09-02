---
name: reviewgate
description: Explains how the ReviewGate commit gate works and how to work through its feedback. Use this when a commit is blocked with "Code review: changes requested", when the user asks why a commit will not go through, or when you want to open a review without committing.
---

# ReviewGate

Every `git commit` in this repo goes past a human review. A PreToolUse hook intercepts
the command, opens a review in the browser and blocks until there is a decision. That
deny holds in every permission mode, so the gate cannot be bypassed.

## What to do when a commit is blocked

The feedback comes back as markdown, grouped per file, with line numbers.

1. **Points without a `?`** are things to fix. Fix them in the code.
2. **Points with a `?`** are questions. Answer those in your reply to the user; they
   need no fix.
3. If there is a **Summary** at the top, read that first: it gives the order and the
   direction, and it comes before the individual points.
4. If there is a **Commit message** block, use exactly that message.
5. Commit again afterwards. A new round of the same review follows, in which the
   reviewer can see whether your earlier points were addressed.

## What not to do

- Do not use `--no-verify`. It is refused with a separate message.
- Do not stage and commit in one command when you can separate them. With
  `git add -A && git commit` nothing is in the index at hook time, so the gate reviews
  the entire working tree.
- Do not write into `.git/reviewgate/` yourself.

## Opening a review without committing

`reviewgate open --staged` shows the staged changes, `--working` the whole working
tree. The command prints a URL; hand that to the user.
