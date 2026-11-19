import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stableSessionId } from "../utils/session.js";

/** One append-mode anchor. Rendered text only: no query, blocks, bank ids, or telemetry. */
export interface RecallHistoryRecord {
  key: string;
  rendered: string;
  timestamp: number;
}

function recallHistoryRoot(): string {
  return join(process.env.HOME || homedir(), ".pi", "agent", "hindsight", "recall-history");
}

/** One file per anchor so two processes cannot clobber each other's updates. */
export function recallHistoryPath(sessionFile: string, cwd: string, key: string): string {
  const name = createHash("sha256").update(key).digest("hex");
  return join(recallHistoryRoot(), stableSessionId(sessionFile, cwd), `${name}.json`);
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const root = dirname(dir);
  if (basename(root) === "recall-history") chmodSync(root, 0o700);
}

export function readRecallHistory(
  sessionFile: string | undefined,
  cwd: string,
  key: string,
): RecallHistoryRecord | undefined {
  if (!sessionFile) return undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(recallHistoryPath(sessionFile, cwd, key), "utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as { key?: unknown; rendered?: unknown; timestamp?: unknown };
    if (record.key !== key) return undefined;
    if (typeof record.rendered !== "string" || typeof record.timestamp !== "number")
      return undefined;
    return { key, rendered: record.rendered, timestamp: record.timestamp };
  } catch {
    return undefined;
  }
}

export function writeRecallHistory(
  sessionFile: string | undefined,
  cwd: string,
  record: RecallHistoryRecord,
): void {
  if (!sessionFile) return;
  const file = recallHistoryPath(sessionFile, cwd, record.key);
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify({ key: record.key, rendered: record.rendered, timestamp: record.timestamp })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may not exist if creation itself failed.
    }
    throw error;
  }
}
