/**
 * Model/provider catalog: obtained from a throwaway `pi --mode rpc` process
 * (`get_available_models` + `get_state`), translated into OpenCode v2
 * Provider/Model shapes, cached for the adapter lifetime.
 */

import { PiRpcClient } from "./pi-rpc.js";
import { thinkingVariants, type ThinkingModel } from "./thinking-levels.js";

interface PiModelInfo extends ThinkingModel {
  id: string;
  provider: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface OCv2Model {
  id: string;
  providerID: string;
  api: { id: string; url: string; npm: string };
  name: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    interleaved: boolean;
  };
  cost: { input: number; output: number; cache: { read: number; write: number } };
  limit: { context: number; output: number };
  options: Record<string, unknown>;
  variants?: Record<string, Record<string, unknown>>;
}

export interface OCv2Provider {
  id: string;
  name: string;
  source: "config";
  env: string[];
  options: Record<string, unknown>;
  models: Record<string, OCv2Model>;
}

export interface Catalog {
  providers: OCv2Provider[];
  /** providerID → default modelID */
  defaults: Record<string, string>;
  /**
   * The model pi reported as *active*. Separate from `defaults` because the
   * client pins its picker to /api/model/default and then validates it against
   * the catalog — an arbitrary pick here silently becomes the model the UI
   * believes is running.
   */
  default?: { providerID: string; modelID: string };
  /** pi's resolved thinking level for `default` (its per-model setting). */
  defaultThinkingLevel?: string;
}

/**
 * OpenChamber preselects an agent's `model` + `variant` for new sessions; publish
 * pi's active model and its resolved thinking level so "Default" is pi's level.
 */
export function agentDefaults(cat: Catalog): { model?: { providerID: string; modelID: string }; variant?: string } {
  if (cat.default === undefined) return {};
  return cat.defaultThinkingLevel !== undefined
    ? { model: cat.default, variant: cat.defaultThinkingLevel }
    : { model: cat.default };
}

function toOCModel(m: PiModelInfo): OCv2Model {
  const inputs = new Set(m.input ?? ["text"]);
  const modality = (name: string): boolean => inputs.has(name);
  const variants = thinkingVariants(m);
  return {
    id: m.id,
    providerID: m.provider,
    api: { id: m.id, url: m.baseUrl ?? "", npm: "@ai-sdk/openai-compatible" },
    name: m.name ?? m.id,
    capabilities: {
      temperature: true,
      reasoning: m.reasoning ?? false,
      attachment: modality("image"),
      toolcall: true,
      input: { text: modality("text"), audio: false, image: modality("image"), video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: m.reasoning ? true : false,
    },
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cache: { read: m.cost?.cacheRead ?? 0, write: m.cost?.cacheWrite ?? 0 },
    },
    limit: { context: m.contextWindow ?? 0, output: m.maxTokens ?? 0 },
    options: {},
    ...(variants !== undefined ? { variants } : {}),
  };
}

export async function loadCatalog(directory: string): Promise<Catalog> {
  const pi = new PiRpcClient({ cwd: directory });
  try {
    const [modelsRes, firstState] = await Promise.all([
      pi.command<{ models: PiModelInfo[] }>({ type: "get_available_models" }),
      pi.command<{ model: PiModelInfo | null; thinkingLevel?: string }>({ type: "get_state" }),
    ]);

    const providers = new Map<string, OCv2Provider>();
    if (modelsRes.success && modelsRes.data) {
      for (const m of modelsRes.data.models) {
        let p = providers.get(m.provider);
        if (!p) {
          p = { id: m.provider, name: m.provider, source: "config", env: [], options: {}, models: {} };
          providers.set(m.provider, p);
        }
        p.models[m.id] = toOCModel(m);
      }
    }

    // get_state occasionally races pi's own startup. One retry beats resolving
    // no active model, which is precisely what leaves the UI picker guessing.
    let active = firstState.success ? firstState.data?.model ?? null : null;
    let thinkingLevel = firstState.success ? firstState.data?.thinkingLevel : undefined;
    if (active === null) {
      const retry = await pi.command<{ model: PiModelInfo | null; thinkingLevel?: string }>({ type: "get_state" });
      active = retry.success ? retry.data?.model ?? null : null;
      thinkingLevel = retry.success ? retry.data?.thinkingLevel : undefined;
    }
    if (active === null) {
      console.error("[catalog] warning: pi reported no active model — /api/model/default will be null and the UI picker falls back to its own default");
    }

    const defaults: Record<string, string> = {};
    let resolvedDefault: { providerID: string; modelID: string } | undefined;
    if (active !== null) {
      defaults[active.provider] = active.id;
      resolvedDefault = { providerID: active.provider, modelID: active.id };
      // The client drops any selection it cannot find in this catalog and picks
      // something else instead, so a model get_available_models omitted still
      // has to be listed here — otherwise the active model is unselectable.
      let p = providers.get(active.provider);
      if (p === undefined) {
        p = { id: active.provider, name: active.provider, source: "config", env: [], options: {}, models: {} };
        providers.set(active.provider, p);
      }
      if (p.models[active.id] === undefined) p.models[active.id] = toOCModel(active);
    }

    // OpenChamber's picker defaults to the first listed provider/model — put pi's active config there.
    const sorted = [...providers.values()].sort((a, b) => {
      const aDef = defaults[a.id] !== undefined ? 0 : 1;
      const bDef = defaults[b.id] !== undefined ? 0 : 1;
      return aDef - bDef;
    });
    for (const p of sorted) {
      const def = defaults[p.id];
      if (!def) continue;
      const entries = Object.entries(p.models).sort(([a], [b]) => (a === def ? -1 : b === def ? 1 : 0));
      p.models = Object.fromEntries(entries);
    }

    // exactOptionalPropertyTypes: omit `default` rather than set it undefined.
    if (resolvedDefault === undefined) return { providers: sorted, defaults };
    // Only a level the catalog offers as a variant is selectable in the picker.
    const offered = sorted.find((p) => p.id === resolvedDefault.providerID)?.models[resolvedDefault.modelID]?.variants;
    return thinkingLevel !== undefined && offered?.[thinkingLevel] !== undefined
      ? { providers: sorted, defaults, default: resolvedDefault, defaultThinkingLevel: thinkingLevel }
      : { providers: sorted, defaults, default: resolvedDefault };
  } finally {
    await pi.dispose();
  }
}
