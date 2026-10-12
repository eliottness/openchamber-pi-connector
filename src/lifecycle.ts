import type { ManagedSession } from "./sessions.js";

/** Time and scheduling seams shared by the reaper and process shutdown tests. */
export interface LifecycleClock {
  now(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export const systemClock: LifecycleClock = {
  now: Date.now,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};

export interface LifecycleOptions {
  clock?: LifecycleClock;
  idleTimeoutMs?: number;
  maxLive?: number;
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Serializes admission, reaping, removal and shutdown, including in-flight spawns. */
export class SessionLifecycle {
  readonly clock: LifecycleClock;
  private readonly idleTimeoutMs: number;
  private readonly maxLive: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly used = new WeakMap<ManagedSession, number>();
  private readonly active = new WeakMap<ManagedSession, number>();
  private readonly disposing = new Set<Promise<void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(private sessions: () => Iterable<ManagedSession>, options: LifecycleOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idleTimeoutMs = options.idleTimeoutMs ?? positiveEnv("OCPI_IDLE_TIMEOUT_MS", 900_000);
    this.maxLive = options.maxLive ?? positiveEnv("OCPI_MAX_LIVE", 8);
    this.timer = this.clock.setInterval(() => {
      void this.reap().catch((error: unknown) => console.error("[lifecycle] reaper failed:", error));
    }, 60_000);
    this.timer.unref();
  }

  touch(s: ManagedSession): void {
    this.used.set(s, this.clock.now());
  }

  private idle(s: ManagedSession): boolean {
    return !this.active.has(s) && s.pi !== undefined && !s.pi.isBusy && s.status.type === "idle" &&
      !s.hasPendingInteraction() && !s.hasRunningChildren() &&
      s.piSessionId !== undefined && s.piPath !== undefined;
  }

  /** Protect the caller across awaits, including admission of a dormant session. */
  async use<T>(s: ManagedSession, action: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("session manager is stopping");
    this.active.set(s, (this.active.get(s) ?? 0) + 1);
    this.touch(s);
    try {
      return await action();
    } finally {
      const remaining = (this.active.get(s) ?? 1) - 1;
      if (remaining === 0) this.active.delete(s);
      else this.active.set(s, remaining);
      this.touch(s);
    }
  }

  run<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("session manager is stopping"));
    return this.enqueue(action);
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Called inside run(), before a process is spawned. */
  async makeRoom(): Promise<void> {
    while ([...this.sessions()].filter((s) => s.pi !== undefined).length >= this.maxLive) {
      const candidate = [...this.sessions()].filter((s) => this.idle(s))
        .sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0))[0];
      if (candidate === undefined) {
        console.error(`[lifecycle] OCPI_MAX_LIVE=${this.maxLive} exceeded: no disposable idle session`);
        return;
      }
      await this.dormant(candidate);
    }
  }

  async dormant(s: ManagedSession): Promise<void> {
    const pi = s.pi;
    if (pi === undefined) return;
    if (s.piSessionId !== undefined && s.piPath !== undefined) {
      s.restored = { piSessionId: s.piSessionId, piPath: s.piPath };
    }
    s.pi = undefined; // Old exit listeners must not mutate a revived session.
    const disposing = pi.dispose();
    this.disposing.add(disposing);
    try {
      await disposing;
    } finally {
      this.disposing.delete(disposing);
    }
  }

  reap(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.run(async () => {
      const now = this.clock.now();
      for (const s of this.sessions()) {
        if (this.idle(s) && now - (this.used.get(s) ?? now) >= this.idleTimeoutMs) {
          await this.dormant(s);
        }
      }
    });
  }

  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopped = true;
    this.clock.clearInterval(this.timer);
    this.stopping = this.enqueue(async () => {
      await Promise.all([
        ...[...this.sessions()].map((s) => this.dormant(s)),
        ...this.disposing,
      ]);
    });
    return this.stopping;
  }
}
