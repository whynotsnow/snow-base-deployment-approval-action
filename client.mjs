import { appendFileSync } from "node:fs";

const env = process.env;
const operation = env.DEPLOYMENT_CLIENT_OPERATION;
const token = env.DEPLOYMENT_CLIENT_TOKEN;
const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const retryableNetworkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function fail(code, message) {
  console.error(`[deployment-approval-client] ${redact(code)}: ${redact(message)}`);
  process.exit(1);
}

function redact(value) {
  const text = String(value);
  return token ? text.split(token).join("[redacted]") : text;
}

function isRetryableNetworkError(error) {
  return (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    retryableNetworkCodes.has(error?.cause?.code) ||
    error instanceof TypeError
  );
}

function resolveApiBaseUrl(value) {
  const input = value?.trim() || "https://api.whynotsnow.com";
  let url;
  try {
    url = new URL(input);
  } catch {
    fail("invalid_api_base_url", "api-base-url must be a valid HTTPS URL.");
  }

  const authority = input.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu)?.[1] || "";
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const isLocalMock = url.protocol === "http:" && localhost;
  if (url.protocol !== "https:" && !isLocalMock) {
    fail("invalid_api_base_url", "api-base-url must use HTTPS; HTTP is limited to localhost.");
  }
  if (authority.includes("@") || url.username || url.password) {
    fail("invalid_api_base_url", "api-base-url must not contain URL credentials.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    fail("invalid_api_base_url", "api-base-url must be an origin without a path, query, or fragment.");
  }
  if (!url.hostname) fail("invalid_api_base_url", "api-base-url must include a hostname.");
  return url.origin;
}

const apiBaseUrl = resolveApiBaseUrl(env.DEPLOYMENT_CLIENT_API_BASE_URL);

function required(name, value) {
  const normalized = value?.trim();
  if (!normalized) fail(`missing_${name}`, `${name} is required.`);
  return normalized;
}

function optional(value) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function commonIdentity() {
  const projectSlug = required("project-slug", env.DEPLOYMENT_CLIENT_PROJECT_SLUG);
  const target = required("target", env.DEPLOYMENT_CLIENT_TARGET);
  const commitSha = required("commit-sha", env.DEPLOYMENT_CLIENT_COMMIT_SHA);
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(projectSlug))
    fail("invalid_project_slug", "project-slug is invalid.");
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(target)) fail("invalid_target", "target is invalid.");
  if (!/^[0-9a-f]{40}$/u.test(commitSha))
    fail("invalid_commit_sha", "commit-sha must be a full lowercase SHA.");
  if (target === "both")
    fail("split_deployment_required", "Each deployment must use one independent target.");
  return { projectSlug, target, commitSha };
}

function writeOutput(name, value) {
  const outputPath = env.GITHUB_OUTPUT;
  if (!outputPath || value === undefined || value === null || value === "") return;
  appendFileSync(outputPath, `${name}=${redact(value).replace(/\r?\n/gu, " ")}\n`);
}

function jsonInput(name, value) {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("object_required");
    return parsed;
  } catch {
    fail(`invalid_${name}`, `${name} must be a JSON object.`);
  }
}

async function jsonResponse(response) {
  return response.json().catch(() => null);
}

async function call(path, method = "GET", body, { retryable = method === "GET" } = {}) {
  if (!token) fail("missing_token", "token is required.");
  const attempts = retryable ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(`${apiBaseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (attempt + 1 === attempts || !isRetryableNetworkError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    const payload = await jsonResponse(response);
    if (retryableStatuses.has(response.status) && attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    if (!response.ok || payload?.ok === false)
      fail(payload?.error?.code || `http_${response.status}`, "Deployment approval API request failed.");
    if (payload?.ok !== true)
      fail("invalid_api_response", "Deployment approval API response is invalid.");
    return payload.data;
  }
  fail("client_error", "Deployment approval API request could not be completed.");
}

function emitRecord(data) {
  const record = data?.approval || data?.candidate || data?.run || data?.artifact || data;
  writeOutput("approval-id", data?.approvalId || data?.approval?.id || record?.approvalId);
  writeOutput(
    "artifact-id",
    data?.artifactId ||
      data?.approval?.artifactId ||
      data?.approval?.artifact?.id ||
      data?.artifact?.id,
  );
  writeOutput(
    "artifact-digest",
    data?.artifactDigest ||
      data?.approval?.artifactDigest ||
      data?.approval?.artifact?.digest ||
      data?.artifact?.digest,
  );
  writeOutput(
    "request-id",
    data?.requestId || data?.candidateRunId || record?.requestId || record?.id,
  );
  writeOutput("status", data?.status || record?.status);
  writeOutput("reused", data?.reused);
}

async function main() {
  if (!operation) fail("missing_operation", "operation is required.");
  if (operation === "contract") {
    const params = new URLSearchParams();
    if (optional(env.DEPLOYMENT_CLIENT_PROJECT_SLUG))
      params.set("projectSlug", optional(env.DEPLOYMENT_CLIENT_PROJECT_SLUG));
    if (optional(env.DEPLOYMENT_CLIENT_TARGET))
      params.set("target", optional(env.DEPLOYMENT_CLIENT_TARGET));
    const data = await call(`/api/v1/deployments/contracts${params.size ? `?${params}` : ""}`);
    writeOutput("status", "available");
    writeOutput("protocol-version", data.recommendedProtocolVersion);
    return;
  }

  const identity = commonIdentity();
  let data;
  if (operation === "register-artifact") {
    data = await call("/api/v1/deployments/artifacts", "POST", {
      ...identity,
      role: optional(env.DEPLOYMENT_CLIENT_ARTIFACT_ROLE) || "candidate",
      artifactType: required("artifact-type", env.DEPLOYMENT_CLIENT_ARTIFACT_TYPE),
      digest: required("artifact-digest", env.DEPLOYMENT_CLIENT_ARTIFACT_DIGEST),
      storageProvider: required("storage-provider", env.DEPLOYMENT_CLIENT_STORAGE_PROVIDER),
      storageKey: optional(env.DEPLOYMENT_CLIENT_STORAGE_KEY),
      requestSource: optional(env.DEPLOYMENT_CLIENT_REQUEST_SOURCE),
      requestUrl: optional(env.DEPLOYMENT_CLIENT_REQUEST_URL),
      buildStatus: optional(env.DEPLOYMENT_CLIENT_BUILD_STATUS) || "succeeded",
      validationStatus: optional(env.DEPLOYMENT_CLIENT_VALIDATION_STATUS) || "succeeded",
      metadata: jsonInput("metadata-json", env.DEPLOYMENT_CLIENT_METADATA_JSON),
      expiresAt: optional(env.DEPLOYMENT_CLIENT_EXPIRES_AT),
    });
  } else if (operation === "request-approval") {
    const idempotencyKey = optional(env.DEPLOYMENT_CLIENT_IDEMPOTENCY_KEY);
    data = await call("/api/v1/deployments/request", "POST", {
      ...identity,
      changeSummary: optional(env.DEPLOYMENT_CLIENT_CHANGE_SUMMARY),
      validationSummary: optional(env.DEPLOYMENT_CLIENT_VALIDATION_SUMMARY),
      requestSource: optional(env.DEPLOYMENT_CLIENT_REQUEST_SOURCE),
      requestUrl: optional(env.DEPLOYMENT_CLIENT_REQUEST_URL),
      idempotencyKey,
      artifactId: optional(env.DEPLOYMENT_CLIENT_ARTIFACT_ID),
      artifactDigest: optional(env.DEPLOYMENT_CLIENT_ARTIFACT_DIGEST),
    });
  } else if (operation === "get-approval") {
    data = await call(
      `/api/v1/deployments/requests/${required("request-id", env.DEPLOYMENT_CLIENT_REQUEST_ID)}`,
    );
  } else if (operation === "wait-approval") {
    const requestId = required("request-id", env.DEPLOYMENT_CLIENT_REQUEST_ID);
    const waitSeconds = Number.parseInt(env.DEPLOYMENT_CLIENT_WAIT_SECONDS || "900", 10);
    const pollSeconds = Number.parseInt(env.DEPLOYMENT_CLIENT_POLL_SECONDS || "15", 10);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 1 || waitSeconds > 86400)
      fail("invalid_wait_seconds", "wait-seconds must be between 1 and 86400.");
    if (!Number.isFinite(pollSeconds) || pollSeconds < 1 || pollSeconds > 300)
      fail("invalid_poll_seconds", "poll-seconds must be between 1 and 300.");
    const deadline = Date.now() + waitSeconds * 1000;
    while (true) {
      data = await call(`/api/v1/deployments/requests/${requestId}`);
      const approval = data;
      if (
        approval.projectSlug !== identity.projectSlug ||
        approval.target !== identity.target ||
        approval.commitSha !== identity.commitSha
      ) {
        fail(
          "approval_identity_mismatch",
          "Approval identity does not match project, target, and commit.",
        );
      }
      if (
        env.DEPLOYMENT_CLIENT_ARTIFACT_ID &&
        approval.artifactId !== env.DEPLOYMENT_CLIENT_ARTIFACT_ID
      )
        fail("approval_artifact_mismatch", "Approval artifact id does not match.");
      if (
        env.DEPLOYMENT_CLIENT_ARTIFACT_DIGEST &&
        approval.artifactDigest !== env.DEPLOYMENT_CLIENT_ARTIFACT_DIGEST
      )
        fail("approval_digest_mismatch", "Approval artifact digest does not match.");
      if (approval.status === "approved") break;
      if (["rejected", "expired", "invalidated"].includes(approval.status))
        fail(`approval_${approval.status}`, `Approval is ${approval.status}.`);
      if (Date.now() >= deadline)
        fail("approval_wait_timeout", "Approval was not granted before the wait window expired.");
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  } else if (operation === "consume-approval") {
    data = await call("/api/v1/deployments/verify", "POST", {
      ...identity,
      approvalId: required("approval-id", env.DEPLOYMENT_CLIENT_APPROVAL_ID),
      artifactId: optional(env.DEPLOYMENT_CLIENT_ARTIFACT_ID),
      artifactDigest: optional(env.DEPLOYMENT_CLIENT_ARTIFACT_DIGEST),
    });
  } else if (operation === "candidate-callback") {
    data = await call("/api/v1/deployments/candidate-runs", "POST", {
      ...identity,
      requestId: required("request-id", env.DEPLOYMENT_CLIENT_REQUEST_ID),
      githubRunId: required("github-run-id", env.DEPLOYMENT_CLIENT_GITHUB_RUN_ID),
      githubRunUrl: optional(env.DEPLOYMENT_CLIENT_GITHUB_RUN_URL),
      status: required("callback-status", env.DEPLOYMENT_CLIENT_CALLBACK_STATUS),
      conclusion: optional(env.DEPLOYMENT_CLIENT_CONCLUSION),
      phase: optional(env.DEPLOYMENT_CLIENT_PHASE),
      errorCode: optional(env.DEPLOYMENT_CLIENT_ERROR_CODE),
      artifactId: optional(env.DEPLOYMENT_CLIENT_ARTIFACT_ID),
      artifactDigest: optional(env.DEPLOYMENT_CLIENT_ARTIFACT_DIGEST),
    }, { retryable: true });
  } else if (operation === "deployment-callback") {
    data = await call("/api/v1/deployments/runs/update", "POST", {
      ...identity,
      requestId: required("request-id", env.DEPLOYMENT_CLIENT_REQUEST_ID),
      artifactId: required("artifact-id", env.DEPLOYMENT_CLIENT_ARTIFACT_ID),
      artifactDigest: required("artifact-digest", env.DEPLOYMENT_CLIENT_ARTIFACT_DIGEST),
      githubRunId: required("github-run-id", env.DEPLOYMENT_CLIENT_GITHUB_RUN_ID),
      githubRunUrl: optional(env.DEPLOYMENT_CLIENT_GITHUB_RUN_URL),
      status: required("callback-status", env.DEPLOYMENT_CLIENT_CALLBACK_STATUS),
      conclusion: optional(env.DEPLOYMENT_CLIENT_CONCLUSION),
      phase: optional(env.DEPLOYMENT_CLIENT_PHASE),
      errorCode: optional(env.DEPLOYMENT_CLIENT_ERROR_CODE),
      createIfMissing: env.DEPLOYMENT_CLIENT_CREATE_IF_MISSING === "true",
    }, { retryable: true });
  } else {
    fail("unsupported_operation", `Unsupported operation: ${operation}.`);
  }
  emitRecord(data);
}

main().catch((error) =>
  fail("client_error", error instanceof Error ? error.message : "Unexpected client error."),
);
