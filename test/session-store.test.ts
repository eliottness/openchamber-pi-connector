import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanAllPiSessions, scanPiSessions, SessionPersistenceError, SessionStore } from "../src/session-store.js";

test("F2 B3 failed registry writes reject essential metadata instead of acknowledging success", () => {
  const state = "/dev/null/F2-state";
  const store = new SessionStore(state);
  const entry = {
    piSessionId: "F2", piPath: "/nonexistent/F2.jsonl", directory: "/nonexistent/F2",
    created: 1, updated: 2, parentID: "ses_parent",
    tree: { messageEntries: {}, leafId: "reverted-leaf" },
  };
  assert.throws(() => store.set("ses_F2", entry), (error: unknown) =>
    error instanceof SessionPersistenceError && error.cause instanceof Error &&
    "code" in error.cause && error.cause.code === "ENOTDIR");
  assert.equal(store.get("ses_F2"), undefined, "failed save must not leave a falsely persisted cache entry");
  assert.equal(new SessionStore(state).get("ses_F2"), undefined);
});

test("F2 B3 failed registry updates and removals preserve the last committed cache", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ocpi-store-f2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const store = new SessionStore(state);
  const entry = { piSessionId: "F2", piPath: "/nonexistent/F2.jsonl", directory: root, created: 1, updated: 2 };
  store.set("ses_F2", entry);
  rmSync(state, { recursive: true });
  writeFileSync(state, "not a directory");
  assert.throws(() => store.update("ses_F2", { updated: 3 }), SessionPersistenceError);
  assert.deepEqual(store.get("ses_F2"), entry);
  assert.throws(() => store.remove("ses_F2"), SessionPersistenceError);
  assert.deepEqual(store.get("ses_F2"), entry);
});

function withAgentDir(agentDir: string, run: () => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function sessionHeader(id: string, cwd: string): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-12T00:00:00.000Z",
    cwd,
  })}\n`;
}

function sessionDir(agentDir: string, cwd: string): string {
  const sanitized = cwd.replace(/^[/\\]+/, "").replace(/[\\/:\u0000]/g, "-");
  return join(agentDir, "sessions", `--${sanitized}--`);
}

test("scanAllPiSessions finds OmO sessions across cwd folders", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "ocpi-agent-"));
  const firstCwd = "/tmp/openchamber-first";
  const secondCwd = "/tmp/openchamber-second";
  try {
    withAgentDir(agentDir, () => {
      for (const [cwd, id] of [
        [firstCwd, "first-session"],
        [secondCwd, "second-session"],
      ] as const) {
        const dir = sessionDir(agentDir, cwd);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.jsonl`), sessionHeader(id, cwd));
      }

      const scanned = scanAllPiSessions();
      assert.deepEqual(
        new Map(scanned.map((session) => [session.piSessionId, session.directory])),
        new Map([
          ["first-session", firstCwd],
          ["second-session", secondCwd],
        ]),
      );
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("scanPiSessions skips a header whose cwd mismatches its folder", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "ocpi-agent-"));
  const expectedCwd = "/tmp/openchamber-expected";
  try {
    withAgentDir(agentDir, () => {
      const dir = sessionDir(agentDir, expectedCwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mismatch.jsonl"), sessionHeader("mismatch-session", "/tmp/other-cwd"));

      assert.deepEqual(scanPiSessions(expectedCwd), []);
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
