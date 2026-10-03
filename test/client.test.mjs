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

test("register-artifact maps the immutable artifact identity", async () => {
  let body;
  const server = await startMockServer((request, res) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      body = JSON.parse(raw);
      response({ ok: true, data: { artifact: { id: "artifact_1", digest: body.digest } } })(
        request,
        res,
      );
    });
  });
  try {
    const result = await runClient(server.baseUrl, {
      operation: "register-artifact",
      "project-slug": "blog",
      target: "site",
      "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      "artifact-type": "vercel-output",
      "artifact-digest": `sha256:${"b".repeat(64)}`,
      "storage-provider": "r2",
      "storage-key": "candidate/site.tar.gz",
      "artifact-role": "candidate",
      "metadata-json": '{"size":12}',
    });
    assert.equal(result.code, 0);
    assert.equal(body.projectSlug, "blog");
    assert.equal(body.storageProvider, "r2");
    assert.equal(body.storageKey, "candidate/site.tar.gz");
    assert.equal(body.metadata.size, 12);
    assert.match(result.output, /artifact-id=artifact_1\n/u);
  } finally {
    await server.close();
  }
});

test("get-approval reads the requested record", async () => {
  let requestUrl;
  const server = await startMockServer((request, res) => {
    requestUrl = request.url;
    response({ ok: true, data: { id: "request_1", status: "pending" } })(request, res);
  });
  try {
    const result = await runClient(server.baseUrl, {
      operation: "get-approval",
      "project-slug": "blog",
      target: "site",
      "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      "request-id": "request_1",
    });
    assert.equal(result.code, 0);
    assert.equal(requestUrl, "/api/v1/deployments/requests/request_1");
    assert.match(result.output, /status=pending\n/u);
  } finally {
    await server.close();
  }
});

test("wait-approval accepts only the exact identity and returns terminal rejections", async () => {
  const mismatchServer = await startMockServer((request, res) => {
    response({
      ok: true,
      data: {
        projectSlug: "other-project",
        target: "site",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        status: "approved",
      },
    })(request, res);
  });
  try {
    const mismatch = await runClient(mismatchServer.baseUrl, {
      operation: "wait-approval",
      "project-slug": "blog",
      target: "site",
      "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      "request-id": "request_1",
      "wait-seconds": "1",
      "poll-seconds": "1",
    });
    assert.notEqual(mismatch.code, 0);
    assert.match(mismatch.stderr, /approval_identity_mismatch/u);
  } finally {
    await mismatchServer.close();
  }

  const rejectedServer = await startMockServer((request, res) => {
    response({
      ok: true,
      data: {
        projectSlug: "blog",
        target: "site",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        status: "rejected",
      },
    })(request, res);
  });
  try {
    const rejected = await runClient(rejectedServer.baseUrl, {
      operation: "wait-approval",
      "project-slug": "blog",
      target: "site",
      "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      "request-id": "request_1",
      "wait-seconds": "1",
      "poll-seconds": "1",
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /approval_rejected/u);
  } finally {
    await rejectedServer.close();
  }
});

test("consume-approval maps the exact approval and artifact identity", async () => {
  let body;
  const server = await startMockServer((request, res) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      body = JSON.parse(raw);
      response({ ok: true, data: { approvalId: "approval_1", status: "used" } })(request, res);
    });
  });
  try {
    const result = await runClient(server.baseUrl, {
      operation: "consume-approval",
      "project-slug": "blog",
      target: "site",
      "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      "approval-id": "approval_1",
      "artifact-id": "artifact_1",
      "artifact-digest": `sha256:${"c".repeat(64)}`,
    });
    assert.equal(result.code, 0);
    assert.equal(body.approvalId, "approval_1");
    assert.equal(body.artifactId, "artifact_1");
    assert.equal(body.artifactDigest, `sha256:${"c".repeat(64)}`);
    assert.match(result.output, /status=used\n/u);
  } finally {
    await server.close();
  }
});

test("candidate and deployment callbacks map their stable run identities", async () => {
  const callbackBodies = [];
  const server = await startMockServer((request, res) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      callbackBodies.push({ url: request.url, body: JSON.parse(raw) });
      response({ ok: true, data: { status: "completed" } })(request, res);
    });
  });
  try {
    const identity = {
      "project-slug": "blog",
      target: "site",
      "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      "request-id": "request_1",
      "github-run-id": "42",
      "github-run-url": "https://github.com/whynotsnow/blog/actions/runs/42",
      "callback-status": "completed",
      conclusion: "success",
      phase: "deploy",
    };
    const candidate = await runClient(server.baseUrl, {
      operation: "candidate-callback",
      ...identity,
      "artifact-id": "artifact_1",
      "artifact-digest": `sha256:${"d".repeat(64)}`,
    });
    const deployment = await runClient(server.baseUrl, {
      operation: "deployment-callback",
      ...identity,
      "artifact-id": "artifact_2",
      "artifact-digest": `sha256:${"e".repeat(64)}`,
      "create-if-missing": "true",
    });
    assert.equal(candidate.code, 0);
    assert.equal(deployment.code, 0);
    assert.equal(callbackBodies[0].url, "/api/v1/deployments/candidate-runs");
    assert.equal(callbackBodies[0].body.githubRunId, "42");
    assert.equal(callbackBodies[0].body.artifactId, "artifact_1");
    assert.equal(callbackBodies[1].url, "/api/v1/deployments/runs/update");
    assert.equal(callbackBodies[1].body.artifactId, "artifact_2");
    assert.equal(callbackBodies[1].body.createIfMissing, true);
  } finally {
    await server.close();
  }
});

test("candidate and deployment callbacks retry with the same stable identity", async () => {
  const observed = new Map();
  const server = await startMockServer((request, res) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const key = request.url;
      const requests = observed.get(key) ?? [];
      requests.push(raw);
      observed.set(key, requests);
      if (requests.length === 1)
        return response({ ok: false, error: { code: "temporary" } }, 503)(request, res);
      response({ ok: true, data: { status: "completed" } })(request, res);
    });
  });
  try {
    const common = {
      "project-slug": "blog",
      target: "site",
      "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      "request-id": "request_1",
      "github-run-id": "42",
      "callback-status": "completed",
      conclusion: "success",
    };
    for (const [operation, values, endpoint] of [
      [
        "candidate-callback",
        { "artifact-id": "artifact_1", "artifact-digest": `sha256:${"a".repeat(64)}` },
        "/api/v1/deployments/candidate-runs",
      ],
      [
        "deployment-callback",
        { "artifact-id": "artifact_2", "artifact-digest": `sha256:${"b".repeat(64)}` },
        "/api/v1/deployments/runs/update",
      ],
    ]) {
      const result = await runClient(server.baseUrl, { operation, ...common, ...values });
      assert.equal(result.code, 0, operation);
      const attempts = observed.get(endpoint);
      assert.equal(attempts.length, 2, operation);
      assert.equal(attempts[0], attempts[1], operation);
    }
  } finally {
    await server.close();
  }
});

test("api-base-url rejects insecure public and credential-bearing URLs", async () => {
  for (const url of [
    "http://api.example.com",
    "https://user:password@api.example.com",
    "https://@api.example.com",
    "https://api.example.com/path",
    "https://api.example.com/?debug=1",
    "https://api.example.com/#fragment",
    "http://localhost.example.com",
  ]) {
    const result = await runClient(url, { operation: "contract" });
    assert.notEqual(result.code, 0, url);
    assert.match(result.stderr, /invalid_api_base_url/u, url);
  }
});

test("localhost mock HTTP is permitted and API error text cannot reveal the token", async () => {
  const server = await startMockServer((request, res) => {
    response({
      ok: false,
      error: { code: "test-token", message: "The credential test-token is invalid." },
    }, 403)(request, res);
  });
  try {
    const result = await runClient(server.baseUrl, { operation: "contract" });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /\[redacted\]/u);
    assert.doesNotMatch(result.stdout + result.stderr + result.output, /test-token/u);
  } finally {
    await server.close();
  }
});

test("stateful POST retries require the endpoint's idempotency contract", async () => {
  for (const [operation, values] of [
    [
      "request-approval",
      {
        "project-slug": "blog",
        target: "site",
        "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      },
    ],
    [
      "register-artifact",
      {
        "project-slug": "blog",
        target: "site",
        "commit-sha": "0123456789abcdef0123456789abcdef01234567",
        "artifact-type": "vercel-output",
        "artifact-digest": `sha256:${"f".repeat(64)}`,
        "storage-provider": "r2",
      },
    ],
    [
      "consume-approval",
      {
        "project-slug": "blog",
        target: "site",
        "commit-sha": "0123456789abcdef0123456789abcdef01234567",
        "approval-id": "approval_1",
      },
    ],
  ]) {
    let calls = 0;
    const server = await startMockServer((request, res) => {
      calls += 1;
      response({ ok: false, error: { code: "temporary" } }, 503)(request, res);
    });
    try {
      const result = await runClient(server.baseUrl, { operation, ...values });
      assert.notEqual(result.code, 0, operation);
      assert.equal(calls, 1, operation);
    } finally {
      await server.close();
    }
  }
});

test("request-approval does not retry even when an idempotency key is supplied", async () => {
  let calls = 0;
  const keys = [];
  const server = await startMockServer((request, res) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      calls += 1;
      keys.push(JSON.parse(raw).idempotencyKey);
      response({ ok: false, error: { code: "temporary" } }, 503)(request, res);
    });
  });
  try {
    const result = await runClient(server.baseUrl, {
      operation: "request-approval",
      "project-slug": "blog",
      target: "site",
      "commit-sha": "0123456789abcdef0123456789abcdef01234567",
      "idempotency-key": "stable-request-key",
    });
    assert.notEqual(result.code, 0);
    assert.equal(calls, 1);
    assert.deepEqual(keys, ["stable-request-key"]);
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

test("composite metadata maps every client output", async () => {
  const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(action, /id: client\n/u);
  for (const name of [
    "approval-id",
    "artifact-id",
    "artifact-digest",
    "request-id",
    "status",
    "reused",
    "protocol-version",
  ]) {
    assert.ok(
      action.includes(`value: \${{ steps.client.outputs.${name} }}`),
      `missing composite output mapping for ${name}`,
    );
  }
});
