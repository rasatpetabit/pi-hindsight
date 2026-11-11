/**
 * Opt-in cold-repo gitlog seed (coding-agents-aligned, Pi-native).
 *
 * Seeds an aggregated commit-message history document (strategy gitlog) with a stable
 * document id for idempotent re-runs. Does not replace live session retain; default off
 * (explicit tool/command only — no session-start auto-seed).
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { HindsightLikeClient, ResolvedConfig, RetainJob } from "../types.js";
import { baseTags } from "../banks/banking.js";
import { createMemoryIdentity } from "../operations/memory-identity.js";
import { buildRetainJob } from "./retain-job-builder.js";
import { enqueueRetain, flushRetain, retainQueuePath } from "../queue/queue.js";
import { recordRetainDeliveries } from "./retain.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_GIT_SEED_LIMIT = 300;
export const GIT_SEED_RECEIPT_PATH = ".pi/hindsight/git-seed-receipt.json";

export interface GitSeedReceipt {
  bankId: string;
  documentId: string;
  headSha: string;
  commitCount: number;
  seededAt: string;
  dryRun?: boolean;
}

export interface CollectGitLogArgs {
  cwd: string;
  limit?: number;
  /** Injectable for tests. */
  execGit?: (args: string[], cwd: string) => Promise<string>;
}

export interface CollectGitLogResult {
  headSha: string;
  commitCount: number;
  content: string;
  documentId: string;
}

async function defaultExecGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

/** Collect newest-first commit subjects for gitlog strategy retain. */
export async function collectGitLogForSeed(
  args: CollectGitLogArgs,
): Promise<CollectGitLogResult | { error: string }> {
  const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_GIT_SEED_LIMIT, 2000));
  const execGit = args.execGit ?? defaultExecGit;
  try {
    const headSha = (await execGit(["rev-parse", "HEAD"], args.cwd)).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(headSha)) {
      return { error: "Could not resolve git HEAD" };
    }
    const log = await execGit(["log", `-n${limit}`, "--format=%H%x09%s", "--no-merges"], args.cwd);
    const lines = log
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return { error: "No commits found for git seed" };
    }
    const subjects = lines.map((line) => {
      const tab = line.indexOf("\t");
      if (tab === -1) return line;
      const sha = line.slice(0, tab).slice(0, 12);
      const subject = line.slice(tab + 1);
      return `${sha} ${subject}`;
    });
    const content = [
      `# Git commit message history (newest first, limit ${limit})`,
      "",
      ...subjects,
    ].join("\n");
    return {
      headSha,
      commitCount: subjects.length,
      content,
      // Stable id per project head so re-seed at same HEAD is idempotent; new HEAD creates a new doc.
      documentId: `pi-gitlog:${headSha.slice(0, 12)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.includes("not a git") ? "Not a git repository" : message };
  }
}

export function resolveGitSeedReceiptPath(cwd: string): string {
  return join(cwd, GIT_SEED_RECEIPT_PATH);
}

export async function readGitSeedReceipt(cwd: string): Promise<GitSeedReceipt | null> {
  try {
    const raw = await readFile(resolveGitSeedReceiptPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as GitSeedReceipt;
    if (!parsed || typeof parsed.headSha !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeGitSeedReceipt(cwd: string, receipt: GitSeedReceipt): Promise<void> {
  const path = resolveGitSeedReceiptPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export function buildGitLogRetainJob(args: {
  config: ResolvedConfig;
  cwd: string;
  bankId: string;
  content: string;
  documentId: string;
  headSha: string;
}): RetainJob {
  const identity = createMemoryIdentity(args.cwd, args.config);
  const tags = [...baseTags(args.cwd, "git-seed", args.config), "source:git", "strategy:gitlog"];
  return buildRetainJob({
    config: args.config,
    bankId: args.bankId,
    content: args.content,
    context: `Git commit-message seed for ${identity.projectId} (HEAD ${args.headSha.slice(0, 12)})`,
    documentId: args.documentId,
    // Full snapshot of the limited log window — replace keeps one doc per HEAD id.
    updateMode: "replace",
    tags: [...new Set(tags)],
    metadata: {
      cwd: args.cwd,
      imported: "true",
      seed: "gitlog",
      head_sha: args.headSha,
      // Explicit provenance: opt-in seed jobs consent to recall-only queue drains.
      retainSource: "git-seed",
    },
    strategy: "gitlog",
  });
}

export interface SeedGitLogArgs {
  cwd: string;
  bankId: string;
  config: ResolvedConfig;
  client: HindsightLikeClient;
  limit?: number;
  dryRun?: boolean;
  flush?: boolean;
  execGit?: CollectGitLogArgs["execGit"];
}

export interface SeedGitLogResult {
  dryRun: boolean;
  bankId: string;
  ok: boolean;
  error?: string;
  documentId?: string;
  headSha?: string;
  commitCount?: number;
  queued?: boolean;
  flushed?: number;
  receipt?: GitSeedReceipt;
}

/** Opt-in gitlog seed: queue a retain job (and optionally flush). */
export async function seedGitLog(args: SeedGitLogArgs): Promise<SeedGitLogResult> {
  const dryRun = args.dryRun ?? true;
  const collectArgs: CollectGitLogArgs = {
    cwd: args.cwd,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.execGit ? { execGit: args.execGit } : {}),
  };
  const collected = await collectGitLogForSeed(collectArgs);
  if ("error" in collected) {
    return { dryRun, bankId: args.bankId, ok: false, error: collected.error };
  }

  const receipt: GitSeedReceipt = {
    bankId: args.bankId,
    documentId: collected.documentId,
    headSha: collected.headSha,
    commitCount: collected.commitCount,
    seededAt: new Date().toISOString(),
    ...(dryRun ? { dryRun: true } : {}),
  };

  if (dryRun) {
    return {
      dryRun: true,
      bankId: args.bankId,
      ok: true,
      documentId: collected.documentId,
      headSha: collected.headSha,
      commitCount: collected.commitCount,
      receipt,
    };
  }

  const job = buildGitLogRetainJob({
    config: args.config,
    cwd: args.cwd,
    bankId: args.bankId,
    content: collected.content,
    documentId: collected.documentId,
    headSha: collected.headSha,
  });
  await enqueueRetain(args.cwd, args.config, job);
  let flushed = 0;
  if (args.flush !== false) {
    const result = await flushRetain(args.cwd, args.config, args.client, {
      maxJobs: Math.max(1, args.config.retain.periodicFlushMaxJobs || 10),
      maxElapsedMs: args.config.retain.periodicFlushTimeoutMs || 15_000,
      stopOnFirstFailure: true,
    });
    await recordRetainDeliveries(args.cwd, args.config, result);
    flushed = result.sent;
  }
  await writeGitSeedReceipt(args.cwd, receipt);
  return {
    dryRun: false,
    bankId: args.bankId,
    ok: true,
    documentId: collected.documentId,
    headSha: collected.headSha,
    commitCount: collected.commitCount,
    queued: true,
    flushed,
    receipt,
  };
}

export interface SyncStatus {
  ready: boolean;
  reasons: string[];
  queue: {
    path: string;
    active: number;
    deadLetter: number;
    malformed: number;
  };
  gitSeed: {
    receipt: GitSeedReceipt | null;
    /** True when receipt HEAD matches current git HEAD (when resolvable). */
    headMatches?: boolean;
    currentHead?: string;
  };
  knowledgePages: "unknown" | "supported" | "unavailable";
}

export async function buildSyncStatus(args: {
  cwd: string;
  config: ResolvedConfig;
  client: HindsightLikeClient;
  bankId: string;
  execGit?: CollectGitLogArgs["execGit"];
}): Promise<SyncStatus> {
  const { summarizeRetainQueue } = await import("../queue/queue.js");
  const queueSummary = await summarizeRetainQueue(retainQueuePath(args.cwd, args.config));
  const receipt = await readGitSeedReceipt(args.cwd);
  const reasons: string[] = [];

  let currentHead: string | undefined;
  let headMatches: boolean | undefined;
  try {
    const execGit = args.execGit ?? defaultExecGit;
    currentHead = (await execGit(["rev-parse", "HEAD"], args.cwd)).trim();
    if (receipt) {
      headMatches = receipt.headSha === currentHead;
      if (!headMatches) reasons.push("git_seed_stale");
    } else {
      reasons.push("git_seed_missing");
    }
  } catch {
    // Not a git repo — seed is N/A, not a readiness failure for chat-only memory.
    headMatches = undefined;
  }

  if (queueSummary.active.valid > 0) reasons.push("queue_pending");
  if (queueSummary.deadLetter.valid > 0) reasons.push("queue_dead_letter");

  let knowledgePages: SyncStatus["knowledgePages"] = "unknown";
  if (!args.client.getKnowledgeBaseTree && !args.client.createKnowledgePage) {
    knowledgePages = "unavailable";
  } else if (args.client.getKnowledgeBaseTree) {
    try {
      await args.client.getKnowledgeBaseTree(args.bankId);
      knowledgePages = "supported";
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      knowledgePages = /\b404\b|\b405\b|\b501\b|not found|unavail/i.test(msg)
        ? "unavailable"
        : "unknown";
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    queue: {
      path: queueSummary.active.path,
      active: queueSummary.active.valid,
      deadLetter: queueSummary.deadLetter.valid,
      malformed: queueSummary.active.malformed,
    },
    gitSeed: {
      receipt,
      ...(headMatches !== undefined ? { headMatches } : {}),
      ...(currentHead ? { currentHead } : {}),
    },
    knowledgePages,
  };
}
