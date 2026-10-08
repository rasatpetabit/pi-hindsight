import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OperationCatalog } from "./operation-catalog.js";

export function registerTools(pi: ExtensionAPI, catalog: OperationCatalog) {
  const direct = new Set([
    "hindsight_recall",
    "hindsight_retain",
    "hindsight_retain_global",
    "hindsight_reflect",
  ]);
  for (const tool of catalog.tools) {
    const registration = {
      ...tool,
      exposure: direct.has(tool.name) ? ("direct" as const) : ("deferred" as const),
    };
    pi.registerTool(registration);
  }
}
