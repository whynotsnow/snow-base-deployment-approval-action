import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function startMockServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function runClient(serverUrl, values) {
  const directory = await mkdtemp(join(tmpdir(), "deployment-approval-action-"));
  const outputPath = join(directory, "github-output");
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("client.mjs", root))], {
        cwd: fileURLToPath(new URL("../", root)),
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          DEPLOYMENT_CLIENT_API_BASE_URL: serverUrl,
          DEPLOYMENT_CLIENT_TOKEN: "test-token",
          ...Object.fromEntries(Object.entries(values).map(([key, value]) => [
            `DEPLOYMENT_CLIENT_${key.replaceAll("-", "_").toUpperCase()}`,
            value,
          ])),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    let output = "";
    try {
      output = await readFile(outputPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { ...result, output };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function response(body, status = 200) {
  return (request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

test("contract operation returns the advertised protocol output", async () => {
  let authorization;
  const server = await startMockServer((request, res) => {
    authorization = request.headers.authorization;
    assert.equal(request.url, "/api/v1/deployments/contracts?projectSlug=blog&target=site");
    response({ ok: true, data: { recommendedProtocolVersion: "v2" } }, 200)(request, res);
  });
  try {
    const result = await runClient(server.baseUrl, {
      operation: "contract",
      "project-slug": "blog",
      target: "site",
    });
    assert.equal(result.code, 0);
    assert.equal(authorization, "Bearer test-token");
    assert.match(result.output, /status=available\n/u);
    assert.match(result.output, /protocol-version=v2\n/u);
    assert.doesNotMatch(result.stdout + result.stderr + result.output, /test-token/u);
  } finally {
    await server.close();
  }
});

test("request-approval maps identity and artifact fields and outputs", async () => {
  let body;
  const server = await startMockServer((request, res) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      body = JSON.parse(raw);
      response({
        ok: true,
        data: {
          approvalId: "approval_1",
          artifactId: "artifact_1",
          artifactDigest: `sha256:${"a".repeat(64)}`,
          requestId: "request_1",
          status: "pending",
          reused: false,
        },
      })(request, res);
    });
  });
  try {
    const result = await runClient(server.baseUrl, {
      operation: "request-approval",
      "project-slug": "blog",
      target: "site",
      "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      "artifact-id": "artifact_1",
      "artifact-digest": `sha256:${"a".repeat(64)}`,
      "change-summary": "release",
      "idempotency-key": "request-key",
    });
    assert.equal(result.code, 0);
    assert.equal(body.projectSlug, "blog");
    assert.equal(body.target, "site");
    assert.equal(body.commitSha, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(body.artifactId, "artifact_1");
    assert.equal(body.idempotencyKey, "request-key");
    assert.match(result.output, /approval-id=approval_1\n/u);
    assert.match(result.output, /request-id=request_1\n/u);
    assert.match(result.output, /reused=false\n/u);
  } finally {
    await server.close();
  }
});

test("transient HTTP 5xx receives bounded retry", async () => {
  let calls = 0;
  const server = await startMockServer((request, res) => {
    calls += 1;
    if (calls === 1) return response({ ok: false, error: { code: "temporary" } }, 503)(request, res);
    return response({ ok: true, data: { recommendedProtocolVersion: "v2" } })(request, res);
  });
  try {
    const result = await runClient(server.baseUrl, { operation: "contract" });
    assert.equal(result.code, 0);
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test("invalid combined target fails closed before a request", async () => {
  const result = await runClient("http://127.0.0.1:1", {
    operation: "consume-approval",
    "project-slug": "blog",
    target: "both",
    "commit-sha": "0123456789abcdef0123456789abcdef01234567",
    "approval-id": "approval_1",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /split_deployment_required/u);
});
