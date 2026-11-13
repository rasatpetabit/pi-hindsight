import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "../extensions/types.js";

const mocked = vi.hoisted(() => ({
  client: {
    retain: vi.fn(async (..._args: unknown[]) => undefined),
    recall: vi.fn(async (..._args: unknown[]) => ({
      results: [{ text: "repo-specific remembered fact" }],
    })),
    reflect: vi.fn(async (..._args: unknown[]) => ({})),
    createBank: vi.fn(async (..._args: unknown[]) => undefined),
    getBankProfile: vi.fn(async (..._args: unknown[]) => ({})),
    deleteDocument: vi.fn(async (..._args: unknown[]) => ({ success: true })),
  },
  ensureGlobalBank: vi.fn(async () => undefined),
  ensureProjectBank: vi.fn(async () => undefined),
  checkHindsight: vi.fn(async () => ({ ok: true })),
}));

/** Minimal project config so setup-gate treats the fixture as configured (ADR-005). */
function writeSetupCompleteConfig(cwd: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "hindsight.json"),
    JSON.stringify({
      setupComplete: true,
      hindsight: { baseUrl: "http://unused.test" },
      // Domain-tagged auto memory requires an explicit coding bank id.
      banks: { project: { enabled: true, bankId: "test-coding", derive: "manual" } },
      ...extra,
    }),
  );
}

vi.mock("../extensions/client/client.js", () => ({
  createHindsightClient: () => mocked.client,
  checkHindsight: mocked.checkHindsight,
}));

vi.mock("../extensions/banks/bank-operations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/banks/bank-operations.js")>();
  return {
    ...actual,
    ensureGlobalBank: mocked.ensureGlobalBank,
    ensureProjectBank: mocked.ensureProjectBank,
  };
});

// Append-history semantics do not depend on git-derived project identity, and the
// real resolver shells out to `git` per recall call (~156 spawns across this
// multi-turn scenario), the measured time sink that times the test out on
// windows-latest. Pure deterministic identity keeps the lifecycle path hermetic
// on every OS without weakening any scenario assertion.
vi.mock("../extensions/banks/banking.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/banks/banking.js")>();
  return {
    ...actual,
    resolveProjectIdentity: () => ({
      projectId: "append-history",
      basis: "pin",
      source: "append-history",
      legacyRepoKey: "append-history-legacy",
    }),
    recallScopeTags: () => ["project:append-history", "repo:append-history-legacy"],
    baseTags: (_cwd: string, sessionId: string, leafIdOrConfig?: string | ResolvedConfig) => {
      const leafId = typeof leafIdOrConfig === "string" ? leafIdOrConfig : undefined;
      return [
        "source:pi",
        "harness:pi",
        "project:append-history",
        "repo:append-history-legacy",
        `session:${sessionId}`,
        ...(leafId ? [`branch:${leafId}`] : []),
      ];
    },
  };
});

describe("append recall history", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-hindsight-home-"));
    vi.useRealTimers();
    vi.clearAllMocks();
    mocked.client.recall.mockImplementation(async (..._args: unknown[]) => ({
      results: [{ text: "repo-specific remembered fact" }],
    }));
    mocked.client.retain.mockImplementation(async (..._args: unknown[]) => undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });
  it("keeps active append snapshots independent of TTL, branch leaf and session changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-history-"));
    mkdirSync(join(cwd, ".git"));
    writeSetupCompleteConfig(cwd, {
      recall: { injectionPosition: "append", storeLastRecall: false },
    });
    const { createMemoryLifecycle } = await import("../extensions/lifecycle/memory-lifecycle.js");
    const lifecycle = createMemoryLifecycle(cwd);
    let session = "session-a";
    let branch: any[] = [];
    const ctx = {
      cwd,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: {
        getSessionId: () => session,
        getSessionFile: () => join(cwd, `${session}.jsonl`),
        getBranch: () => branch,
      },
    };
    await lifecycle.initialize(ctx);
    let count = 0;
    mocked.client.recall.mockImplementation(async () => ({
      results: [{ text: `recall-${++count}` }],
    }));
    const user = (timestamp: number) => ({ role: "user", content: "identical prompt", timestamp });
    const t1 = user(1),
      t2 = user(2),
      t3 = user(3);
    const tool = { role: "toolResult", content: "result", timestamp: 4 };
    const recall = async (messages: any[], ids: string[]) => {
      branch = messages.map((message, i) => ({ type: "message", id: ids[i], message }));
      const original = structuredClone(messages);
      const patch = await lifecycle.recall({ messages } as any, ctx);
      expect(messages).toEqual(original);
      expect(JSON.stringify(messages)).not.toContain("hindsight-memory");
      return patch?.messages ?? messages;
    };
    const a = await recall([t1], ["u1"]);
    vi.setSystemTime(Date.now() + 61_000);
    const b = await recall([t1, tool], ["u1", "tool1"]);
    expect(b).toEqual([...a, tool]);
    expect(await recall([t1, tool], ["u1", "changing-leaf"])).toEqual(b);
    expect(count).toBe(1);
    expect(
      await lifecycle.recall({ messages: [t1, tool] } as any, {
        ...ctx,
        signal: AbortSignal.abort(),
      }),
    ).toBeUndefined();
    expect(await recall([t1, tool], ["u1", "tool1"])).toEqual(b);
    const c = await recall([t1, tool, t2], ["u1", "tool1", "u2"]);
    expect(c.slice(0, b.length)).toEqual(b);
    vi.setSystemTime(Date.now() + 61_000);
    const d = await recall([t1, tool, t2, tool], ["u1", "tool1", "u2", "tool2"]);
    expect(d).toEqual([...c, tool]);
    const e = await recall([t1, tool, t2, tool, t3], ["u1", "tool1", "u2", "tool2", "u3"]);
    expect(e.slice(0, d.length)).toEqual(d);
    expect(e.filter((m) => String(m.content).includes("hindsight-memory"))).toHaveLength(3);
    expect(count).toBe(3);
    // Rewind preserves the common ancestor, prunes descendants. Same timestamp/content
    // on a sibling is still a distinct entry, not a leaf-ID or prompt-text cache key.
    expect(await recall([t1], ["u1"])).toEqual(a);
    vi.setSystemTime(Date.now() + 61_000);
    const sibling = await recall([t1, tool, t2], ["u1", "tool1", "sibling-u2"]);
    expect(sibling.slice(0, a.length)).toEqual(a);
    expect(sibling.at(-2)?.content).toContain("recall-4");
    expect(JSON.stringify(sibling)).not.toContain("recall-2");
    // Compaction leaves only t2: its position is reconstructed, t1 is pruned.
    const compacted = await recall([t2, tool], ["sibling-u2", "tool2"]);
    expect(compacted[0]?.content).toContain("recall-4");
    expect(JSON.stringify(compacted)).not.toContain("recall-1");
    await recall([], []); // reset prunes all, even if IDs are later encountered again
    expect(await recall([t2, tool], ["sibling-u2", "tool2"])).toEqual([t2, tool]);
    expect(count).toBe(4); // never fetch beside already-sent history
    session = "session-b";
    expect(await recall([t1, tool], ["u1", "tool1"])).toEqual([t1, tool]);
    vi.setSystemTime(Date.now() + 61_000);
    const switched = await recall([t1, tool, t2], ["u1", "tool1", "u2"]);
    expect(switched.at(-2)?.content).toContain("recall-5");
    expect(JSON.stringify(switched)).not.toContain("recall-1");
    // Explicit reload creates a new ephemeral epoch, not retrospective recall.
    const reloaded = createMemoryLifecycle(cwd);
    expect(await reloaded.recall({ messages: [t1, tool] } as any, ctx)).toBeUndefined();
    expect(existsSync(join(cwd, ".pi", "hindsight", "last-recall.json"))).toBe(false);
    expect(mocked.client.retain).not.toHaveBeenCalled();
  });

  it("attaches the recall to the prompt when run-start custom messages follow it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-history-"));
    mkdirSync(join(cwd, ".git"));
    writeSetupCompleteConfig(cwd, {
      recall: { injectionPosition: "append", storeLastRecall: false },
    });
    const { createMemoryLifecycle } = await import("../extensions/lifecycle/memory-lifecycle.js");
    const lifecycle = createMemoryLifecycle(cwd);
    let branch: any[] = [];
    const ctx = {
      cwd,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: {
        getSessionId: () => "session-a",
        getSessionFile: () => join(cwd, "session-a.jsonl"),
        getBranch: () => branch,
      },
    };
    await lifecycle.initialize(ctx);
    let count = 0;
    mocked.client.recall.mockImplementation(async () => ({
      results: [{ text: `recall-${++count}` }],
    }));
    const user = (content: string, timestamp: number) => ({ role: "user", content, timestamp });
    // Shape Pi gives a message returned from another extension's before_agent_start handler.
    const runStart = (timestamp: number) => ({
      role: "custom",
      customType: "other-extension-run-context",
      content: "run-start block from another extension",
      display: false,
      timestamp,
    });
    const assistant = { role: "assistant", content: "answer", timestamp: 3 };
    const tool = { role: "toolResult", content: "result", timestamp: 4 };
    const recall = async (messages: any[], ids: string[]) => {
      branch = messages.map((message, i) =>
        message.role === "custom"
          ? { type: "custom_message", id: ids[i], customType: message.customType }
          : { type: "message", id: ids[i], message },
      );
      const original = structuredClone(messages);
      const patch = await lifecycle.recall({ messages } as any, ctx);
      expect(messages).toEqual(original);
      return patch?.messages ?? messages;
    };
    const u1 = user("first prompt", 1);
    const c1 = runStart(2);

    // First request of the run: the recall goes before the prompt, not before the run-start block.
    const first = await recall([u1, c1], ["u1", "c1"]);
    expect(first).toHaveLength(3);
    expect(first[0]?.content).toContain("recall-1");
    expect(first.slice(1)).toEqual([u1, c1]);
    const queries = JSON.stringify(mocked.client.recall.mock.calls);
    expect(queries).toContain("first prompt");
    expect(queries).not.toContain("run-start block from another extension");

    // Sending the opening request again, or with one more run-start message, reuses that recall.
    expect(await recall([u1, c1], ["u1", "c1"])).toEqual(first);
    const c1b = { ...runStart(2), customType: "second-extension-run-context" };
    expect(await recall([u1, c1, c1b], ["u1", "c1", "c1b"])).toEqual([...first, c1b]);
    expect(count).toBe(1);

    // Later requests of the run extend the first one: same recall, same position.
    const second = await recall([u1, c1, assistant, tool], ["u1", "c1", "a1", "tool1"]);
    expect(second).toEqual([...first, assistant, tool]);

    // A run opened by a custom message has no prompt to attach a recall to.
    const notice = { ...runStart(5), customType: "background-notice", content: "run finished" };
    const c2 = runStart(6);
    const customRun = await recall([u1, c1, assistant, notice, c2], ["u1", "c1", "a1", "n1", "c2"]);
    expect(customRun).toEqual([...first, assistant, notice, c2]);
    expect(count).toBe(1);

    // The next prompt gets its own recall, again before the prompt.
    const u2 = user("second prompt", 7);
    const c3 = runStart(8);
    const next = await recall([u1, c1, assistant, u2, c3], ["u1", "c1", "a1", "u2", "c3"]);
    expect(next.slice(0, 4)).toEqual([...first, assistant]);
    expect(next[4]?.content).toContain("recall-2");
    expect(next.slice(5)).toEqual([u2, c3]);
    expect(
      await recall([u1, c1, assistant, u2, c3, tool], ["u1", "c1", "a1", "u2", "c3", "tool2"]),
    ).toEqual([...next, tool]);
    expect(count).toBe(2);
  });
});

describe("appendRecallAnchorIndex", () => {
  it("finds the prompt only when nothing but custom messages follows it", async () => {
    const { appendRecallAnchorIndex } =
      await import("../extensions/lifecycle/memory-lifecycle-recall.js");
    const roles = (...list: string[]) => list.map((role) => ({ role }));
    expect(appendRecallAnchorIndex([])).toBeUndefined();
    expect(appendRecallAnchorIndex(roles("assistant", "user"))).toBe(1);
    expect(appendRecallAnchorIndex(roles("user", "custom", "custom"))).toBe(0);
    expect(appendRecallAnchorIndex(roles("user", "custom", "user", "custom"))).toBe(2);
    expect(appendRecallAnchorIndex(roles("user", "assistant", "custom"))).toBeUndefined();
    expect(appendRecallAnchorIndex(roles("user", "toolResult"))).toBeUndefined();
    expect(appendRecallAnchorIndex(roles("custom"))).toBeUndefined();
  });
});
