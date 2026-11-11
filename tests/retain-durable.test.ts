import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import { createMemoryOperations } from "../extensions/operations/memory-operation-service.js";
import {
  enqueueRetainJob,
  flushRetainQueue,
  isExplicitRetainJob,
  readDeadLetterQueue,
  readRetainQueue,
  resolveQueuePath,
} from "../extensions/queue/queue.js";
import type { HindsightLikeClient, ResolvedConfig } from "../extensions/types.js";
import {
  setSessionMemoryMode,
  setSessionRetainEnabled,
} from "../extensions/utils/session-memory-meta.js";

function testConfig(queuePath = ".pi/hindsight/q.jsonl"): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    retain: { ...DEFAULT_CONFIG.retain, queuePath, redactSecrets: true },
  };
}

function recallOnlyConfig(queuePath = ".pi/hindsight/q.jsonl"): ResolvedConfig {
  return {
    ...testConfig(queuePath),
    retain: {
      ...testConfig(queuePath).retain,
      enabled: false,
      periodicFlushMaxJobs: 10,
      periodicFlushTimeoutMs: 5_000,
    },
  };
}

/** Queue a job directly, bypassing retainDurably, with explicit provenance control. */
function queueJob(
  path: string,
  args: { id: string; content: string; retainSource?: string; retries?: number },
): Promise<void> {
  return enqueueRetainJob(path, {
    id: args.id,
    bankId: "project-bank",
    createdAt: new Date().toISOString(),
    documentId: `doc-${args.id}`,
    updateMode: "replace",
    item: {
      content: args.content,
      context: "unit test queue fixture",
      ...(args.retainSource
        ? { metadata: { source: "pi-hindsight", retainSource: args.retainSource } }
        : {}),
    },
    retries: args.retries ?? 0,
  });
}

function client(retain: HindsightLikeClient["retain"]): HindsightLikeClient {
  return {
    retain,
    recall: async () => [],
    reflect: async () => ({}),
  };
}

describe("durable explicit retain", () => {
  it("queues explicit retain when Hindsight is down", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = testConfig();
    const operations = createMemoryOperations({
      getClient: () =>
        client(async () => {
          throw new Error("down");
        }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    const result = await operations.retainExplicit({
      cwd,
      sessionFile: "/tmp/session.jsonl",
      content: "Durable fact with API_KEY=super-secret",
      context: "unit test explicit retain",
      tags: ["decision:test"],
    });

    expect(result).toMatchObject({
      bankId: "project-bank",
      enqueued: true,
      queued: true,
      sent: 0,
      remaining: 1,
      deadLettered: 0,
    });
    expect(result.tags).toEqual(expect.arrayContaining(["source:pi", "decision:test"]));

    const queued = await readRetainQueue(resolveQueuePath(cwd, config.retain.queuePath));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      bankId: "project-bank",
      updateMode: "replace",
      retries: 1,
      item: {
        context: "unit test explicit retain",
        async: true,
        metadata: {
          source: "pi-hindsight",
          retainSource: "tool",
          cwd,
          pi_session_file: "/tmp/session.jsonl",
        },
      },
    });
    expect(queued[0]?.documentId).toMatch(/^pi-explicit:/);
    expect(queued[0]?.item.content).toContain("Durable fact");
    expect(queued[0]?.item.content).not.toContain("super-secret");
    expect(queued[0]?.item.tags).toEqual(expect.arrayContaining(["source:pi", "decision:test"]));
  });

  it("redacts explicit retain metadata when secret redaction is enabled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = testConfig();
    const operations = createMemoryOperations({
      getClient: () =>
        client(async () => {
          throw new Error("down");
        }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    await operations.retainExplicit({
      cwd,
      content: "Durable fact",
      context: "unit test explicit retain",
      metadata: {
        source_url: "https://example.test/callback?token=super-secret&ok=true",
        api_key: "sk-abcdefghijklmnopqrstuvwxyz",
      },
    });

    const queued = await readRetainQueue(resolveQueuePath(cwd, config.retain.queuePath));
    expect(queued[0]?.item.metadata).toMatchObject({
      source_url: "https://example.test/callback?token=[REDACTED]",
      api_key: "[REDACTED_API_KEY]",
      cwd,
      source: "pi-hindsight",
      retainSource: "tool",
    });
    expect(JSON.stringify(queued[0]?.item.metadata)).not.toContain("super-secret");
    expect(JSON.stringify(queued[0]?.item.metadata)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("blocks explicit retain before queue admission when retain.beforeEnqueue fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const checker = join(cwd, "checker.mjs");
    writeFileSync(checker, "process.exit(1);\n");
    const config: ResolvedConfig = {
      ...testConfig(),
      retain: {
        ...testConfig().retain,
        beforeEnqueue: { command: [process.execPath, checker], timeoutMs: 2_000 },
      },
    };
    const retain = client(async () => undefined);
    const operations = createMemoryOperations({
      getClient: () => retain,
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    await expect(
      operations.retainExplicit({
        cwd,
        content: "Durable fact",
        context: "unit test explicit retain",
      }),
    ).rejects.toThrow("retain.beforeEnqueue blocked retain job before queue admission");
    expect(existsSync(resolveQueuePath(cwd, config.retain.queuePath))).toBe(false);
  });

  it("passes configured observation scopes for explicit retain", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config: ResolvedConfig = {
      ...testConfig(),
      observations: { enabled: true, scopes: [["repo:{repoKey}"], ["bank:{projectBankId}"]] },
    };
    const operations = createMemoryOperations({
      getClient: () =>
        client(async () => {
          throw new Error("down");
        }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    await operations.retainExplicit({
      cwd,
      content: "Durable fact",
      context: "unit test explicit retain",
      bank: "custom-bank",
    });

    const queued = await readRetainQueue(resolveQueuePath(cwd, config.retain.queuePath));
    expect(queued[0]?.item.observationScopes).toEqual([
      [expect.stringMatching(/^repo:/)],
      ["bank:custom-bank"],
    ]);
  });

  it("attempts only the backlog head once per explicit retain during a continuous outage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = testConfig();
    const operations = createMemoryOperations({
      getClient: () =>
        client(async () => {
          throw new Error("down");
        }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    for (let index = 0; index < 3; index += 1) {
      await operations.retainExplicit({
        cwd,
        content: `Decision ${index}`,
        context: "unit test explicit retain",
      });
    }

    const queuePath = resolveQueuePath(cwd, config.retain.queuePath);
    const queued = await readRetainQueue(queuePath);
    expect(queued).toHaveLength(3);
    // stopOnFirstFailure bounds the outage cost: each explicit retain attempts the FIFO
    // head once, so the head burns one retry per call while later jobs stay fresh.
    expect(queued[0]?.retries).toBe(3);
    expect(queued.slice(1).every((queuedJob) => queuedJob.retries === 0)).toBe(true);
    expect(await readDeadLetterQueue(queuePath)).toHaveLength(0);
  });

  it("keeps explicit retain queued when existing backlog contains malformed lines", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = testConfig();
    const queuePath = resolveQueuePath(cwd, config.retain.queuePath);
    mkdirSync(dirname(queuePath), { recursive: true });
    writeFileSync(queuePath, "{bad json}\n", "utf8");
    const operations = createMemoryOperations({
      getClient: () => client(async () => undefined),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    const result = await operations.retainExplicit({
      cwd,
      content: "Decision with malformed backlog",
      context: "unit test explicit retain",
    });

    // A malformed backlog line no longer strands every later explicit retain: the new
    // explicit job is quarantined apart from it and delivered, and the malformed line
    // moves to the quarantine file instead of blocking the queue.
    expect(result).toMatchObject({ enqueued: true, sent: 1, remaining: 0, deadLettered: 0 });
    expect(await readRetainQueue(queuePath)).toHaveLength(0);
  });

  it("keeps every racing explicit retain accounted for during an outage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = testConfig();
    const operations = createMemoryOperations({
      getClient: () =>
        client(async () => {
          throw new Error("down");
        }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        operations.retainExplicit({
          cwd,
          content: `Decision ${index}`,
          context: "unit test explicit retain",
        }),
      ),
    );

    // Seven serialized bounded flushes against a down server: the FIFO head accumulates
    // attempts until the retry limit dead-letters it, then the next head takes over. No
    // job is lost or delivered twice — every job is either queued or dead-lettered once.
    const queuePath = resolveQueuePath(cwd, config.retain.queuePath);
    const queued = await readRetainQueue(queuePath);
    const deadLettered = await readDeadLetterQueue(queuePath);
    expect(queued).toHaveLength(6);
    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0]?.retries).toBe(5);
    expect(queued.filter((queuedJob) => queuedJob.retries === 2)).toHaveLength(1);
    expect(queued.filter((queuedJob) => queuedJob.retries === 0)).toHaveLength(5);
    const ids = new Set([...queued, ...deadLettered].map((job) => job.id));
    expect(ids.size).toBe(7);
  });

  it("flushes queued explicit retain later", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = testConfig();
    const operations = createMemoryOperations({
      getClient: () =>
        client(async () => {
          throw new Error("down");
        }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    await operations.retainExplicit({
      cwd,
      content: "Decision: queue first.",
      context: "unit test explicit retain",
    });

    const calls: unknown[] = [];
    const queuePath = resolveQueuePath(cwd, config.retain.queuePath);
    const result = await flushRetainQueue(
      queuePath,
      client(async (...args: unknown[]) => {
        calls.push(args);
      }),
    );

    expect(result).toMatchObject({ sent: 1, remaining: 0, deadLettered: 0 });
    expect(await readRetainQueue(queuePath)).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject([
      "project-bank",
      "Decision: queue first.",
      {
        context: "unit test explicit retain",
        async: true,
        updateMode: "replace",
      },
    ]);
  });

  it("uses replace for explicit retains so receipts can be deleted precisely", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = testConfig();
    const operations = createMemoryOperations({
      getClient: () => client(async () => undefined),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    const result = await operations.retainExplicit({
      cwd,
      content: "Decision: precise delete target.",
      context: "unit test explicit retain",
    });

    expect(result.updateMode).toBe("replace");
    expect(result.documentId).toMatch(/^pi-explicit:/);
  });

  it("blocks explicit recall and retain when session governance disables them", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const sessionFile = "/tmp/session.jsonl";
    const config = testConfig();
    const operations = createMemoryOperations({
      getClient: () => client(async () => undefined),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    await setSessionMemoryMode(cwd, sessionFile, "ignored");
    await expect(operations.recall(cwd, "q", undefined, sessionFile)).rejects.toThrow(
      /recall is disabled/,
    );
    await expect(
      operations.retainExplicit({ cwd, sessionFile, content: "x", context: "ctx" }),
    ).rejects.toThrow(/retain is disabled/);

    await setSessionMemoryMode(cwd, sessionFile, "normal");
    await setSessionRetainEnabled(cwd, sessionFile, false);
    await expect(
      operations.retainExplicit({ cwd, sessionFile, content: "x", context: "ctx" }),
    ).rejects.toThrow(/retain is disabled/);
  });

  it("sends explicit retain immediately after enqueue when Hindsight is up", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = testConfig();
    const calls: unknown[] = [];
    const operations = createMemoryOperations({
      getClient: () =>
        client(async (...args: unknown[]) => {
          calls.push(args);
        }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    const result = await operations.retainExplicit({
      cwd,
      content: "Decision: flush now.",
      context: "unit test explicit retain",
    });

    expect(result).toMatchObject({ enqueued: true, sent: 1, remaining: 0, deadLettered: 0 });
    expect(await readRetainQueue(resolveQueuePath(cwd, config.retain.queuePath))).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("drains pre-existing explicit jobs in FIFO order in recall-only mode", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = recallOnlyConfig();
    const queuePath = resolveQueuePath(cwd, config.retain.queuePath);
    mkdirSync(dirname(queuePath), { recursive: true });
    await queueJob(queuePath, { id: "backlog-auto", content: "auto delta", retainSource: "auto" });
    await queueJob(queuePath, {
      id: "backlog-tool",
      content: "explicit one",
      retainSource: "tool",
    });
    await queueJob(queuePath, {
      id: "backlog-import",
      content: "explicit two",
      retainSource: "import",
    });
    await queueJob(queuePath, { id: "backlog-legacy", content: "legacy untagged" });

    const delivered: string[] = [];
    const operations = createMemoryOperations({
      getClient: () =>
        client(async (_bankId: string, content: string) => {
          delivered.push(content);
          return {};
        }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    const result = await operations.retainExplicit({
      cwd,
      content: "explicit three",
      context: "unit test explicit retain",
    });

    expect(result.sent).toBe(3);
    expect(delivered).toEqual(["explicit one", "explicit two", "explicit three"]);
    const queued = await readRetainQueue(queuePath);
    expect(queued.map((job) => job.id)).toEqual(["backlog-auto", "backlog-legacy"]);
    expect(queued.every((job) => job.retries === 0)).toBe(true);
  });

  it("never delivers automatic or untagged backlog jobs in recall-only mode", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = recallOnlyConfig();
    const queuePath = resolveQueuePath(cwd, config.retain.queuePath);
    mkdirSync(dirname(queuePath), { recursive: true });
    const autoJob = {
      id: "auto-1",
      bankId: "project-bank",
      createdAt: new Date().toISOString(),
      documentId: "doc-auto-1",
      updateMode: "append" as const,
      item: {
        content: "automatic delta",
        context: "agent_end",
        metadata: { source: "pi-hindsight", retainSource: "auto" },
      },
      retries: 2,
      lastError: "previous outage",
    };
    await enqueueRetainJob(queuePath, autoJob);
    const legacyJob = {
      id: "legacy-1",
      bankId: "project-bank",
      createdAt: new Date().toISOString(),
      documentId: "doc-legacy-1",
      updateMode: "append" as const,
      item: { content: "legacy delta", context: "agent_end" },
      retries: 0,
    };
    await enqueueRetainJob(queuePath, legacyJob);

    const delivered: string[] = [];
    const operations = createMemoryOperations({
      getClient: () =>
        client(async (_bankId: string, content: string) => {
          delivered.push(content);
          return {};
        }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    const result = await operations.retainExplicit({
      cwd,
      content: "explicit only",
      context: "unit test explicit retain",
    });

    expect(result.sent).toBe(1);
    expect(delivered).toEqual(["explicit only"]);
    // Exact position, content, and retry state preserved for non-explicit backlog jobs.
    expect(await readRetainQueue(queuePath)).toEqual([autoJob, legacyJob]);
  });

  it("serializes concurrent explicit retains without lost or duplicate deliveries", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-"));
    const config = recallOnlyConfig();
    const queuePath = resolveQueuePath(cwd, config.retain.queuePath);
    mkdirSync(dirname(queuePath), { recursive: true });
    await queueJob(queuePath, {
      id: "backlog-tool",
      content: "backlog explicit",
      retainSource: "tool",
    });

    const delivered: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const slowClient = client(async (_bankId: string, content: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      delivered.push(content);
      return {};
    });
    const operations = createMemoryOperations({
      getClient: () => slowClient,
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });

    await Promise.all([
      ...Array.from({ length: 5 }, (_, index) =>
        operations.retainExplicit({
          cwd,
          content: `racing explicit ${index}`,
          context: "unit test explicit retain",
        }),
      ),
      flushRetainQueue(queuePath, slowClient, { predicate: isExplicitRetainJob }),
      flushRetainQueue(queuePath, slowClient, { predicate: isExplicitRetainJob }),
    ]);

    // withQueueLock serializes queue mutations: no duplicate appends, no lost jobs, and
    // the interleaved direct flushes never double-deliver a job.
    expect(delivered).toHaveLength(6);
    expect(new Set(delivered).size).toBe(6);
    expect(delivered).toContain("backlog explicit");
    expect(await readRetainQueue(queuePath)).toHaveLength(0);
    expect(maxInFlight).toBe(1);
  });

  it("enforces recall-only, setup, and session consent on operations.flush", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-flush-op-"));
    const sessionFile = join(cwd, "session.jsonl");
    const baseConfig: ResolvedConfig = {
      ...recallOnlyConfig(),
      setupComplete: true,
      banks: {
        ...recallOnlyConfig().banks,
        project: { ...recallOnlyConfig().banks.project, bankId: "project-bank" },
      },
    };
    const queuePath = resolveQueuePath(cwd, baseConfig.retain.queuePath);
    mkdirSync(dirname(queuePath), { recursive: true });
    await queueJob(queuePath, { id: "auto-1", content: "auto", retainSource: "auto" });
    await queueJob(queuePath, { id: "legacy-1", content: "legacy" });
    await queueJob(queuePath, { id: "seed-1", content: "seed", retainSource: "git-seed" });

    const delivered: string[] = [];
    let currentConfig = { ...baseConfig, enabled: false };
    const operations = createMemoryOperations({
      getClient: () =>
        client(async (_bankId: string, content: string) => {
          delivered.push(content);
          return {};
        }),
      getConfig: () => currentConfig,
      getProjectBankId: () => "project-bank",
    });

    // Disabled extension flushes nothing.
    expect(await operations.flush(cwd, sessionFile)).toMatchObject({ sent: 0, remaining: 3 });
    expect(delivered).toEqual([]);

    // Setup incomplete flushes nothing.
    const { bankId: _pb, ...projectWithoutBankId } = baseConfig.banks.project;
    const { bankId: _ub, ...userWithoutBankId } = baseConfig.banks.user;
    currentConfig = {
      ...baseConfig,
      setupComplete: false,
      banks: {
        ...baseConfig.banks,
        project: projectWithoutBankId,
        user: { ...userWithoutBankId, enabled: false },
      },
      retain: { ...baseConfig.retain, queuePath: ".pi/hindsight/unconfigured-queue.jsonl" },
    };
    const unconfiguredPath = resolveQueuePath(cwd, currentConfig.retain.queuePath);
    mkdirSync(dirname(unconfiguredPath), { recursive: true });
    await queueJob(unconfiguredPath, { id: "tool-unsetup", content: "x", retainSource: "tool" });
    expect(await operations.flush(cwd, sessionFile)).toMatchObject({ sent: 0, remaining: 1 });
    expect(delivered).toEqual([]);

    // Session retain opt-out flushes nothing even when setup is complete.
    currentConfig = baseConfig;
    await setSessionRetainEnabled(cwd, sessionFile, false);
    expect(await operations.flush(cwd, sessionFile)).toMatchObject({ sent: 0, remaining: 3 });
    expect(delivered).toEqual([]);

    // Re-enabling session retain in recall-only mode delivers only explicit jobs.
    await setSessionRetainEnabled(cwd, sessionFile, true);
    expect(await operations.flush(cwd, sessionFile)).toMatchObject({ sent: 1, remaining: 2 });
    expect(delivered).toEqual(["seed"]);
    expect((await readRetainQueue(queuePath)).map((queued) => queued.id)).toEqual([
      "auto-1",
      "legacy-1",
    ]);
  });
});
