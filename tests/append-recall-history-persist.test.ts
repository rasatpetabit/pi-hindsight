import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import { createRecallTurnPolicy } from "../extensions/lifecycle/memory-lifecycle-recall.js";
import type { RuntimeSnapshot } from "../extensions/lifecycle/memory-lifecycle-runtime.js";
import type { HindsightLikeClient, ResolvedConfig } from "../extensions/types.js";
import { stableSessionId } from "../extensions/utils/session.js";

const mocked = vi.hoisted(() => ({
  client: {
    retain: vi.fn(async () => undefined),
    recall: vi.fn(async () => ({ results: [{ text: "session-manager-fact" }] })),
    reflect: vi.fn(async () => ({})),
    createBank: vi.fn(async () => undefined),
    getBankProfile: vi.fn(async () => ({})),
    deleteDocument: vi.fn(async () => ({ success: true })),
  },
  ensureProjectBank: vi.fn(async () => undefined),
  ensureGlobalBank: vi.fn(async () => undefined),
}));

vi.mock("../extensions/client/client.js", () => ({
  createHindsightClient: () => mocked.client,
  checkHindsight: async () => ({ ok: true }),
}));

vi.mock("../extensions/banks/bank-operations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/banks/bank-operations.js")>();
  return {
    ...actual,
    ensureGlobalBank: mocked.ensureGlobalBank,
    ensureProjectBank: mocked.ensureProjectBank,
  };
});

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

type ChatMessage = {
  role: string;
  content?: string;
  timestamp: number;
  customType?: string;
  display?: boolean;
};

type BranchEntry = {
  type: string;
  id: string;
  message?: ChatMessage;
  customType?: string;
};

type RecallPatch = {
  messages?: Array<{ role?: string; content?: unknown; timestamp?: number }>;
};

const config: ResolvedConfig = {
  ...DEFAULT_CONFIG,
  setupComplete: true,
  banks: {
    ...DEFAULT_CONFIG.banks,
    project: { enabled: true, bankId: "test-coding", derive: "manual" },
  },
  recall: {
    ...DEFAULT_CONFIG.recall,
    injectionPosition: "append",
    storeLastRecall: false,
  },
  mentalModels: { ...DEFAULT_CONFIG.mentalModels, inject: false },
};

function user(content: string, timestamp: number): ChatMessage {
  return { role: "user", content, timestamp };
}

function assistant(content: string, timestamp: number): ChatMessage {
  return { role: "assistant", content, timestamp };
}

function messageEntry(id: string, message: ChatMessage): BranchEntry {
  return { type: "message", id, message };
}

function recallHistoryFile(home: string, sessionFile: string, cwd: string, key: string): string {
  return join(
    home,
    ".pi",
    "agent",
    "hindsight",
    "recall-history",
    stableSessionId(sessionFile, cwd),
    `${createHash("sha256").update(key).digest("hex")}.json`,
  );
}

function runtime(
  cwd: string,
  branch: BranchEntry[],
  options?: { sessionFile?: string | null },
): RuntimeSnapshot {
  const sessionFile =
    options?.sessionFile === null
      ? undefined
      : (options?.sessionFile ?? join(cwd, "session.jsonl"));
  return {
    cwd,
    ui: { setStatus: () => undefined, notify: () => undefined },
    sessionId: "session-a",
    ...(sessionFile ? { sessionFile } : {}),
    branch: branch as unknown as SessionEntry[],
  };
}

function recallClient(label: { n: number }, prefix = "recall") {
  return vi.fn(async () => {
    label.n += 1;
    return { results: [{ text: `${prefix}-${label.n}` }] };
  });
}

function policyFor(args: {
  recall: HindsightLikeClient["recall"];
  getClient?: () => HindsightLikeClient;
  notify?: (runtime: RuntimeSnapshot, message: string, level: "info" | "warning") => void;
  setMemoryStatus?: (runtime: RuntimeSnapshot, activity: string) => void;
  config?: ResolvedConfig;
  recallHistory?: {
    read: (
      runtime: RuntimeSnapshot,
      key: string,
    ) => { key: string; rendered: string; timestamp: number } | undefined;
    write: (
      runtime: RuntimeSnapshot,
      snapshot: { key: string; rendered: string; timestamp: number },
    ) => void;
  };
}) {
  return createRecallTurnPolicy({
    getConfig: () => args.config ?? config,
    getClient:
      args.getClient ??
      (() => ({
        retain: async () => undefined,
        recall: args.recall,
        reflect: async () => ({}),
      })),
    setMemoryStatus: args.setMemoryStatus ?? (() => undefined),
    notify: args.notify ?? (() => undefined),
    ...(args.recallHistory ? { recallHistory: args.recallHistory } : {}),
  });
}

describe("append recall history persistence", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  function fixture() {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-recall-persist-"));
    mkdirSync(join(cwd, ".git"));
    const home = mkdtempSync(join(tmpdir(), "pi-hindsight-home-"));
    process.env.HOME = home;
    const sessionFile = join(cwd, "session.jsonl");
    return { cwd, home, sessionFile };
  }

  async function turn(
    policy: ReturnType<typeof policyFor>,
    cwd: string,
    sessionFile: string | null,
    messages: ChatMessage[],
    branch: BranchEntry[],
  ): Promise<Array<{ role?: string; content?: unknown; timestamp?: number }>> {
    const patch = (await policy.recall(
      { messages } as never,
      runtime(cwd, branch, { sessionFile }),
    )) as RecallPatch | undefined;
    return patch?.messages ?? messages;
  }

  it("reproduces the recall-bearing request prefix byte-identically after reload and does not refetch earlier turns", async () => {
    const { cwd, home, sessionFile } = fixture();
    const firstCount = { n: 0 };
    const first = policyFor({ recall: recallClient(firstCount) });
    const user1 = user("first prompt", 1);
    const user2 = user("second prompt", 3);
    const user3 = user("third prompt", 5);
    const assistant1 = assistant("answer-1", 2);
    const assistant2 = assistant("answer-2", 4);
    const branch1 = [messageEntry("u1", user1)];
    const branch2 = [...branch1, messageEntry("a1", assistant1), messageEntry("u2", user2)];
    const branch3 = [...branch2, messageEntry("a2", assistant2), messageEntry("u3", user3)];

    await turn(first, cwd, sessionFile, [user1], branch1);
    const last = await turn(first, cwd, sessionFile, [user1, assistant1, user2], branch2);
    expect(firstCount.n).toBe(2);

    const reloadedCount = { n: 0 };
    const reloaded = policyFor({ recall: recallClient(reloadedCount, "fresh") });
    const fresh = await turn(
      reloaded,
      cwd,
      sessionFile,
      [user1, assistant1, user2, assistant2, user3],
      branch3,
    );

    expect(JSON.stringify(fresh.slice(0, last.length))).toBe(JSON.stringify(last));
    expect(reloadedCount.n).toBe(1);
    expect(String(fresh.at(-2)?.content)).toContain("fresh-1");
    expect(JSON.stringify(fresh.slice(0, last.length))).not.toContain("fresh-");

    const anchorFile = recallHistoryFile(home, sessionFile, cwd, "u2");
    const written = readFileSync(anchorFile);
    const mtime = statSync(anchorFile).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await turn(first, cwd, sessionFile, [user1, assistant1, user2], branch2);
    expect(statSync(anchorFile).mtimeMs).toBe(mtime);
    expect(readFileSync(anchorFile)).toEqual(written);
    expect(firstCount.n).toBe(2);
    for (const key of ["u1", "u2"]) {
      const parsed = JSON.parse(
        readFileSync(recallHistoryFile(home, sessionFile, cwd, key), "utf8"),
      ) as {
        key: string;
      };
      expect(Object.keys(parsed).sort()).toEqual(["key", "rendered", "timestamp"]);
      expect(parsed.key).toBe(key);
    }
  });

  it("re-renders earlier recalls after reload for a run opened only by custom messages after an assistant message", async () => {
    const { cwd, sessionFile } = fixture();
    const first = policyFor({ recall: recallClient({ n: 0 }) });
    const user1 = user("first prompt", 1);
    const user2 = user("second prompt", 3);
    const assistant1 = assistant("answer-1", 2);
    const assistant2 = assistant("answer-2", 4);
    const opener: ChatMessage = {
      role: "custom",
      customType: "other-extension-run-context",
      content: "background workflow opened this run",
      display: false,
      timestamp: 6,
    };
    const branch2 = [
      messageEntry("u1", user1),
      messageEntry("a1", assistant1),
      messageEntry("u2", user2),
    ];
    await turn(first, cwd, sessionFile, [user1], [messageEntry("u1", user1)]);
    const last = await turn(first, cwd, sessionFile, [user1, assistant1, user2], branch2);

    const reloadedCount = { n: 0 };
    const reloaded = policyFor({ recall: recallClient(reloadedCount) });
    const messages = [user1, assistant1, user2, assistant2, opener];
    const patch = (await reloaded.recall(
      { messages } as never,
      runtime(cwd, [...branch2, messageEntry("a2", assistant2)], { sessionFile }),
    )) as RecallPatch | undefined;

    expect(reloadedCount.n).toBe(0);
    expect(patch?.messages?.slice(0, last.length)).toEqual(last);
    expect(patch?.messages?.slice(last.length)).toEqual([assistant2, opener]);
  });

  it("restores a recall when branching at its anchor", async () => {
    const { cwd, sessionFile } = fixture();
    const user1 = user("anchor prompt", 1);
    const sibling = user("sibling prompt", 2);
    const firstCount = { n: 0 };
    const first = policyFor({ recall: recallClient(firstCount) });
    const anchored = await turn(first, cwd, sessionFile, [user1], [messageEntry("u1", user1)]);
    expect(firstCount.n).toBe(1);

    const reloadedCount = { n: 0 };
    const reloaded = policyFor({ recall: recallClient(reloadedCount, "sibling") });
    const fresh = await turn(
      reloaded,
      cwd,
      sessionFile,
      [user1, sibling],
      [messageEntry("u1", user1), messageEntry("u2", sibling)],
    );

    expect(reloadedCount.n).toBe(1);
    expect(fresh[0]).toEqual(anchored[0]);
    expect(String(fresh[2]?.content)).toContain("sibling-1");
    expect(JSON.stringify(fresh[0])).not.toContain("sibling-");
  });

  it("does not share recall for identical prompt text on sibling branches", async () => {
    const { cwd, home, sessionFile } = fixture();
    const prompt = user("same words", 10);
    const first = policyFor({
      recall: async () => ({ results: [{ text: "branch-a-fact" }] }),
    });
    const branchA = await turn(
      first,
      cwd,
      sessionFile,
      [prompt],
      [messageEntry("branch-a", prompt)],
    );
    expect(String(branchA[0]?.content)).toContain("branch-a-fact");

    const secondCount = { n: 0 };
    const second = policyFor({ recall: recallClient(secondCount, "branch-b") });
    const branchB = await turn(
      second,
      cwd,
      sessionFile,
      [prompt],
      [messageEntry("branch-b", prompt)],
    );

    expect(secondCount.n).toBe(1);
    expect(JSON.stringify(branchB)).not.toContain("branch-a-fact");
    expect(String(branchB[0]?.content)).toContain("branch-b-1");
    const fileA = JSON.parse(
      readFileSync(recallHistoryFile(home, sessionFile, cwd, "branch-a"), "utf8"),
    ) as {
      rendered: string;
    };
    const fileB = JSON.parse(
      readFileSync(recallHistoryFile(home, sessionFile, cwd, "branch-b"), "utf8"),
    ) as {
      rendered: string;
    };
    expect(fileA.rendered).not.toBe(fileB.rendered);
    expect(fileA.rendered).toContain("branch-a-fact");
    expect(fileB.rendered).toContain("branch-b-1");
  });

  it("does not write a session or transcript entry", async () => {
    const { cwd, sessionFile } = fixture();
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "hindsight.json"),
      JSON.stringify({
        setupComplete: true,
        hindsight: { baseUrl: "http://unused.test" },
        banks: { project: { enabled: true, bankId: "test-coding", derive: "manual" } },
        recall: { injectionPosition: "append", storeLastRecall: false },
        notifications: { startup: false },
      }),
    );
    const prompt = user("session manager prompt", 1);
    const branch = [messageEntry("u1", prompt)];
    const branchSnapshot = structuredClone(branch);
    const sessionAppend = vi.fn();
    const sessionManager = {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-a",
      getBranch: () => branch,
      appendEntry: sessionAppend,
    };
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>> = {};
    const piAppend = vi.fn();
    const pi = {
      appendEntry: piAppend,
      events: { emit: vi.fn() },
      on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers[name] = [...(handlers[name] ?? []), handler];
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    };
    const { default: hindsightExtension } = await import("../extensions/index.js");
    hindsightExtension(pi as never);
    const ctx = {
      cwd,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager,
    };
    await handlers.session_start?.[0]?.({}, ctx);
    const result = (await handlers.context?.[0]?.({ messages: [prompt] }, ctx)) as
      | RecallPatch
      | undefined;

    expect(String(result?.messages?.[0]?.content)).toContain("session-manager-fact");
    expect(piAppend).not.toHaveBeenCalled();
    expect(sessionAppend).not.toHaveBeenCalled();
    expect(branch).toEqual(branchSnapshot);
    expect(existsSync(sessionFile)).toBe(false);
    expect(readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8")).not.toContain(
      "appendEntry",
    );
  });

  it("writes nothing for an ephemeral session or a fallback anchor key", async () => {
    const { cwd, home, sessionFile } = fixture();
    const root = join(home, ".pi", "agent", "hindsight", "recall-history");
    const prompt = user("ephemeral prompt", 1);
    const ephemeral = policyFor({ recall: recallClient({ n: 0 }) });
    const ephemeralPatch = await turn(ephemeral, cwd, null, [prompt], [messageEntry("u1", prompt)]);
    expect(String(ephemeralPatch[0]?.content)).toContain("recall-1");
    expect(existsSync(root)).toBe(false);

    const fallback = policyFor({ recall: recallClient({ n: 0 }, "fallback") });
    const fallbackPatch = await turn(fallback, cwd, sessionFile, [prompt], []);
    expect(String(fallbackPatch[0]?.content)).toContain("fallback-1");
    expect(existsSync(root)).toBe(false);
  });

  it("creates the sidecar directory at 0700 and the anchor file at 0600", async () => {
    const { cwd, home, sessionFile } = fixture();
    const policy = policyFor({ recall: recallClient({ n: 0 }) });
    const prompt = user("mode prompt", 1);
    await turn(policy, cwd, sessionFile, [prompt], [messageEntry("u1", prompt)]);
    const file = recallHistoryFile(home, sessionFile, cwd, "u1");
    const sessionDir = dirname(file);
    const root = dirname(sessionDir);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(sessionDir)).toEqual([basename(file)]);
  });

  it("does not mark a restored tail recall-empty, notify, or overwrite last-recall", async () => {
    const { cwd, sessionFile } = fixture();
    const stored: ResolvedConfig = {
      ...config,
      notifications: { ...config.notifications, recall: true },
      recall: { ...config.recall, storeLastRecall: true },
    };
    const prompt = user("tail prompt", 1);
    const branch = [messageEntry("u1", prompt)];
    const first = policyFor({
      recall: async () => ({ results: [{ text: "kept-fact" }] }),
      config: stored,
      setMemoryStatus: () => undefined,
      notify: () => undefined,
    });
    await turn(first, cwd, sessionFile, [prompt], branch);
    const lastRecallPath = join(cwd, ".pi", "hindsight", "last-recall.json");
    const before = readFileSync(lastRecallPath);

    const restoredStatuses: string[] = [];
    const restoredNotes: string[] = [];
    const calls = { n: 0 };
    const second = policyFor({
      recall: recallClient(calls, "should-not"),
      config: stored,
      setMemoryStatus: (_runtime, activity) => {
        restoredStatuses.push(activity);
      },
      notify: (_runtime, message) => {
        restoredNotes.push(message);
      },
    });
    const patch = await turn(second, cwd, sessionFile, [prompt], branch);

    expect(calls.n).toBe(0);
    expect(String(patch[0]?.content)).toContain("kept-fact");
    expect(restoredStatuses).toEqual([]);
    expect(restoredNotes).toEqual([]);
    expect(readFileSync(lastRecallPath)).toEqual(before);
  });

  function observingConfig(): ResolvedConfig {
    return {
      ...config,
      notifications: { ...config.notifications, recall: true },
      recall: { ...config.recall, storeLastRecall: true, storeLastRecallFailures: true },
    };
  }

  async function restoredTail(args: {
    cwd: string;
    sessionFile: string;
    prompt: ChatMessage;
    first: ReturnType<typeof policyFor>;
  }) {
    const branch = [messageEntry("u1", args.prompt)];
    const firstMessages = await turn(args.first, args.cwd, args.sessionFile, [args.prompt], branch);
    const lastRecallPath = join(args.cwd, ".pi", "hindsight", "last-recall.json");
    const beforeRecall = existsSync(lastRecallPath) ? readFileSync(lastRecallPath) : undefined;
    const calls = { n: 0 };
    const statuses: string[] = [];
    const notes: string[] = [];
    const second = policyFor({
      recall: recallClient(calls, "should-not"),
      config: observingConfig(),
      setMemoryStatus: (_runtime, activity) => {
        statuses.push(activity);
      },
      notify: (_runtime, message) => {
        notes.push(message);
      },
    });
    const secondMessages = await turn(second, args.cwd, args.sessionFile, [args.prompt], branch);
    return { firstMessages, secondMessages, calls, statuses, notes, lastRecallPath, beforeRecall };
  }

  it("freezes a thrown durable-tail recall so reload does not inject memory", async () => {
    const { cwd, home, sessionFile } = fixture();
    const prompt = user("failed tail", 1);
    const firstStatuses: string[] = [];
    const first = policyFor({
      recall: async () => ({ results: [{ text: "unused" }] }),
      getClient: () => {
        throw new Error("client unavailable");
      },
      config: observingConfig(),
      setMemoryStatus: (_runtime, activity) => {
        firstStatuses.push(activity);
      },
    });
    const restored = await restoredTail({ cwd, sessionFile, prompt, first });

    expect(firstStatuses).toEqual(["recalling", "recall-failed"]);
    expect(JSON.stringify(restored.secondMessages)).toBe(JSON.stringify(restored.firstMessages));
    expect(JSON.stringify(restored.secondMessages)).not.toContain("hindsight-memory");
    expect(JSON.stringify(restored.secondMessages)).not.toContain("should-not");
    expect(restored.calls.n).toBe(0);
    expect(restored.statuses).toEqual([]);
    expect(restored.notes).toEqual([]);
    expect(restored.beforeRecall).toBeDefined();
    expect(readFileSync(restored.lastRecallPath)).toEqual(restored.beforeRecall);
    const tombstone = JSON.parse(
      readFileSync(recallHistoryFile(home, sessionFile, cwd, "u1"), "utf8"),
    ) as { key: string; rendered: string; timestamp: number };
    expect(Object.keys(tombstone).sort()).toEqual(["key", "rendered", "timestamp"]);
    expect(tombstone).toMatchObject({ key: "u1", rendered: "" });
    expect(typeof tombstone.timestamp).toBe("number");
  });

  it("restores an empty successful tail without refetch, status, notify, or last-recall writes", async () => {
    const { cwd, home, sessionFile } = fixture();
    const prompt = user("empty tail", 1);
    const first = policyFor({
      recall: async () => ({ results: [] }),
      config: observingConfig(),
    });
    const restored = await restoredTail({ cwd, sessionFile, prompt, first });

    expect(JSON.stringify(restored.secondMessages)).toBe(JSON.stringify(restored.firstMessages));
    expect(JSON.stringify(restored.secondMessages)).not.toContain("hindsight-memory");
    expect(JSON.stringify(restored.secondMessages)).not.toContain("should-not");
    expect(restored.calls.n).toBe(0);
    expect(restored.statuses).toEqual([]);
    expect(restored.notes).toEqual([]);
    expect(restored.beforeRecall).toBeDefined();
    expect(readFileSync(restored.lastRecallPath)).toEqual(restored.beforeRecall);
    const record = JSON.parse(
      readFileSync(recallHistoryFile(home, sessionFile, cwd, "u1"), "utf8"),
    ) as { key: string; rendered: string };
    expect(record).toMatchObject({ key: "u1", rendered: "" });
  });

  it("notifies on a sidecar write failure and leaves the request unchanged", async () => {
    const { cwd, sessionFile } = fixture();
    const prompt = user("write failure", 1);
    const branch = [messageEntry("u1", prompt)];
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const okStatuses: string[] = [];
      const ok = policyFor({
        recall: async () => ({ results: [{ text: "still-here" }] }),
        setMemoryStatus: (_runtime, activity) => {
          okStatuses.push(activity);
        },
      });
      const okPatch = await turn(ok, cwd, sessionFile, [prompt], branch);

      const badStatuses: string[] = [];
      const warnings: Array<{ message: string; level: string }> = [];
      const bad = policyFor({
        recall: async () => ({ results: [{ text: "still-here" }] }),
        setMemoryStatus: (_runtime, activity) => {
          badStatuses.push(activity);
        },
        notify: (_runtime, message, level) => {
          warnings.push({ message, level });
        },
        recallHistory: {
          read: () => undefined,
          write: () => {
            throw new Error("disk full token: super-secret-value");
          },
        },
      });
      const badPatch = await turn(bad, cwd, sessionFile, [prompt], branch);

      expect(badPatch).toEqual(okPatch);
      expect(badStatuses).toEqual(["recalling", "recalled"]);
      expect(okStatuses).toEqual(["recalling", "recalled"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.level).toBe("warning");
      expect(warnings[0]?.message).toContain("Hindsight recall history write failed");
      expect(warnings[0]?.message).toContain("[REDACTED]");
      expect(warnings[0]?.message).not.toContain("super-secret-value");
    } finally {
      now.mockRestore();
    }
  });
});
