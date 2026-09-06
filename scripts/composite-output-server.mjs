import { createServer } from "node:http";

const digest = `sha256:${"b".repeat(64)}`;
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/v1/deployments/artifacts") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: { code: "not_found" } }));
    return;
  }
  response.writeHead(201, { "content-type": "application/json" });
  response.end(JSON.stringify({
    ok: true,
    data: {
      artifact: { id: "artifact_fixture", digest },
      requestId: "request_fixture",
      status: "registered",
      reused: false,
    },
  }));
});

server.listen(4123, "127.0.0.1", () => console.log("mock deployment API ready"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
