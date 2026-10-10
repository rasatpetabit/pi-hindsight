import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, resolveConfig } from "../extensions/config/config.js";
import { createMemoryOperations } from "../extensions/operations/memory-operation-service.js";
import { scopeTagsForBank, selectMemoryScopes } from "../extensions/operations/memory-scope.js";
import type { HindsightLikeClient, ResolvedConfig } from "../extensions/types.js";

const UNSCOPED_BANK = "shared-history";
const REPO_TAG = "project:github.com/owner/repo";

function repoCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-unscoped-"));
  mkdirSync(join(cwd, ".git"));
  return cwd;
}

function configWith(overrides: Partial<ResolvedConfig["scope"]> = {}): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    scope: {
      ...DEFAULT_CONFIG.scope,
      unscopedRecallBanks: [UNSCOPED_BANK],
      ...overrides,
    },
    banks: { ...DEFAULT_CONFIG.banks, user: { enabled: true, bankId: "life-bank" } },
    retain: { ...DEFAULT_CONFIG.retain, async: false },
  };
}

function recordingOperations(config: ResolvedConfig) {
  const calls: Array<{ method: string; bank: string; options: unknown }> = [];
  const client: HindsightLikeClient = {
    retain: async (bank, _content, options) => {
      calls.push({ method: "retain", bank, options });
    },
    recall: async (bank, _query, options) => {
      calls.push({ method: "recall", bank, options });
      return [];
    },
    reflect: async (bank, _query, options) => {
      calls.push({ method: "reflect", bank, options });
      return {};
    },
  };
  const operations = createMemoryOperations({
    getClient: () => client,
    getConfig: () => config,
    getProjectBankId: () => "project-bank",
  });
  return { calls, operations };
}

const projectScopeGroup = {
  tags: [expect.stringMatching(/^project:/), expect.stringMatching(/^repo:/)],
  match: "any_strict",
};

describe("scope.unscopedRecallBanks", () => {
  it("defaults to an empty list", () => {
    expect(DEFAULT_CONFIG.scope.unscopedRecallBanks).toEqual([]);
  });

  it("drops the automatic scope group for a listed bank on recall and keeps caller tags", async () => {
    const cwd = repoCwd();
    const { calls, operations } = recordingOperations(configWith());

    await operations.recall(cwd, "query", UNSCOPED_BANK, undefined, {
      tags: [REPO_TAG],
      tagsMatch: "all_strict",
    });
    await operations.recall(cwd, "query", UNSCOPED_BANK);

    const [narrowed, whole] = calls.filter((call) => call.method === "recall");
    expect(narrowed?.bank).toBe(UNSCOPED_BANK);
    expect(narrowed?.options).toEqual(
      expect.objectContaining({ tagGroups: [{ tags: [REPO_TAG], match: "all_strict" }] }),
    );
    expect(whole?.options).not.toHaveProperty("tagGroups");
  });

  it("drops the automatic scope group for a listed bank on reflect and keeps caller tag groups", async () => {
    const cwd = repoCwd();
    const { calls, operations } = recordingOperations(configWith());

    await operations.reflect(cwd, "query", undefined, UNSCOPED_BANK, undefined, {
      tagGroups: [{ tags: [REPO_TAG], match: "any_strict" }],
    });

    const reflect = calls.find((call) => call.method === "reflect");
    expect(reflect?.bank).toBe(UNSCOPED_BANK);
    expect(reflect?.options).toEqual(
      expect.objectContaining({ tagGroups: [{ tags: [REPO_TAG], match: "any_strict" }] }),
    );
  });

  it("does not narrow a listed bank to untagged memories when shared observations are on", async () => {
    const cwd = repoCwd();
    const { calls, operations } = recordingOperations(
      configWith({ includeSharedObservations: true }),
    );

    await operations.recall(cwd, "query", UNSCOPED_BANK);
    await operations.recall(cwd, "query", UNSCOPED_BANK, undefined, {
      includeSharedObservations: true,
    });

    for (const call of calls.filter((entry) => entry.method === "recall")) {
      expect(call.options).not.toHaveProperty("tagGroups");
    }
  });

  it("keeps the automatic scope group for an unlisted bank", async () => {
    const cwd = repoCwd();
    const { calls, operations } = recordingOperations(configWith());

    await operations.recall(cwd, "query", "other-bank", undefined, {
      tags: [REPO_TAG],
      tagsMatch: "all_strict",
    });
    await operations.reflect(cwd, "query", undefined, "project");

    expect(calls.find((call) => call.method === "recall")?.options).toMatchObject({
      tagGroups: [projectScopeGroup, { tags: [REPO_TAG], match: "all_strict" }],
    });
    expect(calls.find((call) => call.method === "reflect")?.options).toMatchObject({
      tagGroups: [projectScopeGroup],
    });
  });

  it("leaves the User Bank and the default project bank unchanged when they are not listed", () => {
    const cwd = repoCwd();
    const config = configWith();

    expect(scopeTagsForBank(cwd, config, "life-bank")).toEqual(["source:pi", "harness:pi"]);
    expect(scopeTagsForBank(cwd, config, UNSCOPED_BANK)).toEqual([]);
    expect(selectMemoryScopes(cwd, config)).toEqual([
      expect.objectContaining({ kind: "project", tagGroups: [projectScopeGroup] }),
      {
        kind: "global",
        bankId: "life-bank",
        tagGroups: [{ tags: ["source:pi", "harness:pi"], match: "any_strict" }],
      },
    ]);
  });

  it("drops the scope group from automatic recall only for a listed bank", () => {
    const cwd = repoCwd();
    const base = configWith();
    const projectBankId = selectMemoryScopes(cwd, base)[0]!.bankId;
    const config = configWith({ unscopedRecallBanks: [projectBankId] });

    expect(selectMemoryScopes(cwd, config)).toEqual([
      { kind: "project", bankId: projectBankId, tagGroups: [] },
      {
        kind: "global",
        bankId: "life-bank",
        tagGroups: [{ tags: ["source:pi", "harness:pi"], match: "any_strict" }],
      },
    ]);
  });

  it("still writes project scope tags when retaining to a listed bank", async () => {
    const cwd = repoCwd();
    const { calls, operations } = recordingOperations(configWith());

    await operations.retainExplicit({
      cwd,
      content: "durable fact",
      context: "test",
      bank: UNSCOPED_BANK,
    });

    const retain = calls.find((call) => call.method === "retain");
    expect(retain?.bank).toBe(UNSCOPED_BANK);
    expect(retain?.options).toEqual(
      expect.objectContaining({
        tags: expect.arrayContaining([
          "source:pi",
          "harness:pi",
          expect.stringMatching(/^project:/),
          expect.stringMatching(/^repo:/),
        ]),
      }),
    );
  });

  it("normalizes the configured list and rejects non-string entries", () => {
    const cwd = repoCwd();
    const home = mkdtempSync(join(tmpdir(), "pi-hindsight-unscoped-home-"));
    const env = { ...process.env, HOME: home };
    mkdirSync(join(cwd, ".pi"));
    const write = (value: unknown) =>
      writeFileSync(
        join(cwd, ".pi", "hindsight.json"),
        JSON.stringify({ scope: { unscopedRecallBanks: value } }),
      );

    expect(resolveConfig(cwd, env).scope.unscopedRecallBanks).toEqual([]);

    write([UNSCOPED_BANK, ` ${UNSCOPED_BANK} `, "", "other-bank"]);
    expect(resolveConfig(cwd, env).scope.unscopedRecallBanks).toEqual([
      UNSCOPED_BANK,
      "other-bank",
    ]);

    write([UNSCOPED_BANK, 1]);
    expect(resolveConfig(cwd, env).scope.unscopedRecallBanks).toEqual([]);

    write(UNSCOPED_BANK);
    expect(resolveConfig(cwd, env).scope.unscopedRecallBanks).toEqual([]);
  });
});
