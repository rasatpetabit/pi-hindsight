import type { MemoryOperationsDeps } from "./memory-operation-types.js";
import { isMemorySetupComplete } from "../config/setup-gate.js";
import { flushRetain, retainQueuePath, summarizeRetainQueue } from "../queue/queue.js";
import { resolveOperationBank } from "../banks/bank-selection.js";
import { explicitMemoryDocumentId } from "../utils/session.js";
import { createMemoryIdentity, explicitRetainTags } from "./memory-identity.js";
import { expandObservationScopes } from "../lifecycle/observation-scopes.js";
import { retainDurably } from "../lifecycle/retain.js";
import { appendRetainReceipt, listRetainReceipts } from "../lifecycle/retain-receipts.js";
import {
  getEffectiveSessionMemoryMode,
  readSessionMemoryMeta,
} from "../utils/session-memory-meta.js";
import type { HindsightObservationScopes, ResolvedConfig, UpdateMode } from "../types.js";

const RESERVED_EXPLICIT_RETAIN_METADATA_KEYS = new Set([
  "cwd",
  "pi_session_file",
  "source",
  "retainSource",
]);

function callerMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).filter(
    ([key]) => !RESERVED_EXPLICIT_RETAIN_METADATA_KEYS.has(key),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function createRetainOperations(deps: MemoryOperationsDeps) {
  return {
    async retainExplicit(args: {
      cwd: string;
      sessionFile?: string;
      content: string;
      context: string;
      bank?: string;
      tags?: string[];
      entities?: ResolvedConfig["retain"]["entities"];
      documentId?: string;
      timestamp?: string;
      metadata?: Record<string, string>;
      updateMode?: UpdateMode;
      observationScopes?: HindsightObservationScopes;
      documentTags?: string[];
      async?: boolean;
    }) {
      const meta = await readSessionMemoryMeta(args.cwd, args.sessionFile);
      if (!getEffectiveSessionMemoryMode(meta).retain)
        throw new Error("Hindsight retain is disabled for this session");
      const config = deps.getConfig();
      const bankId = resolveOperationBank({
        requestedBank: args.bank,
        config,
        projectBankId: deps.getProjectBankId(),
      });
      const tags = explicitRetainTags(args.cwd, args.sessionFile, [
        ...(args.tags ?? []),
        ...meta.tags,
      ]);
      const identity = createMemoryIdentity(args.cwd, config, args.sessionFile);
      const defaultObservationScopes = config.observations.enabled
        ? expandObservationScopes(config.observations.scopes, {
            ...identity,
            projectBankId: bankId,
          })
        : [];
      const observationScopes = args.observationScopes ?? defaultObservationScopes;
      const result = await retainDurably({
        cwd: args.cwd,
        config,
        client: deps.getClient(),
        bankId,
        content: args.content,
        context: args.context,
        tags,
        updateMode: args.updateMode ?? "replace",
        documentId:
          args.documentId ??
          explicitMemoryDocumentId({
            cwd: args.cwd,
            ...(args.sessionFile ? { sessionFile: args.sessionFile } : {}),
            bankId,
            content: args.content,
            context: args.context,
          }),
        metadata: {
          ...callerMetadata(args.metadata),
          cwd: args.cwd,
          ...(args.sessionFile ? { pi_session_file: args.sessionFile } : {}),
        },
        ...(args.timestamp ? { timestamp: args.timestamp } : {}),
        source: "tool",
        ...(hasObservationScopes(observationScopes) ? { observationScopes } : {}),
        ...(args.documentTags?.length ? { documentTags: args.documentTags } : {}),
        ...(args.entities?.length ? { entities: args.entities } : {}),
        ...(args.async !== undefined ? { async: args.async } : {}),
      });
      const response = { ...result, tags, queued: result.enqueued };
      await appendRetainReceipt(
        args.cwd,
        {
          bankId: result.bankId,
          documentId: result.documentId,
          queueJobId: result.queueJobId,
          updateMode: result.updateMode,
          source: "tool",
          context: args.context,
          tags,
          ...(result.outcome ? { outcome: result.outcome } : {}),
        },
        { redactSecrets: config.retain.redactSecrets },
      );
      return response;
    },

    async listRetainReceipts(cwd: string, limit?: number) {
      return listRetainReceipts(cwd, limit);
    },

    async flush(cwd: string, sessionFile?: string) {
      const config = deps.getConfig();
      const meta = await readSessionMemoryMeta(cwd, sessionFile);
      if (
        !config.enabled ||
        !isMemorySetupComplete(config, cwd) ||
        !getEffectiveSessionMemoryMode(meta).retain
      ) {
        const summary = await summarizeRetainQueue(retainQueuePath(cwd, config));
        return {
          sent: 0,
          remaining: summary.active.valid,
          deadLettered: 0,
          malformed: summary.active.malformed,
        };
      }
      return flushRetain(cwd, config, deps.getClient());
    },
  };
}

function hasObservationScopes(scopes: HindsightObservationScopes): boolean {
  return typeof scopes === "string" ? scopes.length > 0 : scopes.length > 0;
}
