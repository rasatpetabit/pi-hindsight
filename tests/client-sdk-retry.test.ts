import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { createHindsightClient } from "../extensions/client/client.js";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import type { ResolvedConfig } from "../extensions/types.js";

/**
 * SDK 1.2.1 added internal capacity retries (retryOnCapacity, maxAttempts, default 3)
 * for the idempotent recall/reflect calls on 429/503. pi-hindsight owns retry policy
 * through withRetry (client-retry.ts), so createHindsightClient pins maxAttempts: 1:
 * the observed HTTP attempt count on a 503 must match the withRetry policy exactly,
 * never multiplied by an invisible SDK retry layer. Retain (a write) is never retried
 * by the SDK at any setting.
 */
describe("SDK 1.2.1 retry stacking", () => {
  let server: Server;
  let baseUrl: string;
  let requests: number;

  beforeEach(async () => {
    requests = 0;
    server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "capacity" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function config(): ResolvedConfig {
    return { ...DEFAULT_CONFIG, hindsight: { baseUrl, timeoutMs: 30_000 } };
  }

  it("sends exactly one recall attempt per call (SDK internal retry disabled)", async () => {
    const client = createHindsightClient(config());
    await expect(client.recall("bank", "query")).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("sends exactly one retain attempt per call (SDK never retries writes)", async () => {
    const client = createHindsightClient(config());
    await expect(client.retain("bank", "content")).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("matches the withRetry policy on 503 for retried calls without SDK multiplication", async () => {
    const client = createHindsightClient(config());
    // health is wrapped in withRetry (maxRetries 3): 1 attempt + 3 retries = 4 requests.
    // SDK stacking would show 4 × SDK maxAttempts; the pinned maxAttempts: 1 keeps it at 4.
    if (!client.health) throw new Error("client adapter is missing health");
    await expect(client.health()).rejects.toThrow();
    expect(requests).toBe(4);
  }, 20_000);

  it("shows the SDK default retry behavior the maxAttempts pin is defending against", async () => {
    // A raw SDK client with default options retries recall internally on 503:
    // DEFAULT_MAX_ATTEMPTS (3) requests for one call. This is the layer the pin removes.
    const raw = new HindsightClient({ baseUrl });
    await expect(raw.recall("bank", "query")).rejects.toThrow();
    expect(requests).toBe(3);
  });
});
