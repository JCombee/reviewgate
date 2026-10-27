import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enablesAutoApprove, readAutoApprove, setAutoApprove } from "./autoApprove.js";

let gitDir: string;

beforeEach(async () => {
  gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "reviewgate-auto-"));
});

afterEach(async () => {
  await fs.rm(gitDir, { recursive: true, force: true });
});

describe("auto-approve switch", () => {
  it("is off until switched on, and off again after", async () => {
    expect(await readAutoApprove(gitDir)).toBeNull();

    await setAutoApprove(gitDir, true, new Date("2026-10-27T10:00:00Z"));
    expect(await readAutoApprove(gitDir)).toEqual({ enabledAt: "2026-10-27T10:00:00.000Z" });

    await setAutoApprove(gitDir, false);
    expect(await readAutoApprove(gitDir)).toBeNull();
  });

  it("switching off when already off is fine", async () => {
    await expect(setAutoApprove(gitDir, false)).resolves.toBeUndefined();
  });

  it("reads a broken file as off", async () => {
    await fs.mkdir(path.join(gitDir, "reviewgate"), { recursive: true });
    await fs.writeFile(path.join(gitDir, "reviewgate", "auto-approve.json"), "{nope", "utf8");
    expect(await readAutoApprove(gitDir)).toBeNull();
  });
});

describe("enablesAutoApprove", () => {
  const cases: Array<[command: string, expected: boolean]> = [
    ["reviewgate auto-approve on", true],
    ["cd x && reviewgate auto-approve   on", true],
    ['bash -c "reviewgate auto-approve on"', true],
    ["npx reviewgate auto-approve on -C ../other", true],
    ["reviewgate auto-approve off", false],
    ["reviewgate auto-approve", false],
    ["reviewgate auto-approve status", false],
    ['git commit -m "auto-approved once"', false],
  ];

  for (const [command, expected] of cases) {
    it(`${command} → ${expected}`, () => {
      expect(enablesAutoApprove(command)).toBe(expected);
    });
  }
});
