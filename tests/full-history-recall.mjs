#!/usr/bin/env bun
// Offline reproduction: does the REAL pi-hindsight recall callback (context hook,
// injectionPosition "append" — the live configured value) alter an already-sent
// serialized provider request prefix between initial user request, tool
// continuation, and next user message, on full-history routes?
//
// Real components: pi-hindsight extension (this source worktree, loaded
// via Pi's real extension loader + real ExtensionRunner.emitContext), real
// pi-agent-core Agent loop, real convertToLlm, real pi-ai serializers for
// anthropic-messages and openai-completions. Mock transports only: provider
// fetch (SSE fixtures) and Hindsight HTTP (local Bun.serve; NO live Hindsight
// API, NO model calls).
//
// Run with bun, PI_TEST_RUNTIME and RECALL_TEST_SCRATCH. Synthetic content only.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCRATCH = process.env.RECALL_TEST_SCRATCH;
if (!SCRATCH) throw new Error("RECALL_TEST_SCRATCH must name an isolated scratch directory");
mkdirSync(SCRATCH, { recursive: true });
const PI = process.env.PI_TEST_RUNTIME;
if (!PI) throw new Error("PI_TEST_RUNTIME must name a real Pi runtime");
const EXT = fileURLToPath(new URL("..", import.meta.url)); // worktree only, never installed extension

const out = (name, data) =>
  writeFileSync(
    join(SCRATCH, name),
    typeof data === "string" ? data : JSON.stringify(data, null, 2),
    { mode: 0o600 },
  );

// --- scrub env: no live credentials, isolated HOME/cwd -----------------------
for (const k of Object.keys(process.env)) {
  if (
    k.startsWith("HINDSIGHT_") ||
    k.startsWith("ANTHROPIC_") ||
    k.startsWith("OPENAI_") ||
    k.startsWith("PI_")
  )
    delete process.env[k];
}
process.env.PI_SUBAGENT_CHILD = undefined;
const home = join(SCRATCH, "home");
const cwd = join(SCRATCH, "session-cwd");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(join(cwd, ".pi"), { recursive: true });
mkdirSync(join(cwd, ".git"), { recursive: true });
process.env.HOME = home;
process.chdir(cwd);

// --- mock Hindsight server (official client hits these endpoints) ------------
let clock = Date.now();
Date.now = () => clock;
let recallMode = "success";
let recallCalls = 0;
let branch = [];
let sessionId = "synthetic-session";
const hindsightLog = [];
const hindsight = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    hindsightLog.push({ method: req.method, path: url.pathname, body });
    if (url.pathname === "/v1/default/banks")
      return Response.json({ banks: [{ bank_id: "synthetic-bank", name: "synthetic-bank" }] });
    if (url.pathname.endsWith("/memories/recall")) {
      recallCalls++;
      if (recallMode === "outage")
        return Response.json({ detail: "synthetic offline" }, { status: 503 });
      if (recallMode === "empty") return Response.json({ results: [] });
      const q = String(body.query ?? "");
      // Distinct recall per logical turn so drop/replace is observable.
      const text = `SYNTHETIC_RECALL_${recallCalls}`;
      return Response.json({
        results: [{ type: "observation", text, occurred_start: "2026-10-01T00:00:00Z" }],
        query: q,
      });
    }
    if (url.pathname.endsWith("/mental-models"))
      return Response.json({ results: [], mental_models: [] });
    if (url.pathname === "/health") return Response.json({ status: "healthy" });
    return Response.json({});
  },
});

// User-level config mirrors the live ~/.pi/agent/hindsight.json recall block
// (authoritative runtime value injectionPosition "append") minus secrets.
writeFileSync(
  join(home, ".pi", "agent", "hindsight.json"),
  JSON.stringify({
    recall: {
      enabled: true,
      injectionPosition: "append",
      types: ["world", "experience", "observation"],
    },
  }),
);
writeFileSync(
  join(cwd, ".pi", "hindsight.json"),
  JSON.stringify({
    setupComplete: true,
    hindsight: { baseUrl: `http://127.0.0.1:${hindsight.port}`, timeoutMs: 3000 },
    banks: {
      project: { enabled: true, bankId: "synthetic-bank", derive: "manual" },
      user: { enabled: false },
    },
    retain: { enabled: false },
    recall: { storeLastRecall: false },
  }),
);

// --- load REAL extension through Pi's REAL loader ----------------------------
const { loadExtensions } = await import(join(PI, "dist/core/extensions/loader.js"));
const { ExtensionRunner } = await import(join(PI, "dist/core/extensions/runner.js"));
const loaded = await loadExtensions([join(EXT, "extensions/index.ts")], cwd);
if (loaded.errors.length) {
  console.error("extension load errors", loaded.errors);
  process.exit(2);
}
const sessionManager = {
  getSessionId: () => sessionId,
  getBranch: () => branch,
  getSessionFile: () => join(cwd, "session.jsonl"),
};
const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, {});
runner.onError((e) => {
  throw new Error(`extension error: ${JSON.stringify(e)}`);
});
await runner.emit({ type: "session_start", reason: "startup" });

// --- REAL agent loop + REAL serializer, mock transport ------------------------
const { Agent } = await import(
  join(PI, "node_modules/@earendil-works/pi-agent-core/dist/agent.js")
);
const { convertToLlm } = await import(join(PI, "dist/core/messages.js"));
const { streamSimple } = await import(
  join(PI, "node_modules/@earendil-works/pi-ai/dist/compat.js")
);
const models = (
  await import(join(PI, "node_modules/@earendil-works/pi-ai/dist/models.generated.js"))
).MODELS;

const providerFetchLog = []; // {api, seq, url, body}
const callCount = {}; // per api
async function mockProviderFetch(url, init) {
  const body = JSON.parse(init.body ?? "{}");
  const api = (body.model ?? "").includes("gpt-synthetic")
    ? "openai-completions"
    : "anthropic-messages";
  const seq = (callCount[api] = (callCount[api] ?? 0) + 1);
  providerFetchLog.push({ api, seq, url: String(url), body });
  const sse = (events) =>
    new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  const toolName = "read_fixture";
  if (api === "anthropic-messages") {
    if (seq === 1 || seq === 3) {
      return sse([
        {
          type: "message_start",
          message: {
            id: `msg_${seq}`,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_prefix", name: toolName, input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
      ]);
    }
    return sse([
      {
        type: "message_start",
        message: {
          id: `msg_${seq}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Synthetic answer" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 20 },
      },
      { type: "message_stop" },
    ]);
  }
  // openai-completions chat chunks
  const chunk = (delta, finish_reason) => ({
    id: `chatcmpl-${seq}`,
    object: "chat.completion.chunk",
    created: 1,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  if (seq === 1 || seq === 3) {
    return sse([
      chunk(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_prefix",
              type: "function",
              function: { name: toolName, arguments: "{}" },
            },
          ],
        },
        null,
      ),
      chunk({}, "tool_calls"),
      {
        id: `chatcmpl-${seq}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      },
    ]);
  }
  return sse([
    chunk({ role: "assistant", content: "Synthetic answer" }, null),
    chunk({}, "stop"),
    {
      id: `chatcmpl-${seq}`,
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    },
  ]);
}

const tool = {
  name: "read_fixture",
  description: "Synthetic read",
  jsonSchema: undefined,
  parameters: { type: "object", properties: {} },
  execute: async () => {
    clock += 61_000;
    return { content: [{ type: "text", text: "SYNTHETIC_RESULT" }] };
  },
};

const anthropicBase = models.anthropic["claude-fable-5"];
const routes = [
  {
    name: "anthropic-messages/claude-fable-5",
    model: { ...anthropicBase, baseUrl: "http://127.0.0.1:9/v1" },
  },
  {
    name: "openai-completions/litellm-gpt-synthetic",
    model: {
      id: "gpt-synthetic",
      name: "Synthetic GPT",
      api: "openai-completions",
      provider: "litellm",
      baseUrl: "http://127.0.0.1:9/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    },
  },
];

const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const stripCacheControl = (k, v) => (k === "cache_control" ? undefined : v);
const normBody = (body) => ({
  system:
    body.system === undefined ? undefined : hash(JSON.stringify(body.system, stripCacheControl)),
  tools: hash(JSON.stringify(body.tools ?? [], stripCacheControl)),
  messages: (body.messages ?? []).map((m) => hash(JSON.stringify(m, stripCacheControl))),
  roles: (body.messages ?? []).map((m) => m.role),
  cacheMarkers: (body.messages ?? [])
    .flatMap((m, i) => (JSON.stringify(m).includes("cache_control") ? [`messages[${i}]`] : []))
    .concat(
      body.system !== undefined && JSON.stringify(body.system).includes("cache_control")
        ? ["system"]
        : [],
    ),
});

async function runRoute(route) {
  for (const k of Object.keys(callCount)) delete callCount[k];
  const startSeq = providerFetchLog.length;
  const startRecalls = recallCalls;
  sessionId = route.name;
  const agent = new Agent({
    initialState: {
      systemPrompt: "Synthetic system prompt for cache-prefix study.",
      model: route.model,
      thinkingLevel: "off",
      tools: [tool],
      messages: [],
    },
    convertToLlm,
    transformContext: async (messages) => {
      branch = messages.map((message, i) => ({ type: "message", id: `entry-${i}`, message }));
      const first = await runner.emitContext(messages);
      const second = await runner.emitContext(messages);
      assert.deepEqual(first, second, "repeated real context events must be identical");
      assert.equal(JSON.stringify(messages).includes("SYNTHETIC_RECALL"), false);
      return first;
    }, // REAL context-hook chain
    streamFn: (model, context, options) =>
      streamSimple(model, context, {
        ...options,
        apiKey: "synthetic-offline",
        fetch: mockProviderFetch,
        maxRetries: 0,
        timeoutMs: 10000,
      }),
    sessionId: "synthetic-session",
  });
  await agent.prompt("Use the synthetic read tool"); // request A (+ tool continuation request B)
  clock += 61_000;
  await agent.prompt("New question for fresh memory"); // request C + continuation D
  clock += 61_000;
  await agent.prompt("New question for fresh memory"); // identical prompt, distinct T3, request E
  console.error(
    `route ${route.name} state roles:`,
    agent.state.messages.map((m) => `${m.role}${m.stopReason ? ":" + m.stopReason : ""}`).join(","),
  );
  const reqs = providerFetchLog
    .slice(startSeq)
    .map((r) => ({ api: r.api, seq: r.seq, ...normBody(r.body) }));
  assert.equal(
    recallCalls - startRecalls,
    3,
    "one query per new turn, none on tool rounds/repeated callbacks",
  );
  const bodies = providerFetchLog
    .slice(startSeq)
    .map((r) => JSON.parse(JSON.stringify(r.body, stripCacheControl)));
  assert.equal(bodies.length, 5);
  for (let i = 1; i < bodies.length; i++) {
    assert.deepEqual(
      bodies[i].messages.slice(0, bodies[i - 1].messages.length),
      bodies[i - 1].messages,
      `request ${i} retains exact historical serialized bytes and positions`,
    );
  }
  for (const [i, expected] of [1, 1, 2, 2, 3].entries()) {
    assert.equal(
      bodies[i].messages.filter((m) => JSON.stringify(m).includes("SYNTHETIC_RECALL")).length,
      expected,
      "fresh recall appears once, beside new user only",
    );
  }
  const transcriptHasRecall = JSON.stringify(agent.state.messages).includes("SYNTHETIC_RECALL");
  return { route: route.name, requests: reqs, transcriptHasRecall };
}

const results = [];
for (const route of routes) results.push(await runRoute(route));

// Lifecycle edges also traverse the real runner, convertToLlm and both serializers.
// Session branch entries are synthetic plain data using Pi's supported entry IDs.
let edgeRoutes = 0;
for (const route of routes) {
  sessionId = `edges-${route.name}`;
  const user = (timestamp) => ({
    role: "user",
    content: [{ type: "text", text: "identical prompt" }],
    timestamp,
  });
  const t1 = user(1),
    t2 = user(1); // Deliberate timestamp/content collision: session entry IDs disambiguate.
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: route.model.api,
    provider: route.model.provider,
    model: route.model.id,
    stopReason: "stop",
    timestamp: 3,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "synthetic",
    toolName: "read_fixture",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: 4,
  };
  const serialize = async (messages, ids, fullBranch) => {
    branch = fullBranch ?? messages.map((message, i) => ({ type: "message", id: ids[i], message }));
    const original = structuredClone(messages);
    const patched = await runner.emitContext(messages);
    assert.deepEqual(await runner.emitContext(messages), patched);
    assert.deepEqual(messages, original, "underlying transcript remains clean");
    const response = await streamSimple(
      route.model,
      { systemPrompt: "stable system", messages: convertToLlm(patched), tools: [tool] },
      { apiKey: "synthetic-offline", fetch: mockProviderFetch, maxRetries: 0, timeoutMs: 10000 },
    ).result();
    assert.notEqual(response.stopReason, "error", JSON.stringify(response));
    return {
      patched,
      body: JSON.parse(JSON.stringify(providerFetchLog.at(-1).body, stripCacheControl)),
    };
  };
  const recallMessages = (result) =>
    result.body.messages.filter((m) => JSON.stringify(m).includes("SYNTHETIC_RECALL"));
  const a = await serialize([t1], ["u1"]);
  clock += 61_000;
  const b = await serialize([t1, assistant, t2], ["u1", "a1", "u2"]);
  assert.deepEqual(recallMessages(b).slice(0, 1), recallMessages(a));
  assert.equal(recallMessages(b).length, 2);
  const calls = recallCalls;
  const rewind = await serialize([t1], ["u1"]);
  assert.deepEqual(rewind.body, a.body);
  assert.equal(recallCalls, calls);
  clock += 61_000;
  const sibling = await serialize([t1, assistant, t2], ["u1", "a1", "sibling-u2"]);
  assert.deepEqual(recallMessages(sibling).slice(0, 1), recallMessages(a));
  assert.notDeepEqual(recallMessages(sibling)[1], recallMessages(b)[1]);
  const compact = await serialize(
    [t2, assistant, toolResult],
    ["sibling-u2", "a2", "tool2"],
    [t1, assistant, t2, assistant, toolResult].map((message, i) => ({
      type: "message",
      id: ["u1", "a1", "sibling-u2", "a2", "tool2"][i],
      message,
    })),
  );
  assert.deepEqual(recallMessages(compact), recallMessages(sibling).slice(1));
  await serialize([], []);
  const reset = await serialize([t2, assistant], ["sibling-u2", "a2"]);
  assert.equal(recallMessages(reset).length, 0);
  sessionId = `switched-${route.name}`;
  const switched = await serialize([t1, assistant], ["u1", "a1"]);
  assert.equal(recallMessages(switched).length, 0);
  clock += 61_000;
  const newSession = await serialize([t1, assistant, t2], ["u1", "a1", "u2"]);
  assert.equal(recallMessages(newSession).length, 1);
  for (const mode of ["empty", "outage"]) {
    recallMode = mode;
    clock += 61_000;
    const t3 = {
      role: "user",
      content: [{ type: "text", text: `query-${mode}` }],
      timestamp: clock,
    };
    const failed = await serialize(
      [t1, assistant, t2, assistant, t3],
      ["u1", "a1", "u2", "a2", mode],
    );
    assert.deepEqual(recallMessages(failed), recallMessages(newSession));
    const failureCalls = recallCalls;
    clock += 61_000;
    recallMode = "success";
    const continuation = await serialize(
      [t1, assistant, t2, assistant, t3, assistant, toolResult],
      ["u1", "a1", "u2", "a2", mode, "a3", "tool3"],
    );
    assert.deepEqual(
      continuation.body.messages.slice(0, failed.body.messages.length),
      failed.body.messages,
    );
    assert.equal(
      recallCalls,
      failureCalls,
      "absence is frozen; recovery cannot insert beside a sent user",
    );
    await serialize([t1, assistant, t2], ["u1", "a1", "u2"]);
  }
  edgeRoutes++;
}
console.log(
  `PASS lifecycle edges: rewind/sibling/session/compaction/reset/empty/outage across ${edgeRoutes} real serializers`,
);

// --- analysis ------------------------------------------------------------------
const report = { verdict: "PENDING", results: [], hindsight: { recallCalls, log: hindsightLog } };
for (const r of results) {
  const [A, B, C] = r.requests;
  const analysis = {
    route: r.route,
    requestCount: r.requests.length,
    transcriptHasRecall: r.transcriptHasRecall,
  };
  if (!(A && B && C)) {
    analysis.error = "missing requests";
    report.results.push(analysis);
    continue;
  }
  analysis.roleSequences = { A: A.roles, B: B.roles, C: C.roles };
  analysis.systemStable = r.requests.every((request) => request.system === A.system);
  analysis.toolsStable = r.requests.every((request) => request.tools === A.tools);
  const prefixOf = (X, Y) =>
    X.messages.length <= Y.messages.length && X.messages.every((h, i) => h === Y.messages[i]);
  const firstDiff = (X, Y) => {
    const n = Math.min(X.messages.length, Y.messages.length);
    for (let i = 0; i < n; i++)
      if (X.messages[i] !== Y.messages[i])
        return { index: i, roleX: X.roles[i], roleY: Y.roles[i] };
    return X.messages.length === Y.messages.length
      ? null
      : { index: n, roleX: X.roles[n], roleY: Y.roles[n], tailOnly: true };
  };
  analysis.AisPrefixOfB = prefixOf(A, B);
  analysis.BisPrefixOfC = prefixOf(B, C);
  analysis.firstDiffAB = firstDiff(A, B);
  analysis.firstDiffBC = firstDiff(B, C);
  analysis.cacheMarkers = { A: A.cacheMarkers, B: B.cacheMarkers, C: C.cacheMarkers };
  report.results.push(analysis);
}
const reds = report.results.filter((r) => r.AisPrefixOfB === false || r.BisPrefixOfC === false);
report.verdict = reds.length
  ? "RED"
  : report.results.every((r) => r.requestCount === 5)
    ? "GREEN"
    : "INCONCLUSIVE";
out("harness-result.json", report);
out("provider-fetch-log.json", providerFetchLog);
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      hindsightRecallCalls: recallCalls,
      results: report.results.map(
        ({
          roleSequences,
          firstDiffAB,
          firstDiffBC,
          AisPrefixOfB,
          BisPrefixOfC,
          transcriptHasRecall,
          systemStable,
          toolsStable,
          cacheMarkers,
          route,
        }) => ({
          route,
          AisPrefixOfB,
          BisPrefixOfC,
          firstDiffAB,
          firstDiffBC,
          transcriptHasRecall,
          systemStable,
          toolsStable,
          roleSequences,
          cacheMarkers,
        }),
      ),
    },
    null,
    2,
  ),
);
hindsight.stop(true);
assert.equal(
  report.verdict,
  "GREEN",
  "already-sent serialized recall prefix must survive tool continuation and later turns",
);
for (const result of report.results) {
  assert.equal(result.transcriptHasRecall, false);
  assert.equal(result.systemStable, true);
  assert.equal(result.toolsStable, true);
}
