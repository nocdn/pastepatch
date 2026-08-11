import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer } from "../lib/mcp-server.js";
import { viewImageFile } from "../lib/view-image.js";

const tempDirectories = [];

test.after(async () => {
  await Promise.all(tempDirectories.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pastepatch-img-"));
  tempDirectories.push(root);
  return root;
}

/** Tiny solid red PNG via sharp. */
async function writePng(filePath, width, height, color = { r: 220, g: 40, b: 40, alpha: 1 }) {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color,
    },
  })
    .png()
    .toBuffer();
  await writeFile(filePath, buffer);
  return buffer;
}

test("viewImageFile returns image content and metadata for a small PNG", async () => {
  const root = await tempProject();
  await writePng(path.join(root, "dot.png"), 32, 24);

  const result = await viewImageFile({ path: "dot.png", root });
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");
  assert.ok(result.content[1].data.length > 20);
  assert.match(result.content[0].text, /format:/i);
  assert.match(result.content[0].text, /resized: no/i);
  assert.equal(result.meta.resized, false);
  assert.equal(result.meta.width, 32);
  assert.equal(result.meta.height, 24);

  // Base64 decodes to a valid image
  const decoded = Buffer.from(result.content[1].data, "base64");
  const meta = await sharp(decoded).metadata();
  assert.equal(meta.width, 32);
  assert.equal(meta.height, 24);
});

test("viewImageFile resizes large images under max_dimension", async () => {
  const root = await tempProject();
  await writePng(path.join(root, "big.png"), 2000, 1000);

  const result = await viewImageFile({ path: "big.png", root, maxDimension: 512 });
  assert.equal(result.meta.resized, true);
  assert.ok(result.meta.width <= 512);
  assert.ok(result.meta.height <= 512);
  assert.match(result.content[0].text, /resized: yes/i);
  assert.equal(result.content[1].type, "image");
  assert.ok(["image/jpeg", "image/png"].includes(result.content[1].mimeType));

  const decoded = Buffer.from(result.content[1].data, "base64");
  const meta = await sharp(decoded).metadata();
  assert.ok(meta.width <= 512);
  assert.ok(meta.height <= 512);
});

test("viewImageFile rejects non-images and sandbox escapes", async () => {
  const root = await tempProject();
  await writeFile(path.join(root, "notes.txt"), "not an image\n", "utf8");

  await assert.rejects(() => viewImageFile({ path: "notes.txt", root }), /supported image|corrupt/i);
  await assert.rejects(() => viewImageFile({ path: "../secret.png", root }), /\.\./);
});

test("MCP view_image tool returns type:image content", async () => {
  const root = await tempProject();
  await writePng(path.join(root, "shot.png"), 64, 48);

  const port = await freePort();
  const logs = [];
  const server = await startMcpHttpServer({
    root,
    port,
    host: "127.0.0.1",
    version: "test",
    logger: async (line) => {
      logs.push(line);
    },
  });

  try {
    const client = new Client({ name: "pastepatch-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "view_image"));

    const result = await client.callTool({
      name: "view_image",
      arguments: { path: "shot.png" },
    });
    assert.equal(result.isError, undefined);

    const parts = result.content || [];
    const text = parts.find((p) => p.type === "text");
    const image = parts.find((p) => p.type === "image");
    assert.ok(text, "expected text metadata block");
    assert.ok(image, "expected image content block");
    assert.match(text.text, /Image: shot\.png/);
    assert.match(text.text, /mimeType:/);
    assert.ok(image.data && image.mimeType);
    assert.ok(image.data.length > 20);

    const viewLog = logs.find((line) => line.includes("view_image") && line.includes("✓ ok"));
    assert.ok(viewLog, `expected view_image log, got: ${logs.join(" | ")}`);
    assert.match(viewLog, /64×48/);
    assert.match(viewLog, /png/i);
    assert.match(viewLog, /image \d+(\.\d+)?\s*(B|KB|MB)/i);
    assert.match(viewLog, /sent \d+(\.\d+)?\s*(B|KB|MB) base64/i);
    assert.match(viewLog, /resized no/i);
    assert.match(viewLog, /reencoded no/i);

    await client.close();
  } finally {
    await server.close();
  }
});

async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}
