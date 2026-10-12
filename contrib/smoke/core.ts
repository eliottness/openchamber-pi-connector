import type { OCEvent } from "../../src/types.js";

export interface CheckOptions {
  timeoutMs?: number;
  /** Prerequisites must already be registered; --only includes them. */
  dependsOn?: readonly string[];
}

export interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

export type Check = (name: string, fn: (signal: AbortSignal) => Promise<void>, options?: CheckOptions) => void;

export function parseOnly(args: readonly string[]): Set<string> | undefined {
  if (args.length === 0) return undefined;
  if (args[0] !== "--only") throw new Error(`unknown argument: ${args[0]}`);
  if (args.length !== 2 || !args[1]?.trim()) throw new Error("--only requires <name,...>");
  const names = args[1].split(",").map((name) => name.trim());
  if (names.some((name) => name === "")) throw new Error("--only requires non-empty names");
  return new Set(names);
}

export function summarize(results: readonly CheckResult[]) {
  const pass = results.filter((result) => result.status === "PASS").length;
  const fail = results.filter((result) => result.status === "FAIL").length;
  const skip = results.filter((result) => result.status === "SKIP").length;
  return { pass, fail, skip, exitCode: fail > 0 ? 1 : 0 };
}

export class SmokeRegistry {
  private checks: Array<{ name: string; fn: (signal: AbortSignal) => Promise<void>; options: CheckOptions }> = [];

  readonly check: Check = (name, fn, options = {}) => {
    if (this.checks.some((check) => check.name === name)) throw new Error(`duplicate check: ${name}`);
    for (const dependency of options.dependsOn ?? []) {
      if (!this.checks.some((check) => check.name === dependency)) throw new Error(`unregistered prerequisite: ${dependency}`);
    }
    this.checks.push({ name, fn, options });
  };

  async run(options: { only?: Set<string> | undefined; signal?: AbortSignal; log: (line: string) => void }): Promise<CheckResult[]> {
    const selected = new Set(options.only ?? this.checks.map((check) => check.name));
    const include = (name: string): void => {
      const check = this.checks.find((check) => check.name === name);
      if (!check) throw new Error(`unknown check: ${name}`);
      for (const dependency of check.options.dependsOn ?? []) {
        selected.add(dependency);
        include(dependency);
      }
    };
    for (const name of selected) include(name);
    const results: CheckResult[] = [];
    let failed = false;
    for (const check of this.checks) {
      let result: CheckResult;
      if (!selected.has(check.name) || failed || options.signal?.aborted) {
        result = { name: check.name, status: "SKIP", detail: !selected.has(check.name) ? "filtered" : "previous failure or interruption" };
      } else {
        const controller = new AbortController();
        const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const deadline = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => controller.abort(new Error(`check timed out after ${check.options.timeoutMs ?? 120_000}ms`)), check.options.timeoutMs ?? 120_000);
        });
        try {
          await Promise.race([check.fn(signal), deadline]);
          signal.throwIfAborted();
          result = { name: check.name, status: "PASS", detail: "" };
        } catch (error) {
          result = { name: check.name, status: "FAIL", detail: error instanceof Error ? error.message : String(error) };
          failed = true;
        } finally {
          clearTimeout(timer);
          if (onAbort) signal.removeEventListener("abort", onAbort);
          controller.abort(new Error("check finished"));
        }
      }
      results.push(result);
      options.log(`${result.status} ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
    }
    const summary = summarize(results);
    options.log(`SUMMARY PASS=${summary.pass} FAIL=${summary.fail} SKIP=${summary.skip} exit=${summary.exitCode}`);
    return results;
  }
}

/** Future-only waits prevent an earlier idle/delta from satisfying a new turn. */
export class SseCollector {
  readonly events: OCEvent[] = [];
  private waiters = new Set<{ predicate: (event: OCEvent) => boolean; resolve: (event: OCEvent) => void; reject: (error: Error) => void }>();
  private controller = new AbortController();
  private pumping: Promise<void> | undefined;

  async start(url: string, signal: AbortSignal): Promise<void> {
    const response = await fetch(`${url}/global/event`, {
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.any([this.controller.signal, signal]),
    });
    if (!response.ok || !response.body) throw new Error(`SSE connection failed: HTTP ${response.status}`);
    this.pumping = this.consume(response.body);
  }

  async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end === -1) break;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data:"));
          if (!data) continue;
          const event: OCEvent = JSON.parse(data.slice(5));
          this.events.push(event);
          for (const waiter of [...this.waiters]) {
            if (waiter.predicate(event)) waiter.resolve(event);
          }
        }
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
      this.fail(new Error("SSE stream closed"));
    }
  }

  waitForEvent(predicate: (event: OCEvent) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<OCEvent> {
    const promise = new Promise<OCEvent>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", abort);
      };
      const waiter = {
        predicate,
        resolve: (event: OCEvent) => { finish(); resolve(event); },
        reject: (error: Error) => { finish(); reject(error); },
      };
      const abort = (): void => waiter.reject(new Error("SSE wait cancelled"));
      const timer = setTimeout(() => waiter.reject(new Error(`event timed out after ${timeoutMs}ms`)), timeoutMs);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    // Callers subscribe before their HTTP action, which can itself fail.
    void promise.catch(() => undefined);
    return promise;
  }

  private fail(error: Error): void {
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.pumping;
  }
}
