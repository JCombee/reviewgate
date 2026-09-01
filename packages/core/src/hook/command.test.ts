import { describe, expect, it } from "vitest";
import { analyzeCommand, rewriteWithMessageFile, splitCommand } from "./command.js";

describe("splitCommand", () => {
  it("splitst op && en houdt quotes bij elkaar", () => {
    expect(splitCommand(`git add -A && git commit -m "fix: iets met spaties"`)).toEqual([
      ["git", "add", "-A"],
      ["git", "commit", "-m", "fix: iets met spaties"],
    ]);
  });

  it("splitst ook op ;, | en ||", () => {
    expect(splitCommand("a; b | c || d")).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("laat een lege string als eigen argument staan", () => {
    expect(splitCommand(`git commit -m ""`)).toEqual([["git", "commit", "-m", ""]]);
  });

  it("respecteert enkele quotes en escapes", () => {
    expect(splitCommand(`git commit -m 'het "citaat"' --amend`)).toEqual([
      ["git", "commit", "-m", 'het "citaat"', "--amend"],
    ]);
    expect(splitCommand(`git commit -m a\\ b`)).toEqual([["git", "commit", "-m", "a b"]]);
  });
});

describe("analyzeCommand", () => {
  const cases: Array<{
    naam: string;
    command: string;
    verwacht: Partial<ReturnType<typeof analyzeCommand>>;
  }> = [
    {
      naam: "gewone commit met message",
      command: `git commit -m "fix: cache"`,
      verwacht: { isCommit: true, scope: "staged", message: "fix: cache", noVerify: false },
    },
    {
      naam: "add en commit in één keten",
      command: `git add -A && git commit -m "fix: cache"`,
      // Er is op hook-tijd nog niets gestaged, dus de working tree is de scope (§2).
      verwacht: { isCommit: true, scope: "working" },
    },
    {
      naam: "commit -am",
      command: `git commit -am "fix: cache"`,
      verwacht: { isCommit: true, scope: "working", message: "fix: cache" },
    },
    {
      naam: "commit -a los",
      command: `git commit -a -m "x"`,
      verwacht: { isCommit: true, scope: "working" },
    },
    {
      naam: "amend",
      command: `git commit --amend -m "beter"`,
      verwacht: { isCommit: true, scope: "amend", amend: true },
    },
    {
      naam: "amend wint van -a",
      command: `git commit -a --amend --no-edit`,
      verwacht: { scope: "amend", amend: true },
    },
    {
      naam: "no-verify",
      command: `git commit --no-verify -m "x"`,
      verwacht: { isCommit: true, noVerify: true },
    },
    {
      naam: "no-verify als samengevoegde korte vlag",
      command: `git commit -nm "x"`,
      verwacht: { noVerify: true, message: "x" },
    },
    {
      naam: "meerdere -m worden samengevoegd",
      command: `git commit -m "kop" -m "en de body"`,
      verwacht: { message: "kop\n\nen de body" },
    },
    {
      naam: "--message= vorm",
      command: `git commit --message=kort`,
      verwacht: { message: "kort" },
    },
    {
      naam: "message uit een bestand",
      command: `git commit -F /tmp/msg.txt`,
      verwacht: { message: null, messageFile: "/tmp/msg.txt" },
    },
    {
      naam: "globale opties vóór het subcommando",
      command: `git -c user.name=x commit -m "y"`,
      verwacht: { isCommit: true, message: "y" },
    },
    {
      naam: "geen commit",
      command: `git status --short`,
      verwacht: { isCommit: false },
    },
    {
      naam: "commit in een woord dat er alleen op lijkt",
      command: `echo "git commit"`,
      verwacht: { isCommit: false },
    },
    {
      naam: "push is geen gate",
      command: `git push origin main`,
      verwacht: { isCommit: false },
    },
  ];

  for (const { naam, command, verwacht } of cases) {
    it(naam, () => {
      expect(analyzeCommand(command)).toMatchObject(verwacht);
    });
  }
});

describe("rewriteWithMessageFile", () => {
  it("vervangt -m door -F en laat de rest staan", () => {
    expect(rewriteWithMessageFile(`git commit -m "oud" --no-edit`, "/tmp/msg")).toBe(
      "git commit --no-edit -F /tmp/msg",
    );
  });

  it("houdt de keten intact", () => {
    expect(rewriteWithMessageFile(`git add -A && git commit -m "oud"`, "/tmp/msg")).toBe(
      "git add -A && git commit -F /tmp/msg",
    );
  });

  it("laat -a staan als -am gesplitst wordt", () => {
    expect(rewriteWithMessageFile(`git commit -am "oud"`, "/tmp/msg")).toBe(
      "git commit -a -F /tmp/msg",
    );
  });

  it("vervangt ook een bestaande -F", () => {
    expect(rewriteWithMessageFile(`git commit -F /tmp/oud`, "/tmp/nieuw")).toBe(
      "git commit -F /tmp/nieuw",
    );
  });

  it("quoot een pad met spaties", () => {
    const out = rewriteWithMessageFile(`git commit -m "x"`, "/pad met spatie/msg");
    expect(out).toBe("git commit -F '/pad met spatie/msg'");
  });
});
