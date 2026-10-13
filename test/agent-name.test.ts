import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const probe = "import { getExposedAgentNames } from './src/agent-name.ts'; console.log(JSON.stringify(getExposedAgentNames()));";
const legacyProbe = `
  import { AdapterServer } from './src/server.ts';
  const server = new AdapterServer({ host: '127.0.0.1', port: 0, defaultDirectory: process.env.OCPI_TEST_DIRECTORY });
  try {
    await server.start();
    const created = await fetch(\`\${server.url}/session\`, { method: 'POST', body: '{}' });
    const session = await created.json();
    const prompt = await fetch(\`\${server.url}/session/\${session.id}/message\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'build', parts: [{ type: 'text', text: 'legacy build agent prompt' }] }),
    });
    const alias = await fetch(\`\${server.url}/api/agent/build\`);
    console.log(JSON.stringify({ prompt: prompt.status, alias: alias.status }));
  } finally {
    await server.stop();
  }
`;

function exposedNames(env: NodeJS.ProcessEnv): string[] {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", probe], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  })) as string[];
}

test("resolved OmO agent is first and build remains a compatibility alias", () => {
  const home = mkdtempSync(join(tmpdir(), "ocpi-agent-name-"));
  try {
    assert.deepEqual(exposedNames({ HOME: home, OCPI_AGENT: "OmO" }), ["OmO", "build"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no resolved agent exposes only build", () => {
  const home = mkdtempSync(join(tmpdir(), "ocpi-agent-name-"));
  try {
    assert.deepEqual(exposedNames({ HOME: home, OCPI_AGENT: "" }), ["build"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a legacy build-agent session still accepts a prompt", () => {
  const state = mkdtempSync(join(tmpdir(), "ocpi-agent-state-"));
  try {
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", legacyProbe], {
      cwd: root,
      env: {
        ...process.env,
        OCPI_AGENT: "OmO",
        OCPI_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
        OCPI_STATE_DIR: state,
        OCPI_TEST_DIRECTORY: state,
      },
      encoding: "utf8",
    })) as { prompt: number; alias: number };
    assert.deepEqual(result, { prompt: 200, alias: 200 });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
