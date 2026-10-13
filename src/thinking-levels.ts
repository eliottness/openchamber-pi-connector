import type { PiRpcClient } from "./pi-rpc.js";
import type { OCModelRef } from "./types.js";

export interface ModelSelection extends OCModelRef {
  readonly variant?: string;
}

export interface ThinkingModel {
  readonly reasoning?: boolean;
  readonly supportedThinkingLevels?: readonly string[];
  readonly thinkingLevelMap?: Readonly<Record<string, unknown>>;
}

/** OmO's RPC list is authoritative; null map entries explicitly disable a level. */
export function thinkingVariants(model: ThinkingModel): Record<string, Record<string, unknown>> | undefined {
  if (!model.reasoning) return undefined;
  const levels = model.supportedThinkingLevels
    ?? Object.entries(model.thinkingLevelMap ?? {}).filter(([, value]) => value !== null).map(([level]) => level);
  return levels.length === 0 ? undefined : Object.fromEntries(levels.map((level) => [level, {}]));
}

export interface ThinkingState {
  thinkingLevel?: string;
}

/** Cache only the level OmO actually applied, including when it clamps a request. */
export async function setThinkingLevel(state: ThinkingState, pi: PiRpcClient, level: string | undefined): Promise<void> {
  if (level === undefined || state.thinkingLevel === level) return;
  const response = await pi.command({ type: "set_thinking_level", level });
  if (!response.success) throw new Error(response.error ?? `pi refused thinking level ${level}`);
  const current = await pi.command<{ thinkingLevel: string }>({ type: "get_state" });
  if (!current.success || !current.data) throw new Error(current.error ?? "pi returned no thinking state");
  state.thinkingLevel = current.data.thinkingLevel;
  if (state.thinkingLevel !== level) throw new Error(`pi requested thinking level ${level} but applied ${state.thinkingLevel}`);
}
