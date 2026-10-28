import { describe, expect, it } from "vitest";
import { analyzeCommand, rewriteWithMessageFile, splitCommand } from "./command.js";

describe("splitCommand", () => {
  it("splits on && and keeps quotes together", () => {
    expect(splitCommand(`git add -A && git commit -m "fix: something with spaces"`)).toEqual([
      ["git", "add", "-A"],
      ["git", "commit", "-m", "fix: something with spaces"],
    ]);
  });

  it("splits on ;, | and || as well", () => {
    expect(splitCommand("a; b | c || d")).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("keeps an empty string as its own argument", () => {
    expect(splitCommand(`git commit -m ""`)).toEqual([["git", "commit", "-m", ""]]);
  });

  it("honours single quotes and escapes", () => {
    expect(splitCommand(`git commit -m 'the "quote"' --amend`)).toEqual([
      ["git", "commit", "-m", 'the "quote"', "--amend"],
    ]);
    expect(splitCommand(`git commit -m a\\ b`)).toEqual([["git", "commit", "-m", "a b"]]);
  });
});

describe("analyzeCommand", () => {
  const cases: Array<{
    name: string;
    command: string;
    expected: Partial<ReturnType<typeof analyzeCommand>>;
  }> = [
    {
      name: "plain commit with a message",
      command: `git commit -m "fix: cache"`,
      expected: { isCommit: true, scope: "staged", message: "fix: cache", noVerify: false },
    },
    {
      name: "add and commit in one chain",
      command: `git add -A && git commit -m "fix: cache"`,
      // Nothing is staged at hook time, so the working tree is the scope (§2).
      expected: { isCommit: true, scope: "working" },
    },
    {
      name: "commit -am",
      command: `git commit -am "fix: cache"`,
      expected: { isCommit: true, scope: "working", message: "fix: cache" },
    },
    {
      name: "commit -a separately",
      command: `git commit -a -m "x"`,
      expected: { isCommit: true, scope: "working" },
    },
    {
      name: "amend",
      command: `git commit --amend -m "better"`,
      expected: { isCommit: true, scope: "amend", amend: true },
    },
    {
      name: "amend wins over -a",
      command: `git commit -a --amend --no-edit`,
      expected: { scope: "amend", amend: true },
    },
    {
      name: "no-verify",
      command: `git commit --no-verify -m "x"`,
      expected: { isCommit: true, noVerify: true },
    },
    {
      name: "no-verify as a bundled short flag",
      command: `git commit -nm "x"`,
      expected: { noVerify: true, message: "x" },
    },
    {
      name: "several -m values are joined",
      command: `git commit -m "subject" -m "and the body"`,
      expected: { message: "subject\n\nand the body" },
    },
    {
      name: "--message= form",
      command: `git commit --message=short`,
      expected: { message: "short" },
    },
    {
      name: "message from a file",
      command: `git commit -F /tmp/msg.txt`,
      expected: { message: null, messageFile: "/tmp/msg.txt" },
    },
    {
      name: "global options before the subcommand",
      command: `git -c user.name=x commit -m "y"`,
      expected: { isCommit: true, message: "y" },
    },
    {
      name: "not a commit",
      command: `git status --short`,
      expected: { isCommit: false },
    },
    {
      name: "a word that merely looks like one",
      command: `echo "git commit"`,
      expected: { isCommit: false },
    },
    {
      name: "add of specific paths is replayed, not widened to the working tree",
      command: `git add src/a.ts "dir with space/b.ts" && git commit -m "x"`,
      expected: { scope: "working", stage: [["add", "src/a.ts", "dir with space/b.ts"]] },
    },
    {
      name: "commit -a stages the tracked files",
      command: `git add new.ts && git commit -am "x"`,
      expected: { stage: [["add", "new.ts"], ["add", "-u"]] },
    },
    {
      name: "rm is replayed with --cached, so the replay deletes nothing",
      command: `git -C sub rm -r old && git commit -m "x"`,
      expected: { stage: [["-C", "sub", "rm", "--cached", "-r", "old"]] },
    },
    {
      name: "a plain commit stages nothing",
      command: `git commit -m "x"`,
      expected: { scope: "staged", stage: [] },
    },
    {
      name: "a git add after the commit does not count",
      command: `git commit -m "x" && git add -A`,
      expected: { scope: "staged", stage: [] },
    },
    {
      name: "interactive add cannot be replayed",
      command: `git add -p && git commit -m "x"`,
      expected: { scope: "working", stage: null },
    },
    {
      name: "bundled interactive add cannot be replayed",
      command: `git add -vp src && git commit -m "x"`,
      expected: { stage: null },
    },
    {
      name: "a path that looks like a flag after -- is fine",
      command: `git add -- -p && git commit -m "x"`,
      expected: { stage: [["add", "--", "-p"]] },
    },
    {
      name: "a cd before the add cannot be replayed",
      command: `cd sub && git add a.ts && git commit -m "x"`,
      expected: { stage: null },
    },
    {
      name: "mv cannot be replayed",
      command: `git mv a.ts b.ts && git commit -m "x"`,
      expected: { stage: null },
    },
    {
      name: "push is not a gate",
      command: `git push origin main`,
      expected: { isCommit: false },
    },
  ];

  for (const { name, command, expected } of cases) {
    it(name, () => {
      expect(analyzeCommand(command)).toMatchObject(expected);
    });
  }
});

describe("rewriteWithMessageFile", () => {
  it("replaces -m with -F and leaves the rest alone", () => {
    expect(rewriteWithMessageFile(`git commit -m "old" --no-edit`, "/tmp/msg")).toBe(
      "git commit --no-edit -F /tmp/msg",
    );
  });

  it("keeps the chain intact", () => {
    expect(rewriteWithMessageFile(`git add -A && git commit -m "old"`, "/tmp/msg")).toBe(
      "git add -A && git commit -F /tmp/msg",
    );
  });

  it("keeps -a when -am is split up", () => {
    expect(rewriteWithMessageFile(`git commit -am "old"`, "/tmp/msg")).toBe(
      "git commit -a -F /tmp/msg",
    );
  });

  it("replaces an existing -F too", () => {
    expect(rewriteWithMessageFile(`git commit -F /tmp/old`, "/tmp/new")).toBe(
      "git commit -F /tmp/new",
    );
  });

  it("quotes a path with spaces", () => {
    const out = rewriteWithMessageFile(`git commit -m "x"`, "/path with space/msg");
    expect(out).toBe("git commit -F '/path with space/msg'");
  });
});
