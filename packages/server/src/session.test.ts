import { NodeGitClient, TestRepo } from "@reviewgate/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewAgent } from "./agent.js";
import { Highlighting } from "./highlight.js";
import { Session } from "./session.js";

/**
 * `ReviewAgent.ask` would otherwise spawn the real Claude Agent SDK. Every test here
 * stubs it so chat behavior is exercised without a real assistant.
 */
function stubAsk(answer: string | ((prompt: string) => string) = "an answer") {
  return vi.spyOn(ReviewAgent.prototype, "ask").mockImplementation(async function (
    this: ReviewAgent,
    prompt: string,
    onToken?: (text: string) => void,
  ) {
    const text = typeof answer === "function" ? answer(prompt) : answer;
    onToken?.(text);
    return text;
  });
}

let repo: TestRepo;
let session: Session;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.addAll();
  await repo.commit("base");
  await repo.write("src/a.ts", "export const a = 2;\n");
  await repo.addAll();

  session = await Session.create(
    { git: await NodeGitClient.open(repo.root), scope: "staged", options: {} },
    new Highlighting(),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await repo.cleanup();
});

describe("createChat", () => {
  it("appends exactly one empty chat with defaults and persists it", async () => {
    const review = await session.createChat();
    expect(review.chats).toHaveLength(1);
    expect(review.chats[0]).toMatchObject({ title: "Chat", model: null, messages: [] });
    expect(review.chats[0]?.id).toBeTruthy();

    // Persisted: a fresh load sees it too.
    const reloaded = await session.store.load(review.id);
    expect(reloaded?.chats).toHaveLength(1);
  });

  it("takes the given title and model", async () => {
    const review = await session.createChat("Follow-up", "claude-opus-4");
    expect(review.chats[0]).toMatchObject({ title: "Follow-up", model: "claude-opus-4" });
  });

  it("falls back to the default title when given only whitespace", async () => {
    const review = await session.createChat("   ");
    expect(review.chats[0]?.title).toBe("Chat");
  });
});

describe("chat", () => {
  it("rejects an unknown chatId without creating or crashing anything", async () => {
    await expect(session.chat("nonexistent", "hi")).rejects.toThrow();
    expect(session.review.chats).toEqual([]);
  });

  it("appends the question then the answer to that chat's messages, in order", async () => {
    stubAsk("42");
    const { id: chatId } = (await session.createChat()).chats[0]!;

    const review = await session.chat(chatId, "what is the answer?");
    const chat = review.chats.find((c) => c.id === chatId);
    expect(chat?.messages).toHaveLength(2);
    expect(chat?.messages[0]).toMatchObject({ role: "user", body: "what is the answer?" });
    expect(chat?.messages[1]).toMatchObject({ role: "assistant", body: "42" });
  });

  it("keeps two chats' messages independent of each other", async () => {
    stubAsk((prompt) => (prompt.includes("first chat") ? "reply-first" : "reply-second"));
    const withChats = await session.createChat("first");
    const firstId = withChats.chats[0]!.id;
    const withSecond = await session.createChat("second");
    const secondId = withSecond.chats.find((c) => c.title === "second")!.id;

    await session.chat(firstId, "question in first chat");
    const review = await session.chat(secondId, "question in second chat");

    const first = review.chats.find((c) => c.id === firstId)!;
    const second = review.chats.find((c) => c.id === secondId)!;
    expect(first.messages.map((m) => m.body)).toEqual(["question in first chat", "reply-first"]);
    expect(second.messages.map((m) => m.body)).toEqual([
      "question in second chat",
      "reply-second",
    ]);
  });

  it("gives each chat its own ReviewAgent instance", async () => {
    const receivers: ReviewAgent[] = [];
    vi.spyOn(ReviewAgent.prototype, "ask").mockImplementation(async function (
      this: ReviewAgent,
      _prompt: string,
    ) {
      receivers.push(this);
      return "ok";
    });

    const firstId = (await session.createChat("first")).chats[0]!.id;
    const secondReview = await session.createChat("second");
    const secondId = secondReview.chats.find((c) => c.title === "second")!.id;

    await session.chat(firstId, "hi");
    await session.chat(secondId, "hi");

    expect(receivers).toHaveLength(2);
    expect(receivers[0]).not.toBe(receivers[1]);
  });

  it("reuses the same agent for a second message in the same chat", async () => {
    const receivers: ReviewAgent[] = [];
    vi.spyOn(ReviewAgent.prototype, "ask").mockImplementation(async function (
      this: ReviewAgent,
      _prompt: string,
    ) {
      receivers.push(this);
      return "ok";
    });

    const chatId = (await session.createChat()).chats[0]!.id;
    await session.chat(chatId, "first message");
    await session.chat(chatId, "second message");

    expect(receivers).toHaveLength(2);
    expect(receivers[0]).toBe(receivers[1]);
  });

  it("sends the full context prompt only for the first message in a chat", async () => {
    const prompts: string[] = [];
    vi.spyOn(ReviewAgent.prototype, "ask").mockImplementation(async function (
      this: ReviewAgent,
      prompt: string,
    ) {
      prompts.push(prompt);
      return "ok";
    });

    const chatId = (await session.createChat()).chats[0]!.id;
    await session.chat(chatId, "first question");
    await session.chat(chatId, "second question");

    expect(prompts[0]).toContain("# Diff under review");
    expect(prompts[0]).toContain("# Question");
    expect(prompts[1]).toBe("second question");
  });

  it("rejects an empty question", async () => {
    const chatId = (await session.createChat()).chats[0]!.id;
    await expect(session.chat(chatId, "   ")).rejects.toThrow();
  });
});

describe("chat model (Story 2.1)", () => {
  it("constructs the chat's agent with that chat's model", async () => {
    const contexts: (string | null | undefined)[] = [];
    vi.spyOn(ReviewAgent.prototype, "ask").mockImplementation(async function (this: ReviewAgent) {
      contexts.push(this.context.model);
      return "ok";
    });

    const chatId = (await session.createChat("chat", "claude-opus-4-8")).chats[0]!.id;
    await session.chat(chatId, "hi");

    expect(contexts).toEqual(["claude-opus-4-8"]);
  });

  it("keeps the same agent across messages when the model does not change", async () => {
    const receivers: ReviewAgent[] = [];
    vi.spyOn(ReviewAgent.prototype, "ask").mockImplementation(async function (this: ReviewAgent) {
      receivers.push(this);
      return "ok";
    });

    const chatId = (await session.createChat("chat", "claude-sonnet-5")).chats[0]!.id;
    await session.chat(chatId, "first");
    await session.chat(chatId, "second");

    expect(receivers).toHaveLength(2);
    expect(receivers[0]).toBe(receivers[1]);
  });

  it("recreates the agent under a fresh SDK session when the chat's model changes", async () => {
    const receivers: ReviewAgent[] = [];
    vi.spyOn(ReviewAgent.prototype, "ask").mockImplementation(async function (this: ReviewAgent) {
      receivers.push(this);
      return "ok";
    });

    const chatId = (await session.createChat("chat", "claude-sonnet-5")).chats[0]!.id;
    await session.chat(chatId, "first");

    // Simulate a model change on the chat, as Story 2.2's PATCH route will do.
    const review = session.review;
    await session.commit({
      ...review,
      chats: review.chats.map((c) => (c.id === chatId ? { ...c, model: "claude-opus-4-8" } : c)),
    });

    await session.chat(chatId, "second");

    expect(receivers).toHaveLength(2);
    expect(receivers[0]).not.toBe(receivers[1]);
    expect(receivers[1]?.context.model).toBe("claude-opus-4-8");
  });
});

describe("setChatModel", () => {
  it("updates the matching chat's model and persists it", async () => {
    const chatId = (await session.createChat()).chats[0]!.id;

    const review = await session.setChatModel(chatId, "opus");
    expect(review.chats.find((c) => c.id === chatId)?.model).toBe("opus");

    const reloaded = await session.store.load(review.id);
    expect(reloaded?.chats.find((c) => c.id === chatId)?.model).toBe("opus");
  });

  it("sets the model back to null for Default", async () => {
    const chatId = (await session.createChat("chat", "opus")).chats[0]!.id;

    const review = await session.setChatModel(chatId, null);
    expect(review.chats.find((c) => c.id === chatId)?.model).toBeNull();
  });

  it("treats an empty string the same as null", async () => {
    const chatId = (await session.createChat()).chats[0]!.id;

    const review = await session.setChatModel(chatId, "");
    expect(review.chats.find((c) => c.id === chatId)?.model).toBeNull();
  });

  it("does not touch the chat's messages", async () => {
    stubAsk("42");
    const chatId = (await session.createChat()).chats[0]!.id;
    await session.chat(chatId, "hi");

    const review = await session.setChatModel(chatId, "haiku");
    const chat = review.chats.find((c) => c.id === chatId);
    expect(chat?.messages.map((m) => m.body)).toEqual(["hi", "42"]);
  });

  it("leaves other chats untouched", async () => {
    const firstId = (await session.createChat("first")).chats[0]!.id;
    const secondReview = await session.createChat("second");
    const secondId = secondReview.chats.find((c) => c.title === "second")!.id;

    const review = await session.setChatModel(firstId, "opus");
    expect(review.chats.find((c) => c.id === secondId)?.model).toBeNull();
  });

  it("rejects an unknown chatId", async () => {
    await expect(session.setChatModel("nonexistent", "opus")).rejects.toThrow();
  });

  it("causes the next message in that chat to use a freshly constructed agent with the new model", async () => {
    const receivers: ReviewAgent[] = [];
    vi.spyOn(ReviewAgent.prototype, "ask").mockImplementation(async function (this: ReviewAgent) {
      receivers.push(this);
      return "ok";
    });

    const chatId = (await session.createChat()).chats[0]!.id;
    await session.chat(chatId, "first");
    await session.setChatModel(chatId, "opus");
    await session.chat(chatId, "second");

    expect(receivers).toHaveLength(2);
    expect(receivers[0]).not.toBe(receivers[1]);
    expect(receivers[1]?.context.model).toBe("opus");
  });
});

describe("runReviewPass", () => {
  it("does not read or write review.chats", async () => {
    vi.spyOn(ReviewAgent.prototype, "ask").mockResolvedValue('{"findings":[]}');
    await session.createChat();

    await session.runReviewPass();

    expect(session.passStatus.state).toBe("done");
    expect(session.review.chats).toHaveLength(1);
    expect(session.review.chats[0]?.messages).toEqual([]);
  });
});
