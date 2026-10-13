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


const configProbe = `
  import { AdapterServer } from './src/server.ts';
  const server = new AdapterServer({ host: '127.0.0.1', port: 0, defaultDirectory: process.env.OCPI_TEST_DIRECTORY });
  try {
    await server.start();
    const v1Config = await fetch(\`\${server.url}/config\`).then(r => r.json());
    const v2Config = await fetch(\`\${server.url}/api/config\`).then(r => r.json());
    const v1Agents = await fetch(\`\${server.url}/agent\`).then(r => r.json());
    const v2Agents = await fetch(\`\${server.url}/api/agent\`).then(r => r.json());
    console.log(JSON.stringify({ v1Config, v2Config, v1Agents, v2Agents }));
  } finally {
    await server.stop();
  }
`;

function fetchConfigs(env: NodeJS.ProcessEnv): { v1Config: unknown; v2Config: unknown; v1Agents: unknown[]; v2Agents: unknown[] } {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", configProbe], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  })) as { v1Config: unknown; v2Config: unknown; v1Agents: unknown[]; v2Agents: unknown[] };
}

test("config includes default_agent with resolved OmO name", () => {
  const state = mkdtempSync(join(tmpdir(), "ocpi-config-"));
  try {
    const result = fetchConfigs({
      HOME: state,
      OCPI_AGENT: "OmO",
      OCPI_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
      OCPI_STATE_DIR: state,
      OCPI_TEST_DIRECTORY: state,
    });
    // v1 /config returns { default_agent }
    assert.deepEqual(result.v1Config, { default_agent: "OmO" });
    // v2 /api/config returns { location, data: { default_agent } }
    assert.ok(result.v2Config && typeof result.v2Config === "object" && "data" in result.v2Config);
    const v2Data = (result.v2Config as Record<string, unknown>).data;
    assert.deepEqual(v2Data, { default_agent: "OmO" });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("build agent is hidden when OmO is resolved", () => {
  const state = mkdtempSync(join(tmpdir(), "ocpi-agents-hidden-"));
  try {
    const result = fetchConfigs({
      HOME: state,
      OCPI_AGENT: "OmO",
      OCPI_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
      OCPI_STATE_DIR: state,
      OCPI_TEST_DIRECTORY: state,
    });
    const v1Agents = result.v1Agents as Array<{ name: string; hidden: boolean }>;
    assert.equal(v1Agents.length, 2, "v1: should expose [OmO, build]");
    assert.equal(v1Agents[0].name, "OmO");
    assert.equal(v1Agents[0].hidden, false, "v1: OmO should be visible");
    assert.equal(v1Agents[1].name, "build");
    assert.equal(v1Agents[1].hidden, true, "v1: build should be hidden");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("build agent is visible when no OmO name is resolved", () => {
  const state = mkdtempSync(join(tmpdir(), "ocpi-build-visible-"));
  try {
    const result = fetchConfigs({
      HOME: state,
      OCPI_AGENT: "",
      OCPI_PI_BINARY: join(root, "test/fixtures/fake-omo-endpoints.mjs"),
      OCPI_STATE_DIR: state,
      OCPI_TEST_DIRECTORY: state,
    });
    const v1Agents = result.v1Agents as Array<{ name: string; hidden: boolean }>;
    assert.equal(v1Agents.length, 1, "v1: should expose only [build]");
    assert.equal(v1Agents[0].name, "build");
    assert.equal(v1Agents[0].hidden, false, "v1: build should be visible when it's the default");
    // v1 config should have default_agent: "build"
    assert.deepEqual(result.v1Config, { default_agent: "build" });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
