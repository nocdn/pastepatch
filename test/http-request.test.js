import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { httpRequest, isLoopbackUrl, parseHttpUrl } from "../lib/http-request.js";

test("parseHttpUrl locks to loopback by default", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8081/v1"), true);
  assert.equal(isLoopbackUrl("http://localhost/"), true);
  assert.equal(isLoopbackUrl("https://example.com/"), false);
  assert.throws(() => parseHttpUrl("https://example.com/api"), /loopback/i);
  assert.ok(parseHttpUrl("https://example.com/api", { allowPublic: true }));
  assert.throws(() => parseHttpUrl("file:///etc/passwd"), /http and https/i);
});

test("http_request GET/POST against a loopback server", async () => {
  const server = await listen((req, res) => {
    if (req.method === "POST" && req.url === "/echo") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echoed: JSON.parse(body) }));
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  try {
    const get = await httpRequest({ url: `http://127.0.0.1:${server.port}/health` });
    assert.equal(get.status, 200);
    assert.equal(get.json.ok, true);
    assert.equal(get.json.path, "/health");

    const post = await httpRequest({
      method: "POST",
      url: `http://127.0.0.1:${server.port}/echo`,
      json: { n: 3 },
    });
    assert.equal(post.status, 200);
    assert.deepEqual(post.json, { echoed: { n: 3 } });
  } finally {
    await server.close();
  }
});

test("http_request refuses public hosts unless allow_public", async () => {
  await assert.rejects(
    () => httpRequest({ url: "https://example.com/" }),
    /loopback/i,
  );
});

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
    server.on("error", reject);
  });
}
