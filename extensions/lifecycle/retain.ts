import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type {
  HindsightLikeClient,
  HindsightObservationScopes,
  ResolvedConfig,
  RetainJob,
  RetainOutcome,
  UpdateMode,
} from "../types.js";
import { baseTags } from "../banks/banking.js";
import { projectMessages } from "../utils/messages.js";
import { redactError } from "../utils/sanitize.js";
import { contextLabel, liveDocumentId, stableSessionId } from "../utils/session.js";
import {
  enqueueRetain,
  enqueueRetainCoalesced,
  flushRetain,
  summarizeRetainQueue,
  retainQueuePath,
  type FlushRetainQueueResult,
} from "../queue/queue.js";
import { createMemoryIdentity } from "../operations/memory-identity.js";
import { LIVE_SESSION_RETAIN_STRATEGY } from "../banks/retain-strategies.js";
import { expandObservationScopes } from "./observation-scopes.js";
import { buildRetainJob as buildRetainJobCore } from "./retain-job-builder.js";
import { appendRetainReceipts } from "./retain-receipts.js";

function hasRetainOutcome(outcome: { itemsCount?: number; operations?: number; tokens?: number }) {
  return (
    outcome.itemsCount !== undefined ||
    outcome.operations !== undefined ||
    outcome.tokens !== undefined
  );
}

export async function recordRetainDeliveries(
  cwd: string,
  config: ResolvedConfig,
  result: FlushRetainQueueResult,
): Promise<void> {
  if (!result.delivered?.length) return;
  await appendRetainReceipts(
    cwd,
    result.delivered.map((delivery) => ({
      queueJobId: delivery.queueJobId,
      bankId: delivery.bankId,
      documentId: delivery.documentId,
      updateMode: delivery.updateMode,
      source: "queue" as const,
      context: delivery.context,
      tags: delivery.tags,
      ...(hasRetainOutcome(delivery.outcome) ? { outcome: delivery.outcome } : {}),
    })),
    { redactSecrets: config.retain.redactSecrets },
  );
}

export function buildRetainJob(args: {
  config: ResolvedConfig;
  cwd: string;
  sessionFile?: string;
  bankId: string;
  messages: AgentEndEvent["messages"];
  extraTags?: string[];
}): RetainJob | undefined {
  const projected = projectMessages(args.messages, args.config);
  if (projected.length === 0) return undefined;
  const content = JSON.stringify(projected, null, 2);
  const sessionId = stableSessionId(args.sessionFile, args.cwd);
  const identity = createMemoryIdentity(args.cwd, args.config, args.sessionFile);
  const observationScopes = args.config.observations.enabled
    ? expandObservationScopes(args.config.observations.scopes, {
        ...identity,
        projectBankId: args.bankId,
      })
    : [];
  return buildRetainJobCore({
    config: args.config,
    bankId: args.bankId,
    content,
    context: contextLabel(args.cwd, args.sessionFile, args.config.agentUse),
    documentId: liveDocumentId(args.sessionFile, args.cwd),
    updateMode: args.config.retain.updateMode,
    tags: [...new Set([...baseTags(args.cwd, sessionId, args.config), ...(args.extraTags ?? [])])],
    metadata: {
      cwd: args.cwd,
      imported: "false",
      source: "pi-hindsight",
      retainSource: "auto",
      ...(args.sessionFile ? { pi_session_file: args.sessionFile } : {}),
    },
    ...(observationScopes.length ? { observationScopes } : {}),
    // Coding bank templates define named strategies; live sessions use conversation.
    strategy: LIVE_SESSION_RETAIN_STRATEGY,
  });
}

export async function enqueueRetainFromAgentEnd(args: {
  event: AgentEndEvent;
  cwd: string;
  sessionFile?: string;
  config: ResolvedConfig;
  client: HindsightLikeClient;
  bankId: string;
  extraTags?: string[];
}): Promise<{ queued: boolean; sent: number; remaining: number; reflectError?: string }> {
  if (!args.config.enabled || !args.config.retain.enabled)
    return { queued: false, sent: 0, remaining: 0 };
  const job = buildRetainJob({
    config: args.config,
    cwd: args.cwd,
    ...(args.sessionFile ? { sessionFile: args.sessionFile } : {}),
    bankId: args.bankId,
    messages: args.event.messages,
    ...(args.extraTags ? { extraTags: args.extraTags } : {}),
  });
  if (!job) return { queued: false, sent: 0, remaining: 0 };

  // Coalesced delivery: merge this delta into any compatible pending job and defer the
  // remote flush to the session boundary (shutdown) / periodic flush. This collapses the
  // per-agent_end write storm into a few larger operations. Durability is unchanged: the
  // job is persisted to the on-disk queue before we return.
  if (args.config.retain.delivery === "coalesced") {
    await enqueueRetainCoalesced(args.cwd, args.config, job);
    const summary = await summarizeRetainQueue(retainQueuePath(args.cwd, args.config));
    return { queued: true, sent: 0, remaining: summary.active.valid };
  }

  await enqueueRetain(args.cwd, args.config, job);
  const result = await flushRetain(args.cwd, args.config, args.client);
  await recordRetainDeliveries(args.cwd, args.config, result);
  let reflectError: string | undefined;
  if (args.config.retain.postRetainReflect) {
    try {
      await args.client.reflect(
        args.bankId,
        "Reflect on the recently retained session to extract insights",
        { context: "Post-retain reflection" },
      );
    } catch (error) {
      // Best-effort reflect after retain; the retain itself already succeeded above.
      // Surface the (redacted) cause to the caller instead of swallowing it silently,
      // so callers with a notification channel can make it debug-visible.
      reflectError = redactError(error);
    }
  }
  return {
    queued: true,
    sent: result.sent,
    remaining: result.remaining,
    ...(reflectError ? { reflectError } : {}),
  };
}

export type DurableRetainSource = "auto" | "tool" | "command" | "import";

export interface RetainDurablyArgs {
  cwd: string;
  config: ResolvedConfig;
  client: HindsightLikeClient;
  bankId: string;
  content: string;
  context: string;
  tags: string[];
  documentId: string;
  updateMode: UpdateMode;
  metadata?: Record<string, string>;
  source: DurableRetainSource;
  timestamp?: string;
  observationScopes?: HindsightObservationScopes;
  documentTags?: string[];
  entities?: RetainJob["item"]["entities"];
  async?: boolean;
}

export interface RetainDurablyResult {
  enqueued: boolean;
  sent: number;
  remaining: number;
  deadLettered: number;
  bankId: string;
  documentId: string;
  queueJobId: string;
  updateMode: UpdateMode;
  operationIds?: string[];
  outcome?: RetainOutcome;
}

export function buildDurableRetainJob(args: Omit<RetainDurablyArgs, "client">): RetainJob {
  return buildRetainJobCore({
    ...args,
    metadata: {
      ...args.metadata,
      source: "pi-hindsight",
      retainSource: args.source,
    },
  });
}

export async function retainDurably(args: RetainDurablyArgs): Promise<RetainDurablyResult> {
  const job = buildDurableRetainJob(args);
  const receipt = {
    bankId: job.bankId,
    documentId: job.documentId,
    queueJobId: job.id,
    updateMode: job.updateMode,
  };
  await enqueueRetain(args.cwd, args.config, job);
  // Always attempt a bounded flush after enqueue: the previous "skip the flush whenever
  // the queue was already non-empty" bail-out meant one stranded job made every later
  // explicit retain enqueue-and-never-drain once automatic flushes were off (ADR 003:
  // queue flush drains already accepted jobs). stopOnFirstFailure bounds the call so a
  // full outage costs one delivery attempt, and in recall-only mode the predicate keeps
  // automatic/legacy jobs queued (no consent) while explicit jobs drain in FIFO order.
  const result = await flushRetain(args.cwd, args.config, args.client, {
    maxJobs: Math.max(1, args.config.retain.periodicFlushMaxJobs || 10),
    maxElapsedMs: args.config.retain.periodicFlushTimeoutMs || 15_000,
    stopOnFirstFailure: true,
  });
  return {
    ...receipt,
    enqueued: true,
    sent: result.sent,
    remaining: result.remaining,
    deadLettered: result.deadLettered,
    ...(result.operationIds ? { operationIds: result.operationIds } : {}),
    ...(result.outcome ? { outcome: result.outcome } : {}),
  };
}
