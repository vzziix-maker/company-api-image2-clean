import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockPort = Number(process.env.MOCK_IMAGE_API_PORT || 19868);
const appPort = Number(process.env.MOCK_APP_PORT || 19869);
const appDataDir = await mkdtemp(join(tmpdir(), "image2-params-"));
const expected = {
  format: "jpeg",
  width: 1024,
  height: 688,
};
let capturedPayload = null;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function jpegBuffer(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x11,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function readPng(buffer) {
  if (buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return {
    format: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readJpeg(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xc3;
    if (isStartOfFrame) {
      return {
        format: "jpeg",
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += 2 + length;
  }

  return null;
}

function readImage(buffer) {
  return readPng(buffer) || readJpeg(buffer) || { format: "unknown", width: 0, height: 0 };
}

const mock = createServer(async (request, response) => {
  const body = await readBody(request);
  capturedPayload = JSON.parse(body.toString("utf8") || "{}");

  if (request.url === "/v1/images/generations") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: jpegBuffer(expected.width, expected.height).toString("base64") }],
    }));
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: { message: "not found" } }));
});

await new Promise((resolve) => mock.listen(mockPort, resolve));

const child = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(appPort),
    IMAGE_API_BASE_URL: `http://localhost:${mockPort}/v1`,
    IMAGE_API_KEY: "test-key",
    APP_DATA_DIR: appDataDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`localhost:${appPort}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", (code) => reject(new Error(`server exited early: ${code}`)));
  });

  const response = await fetch(`http://localhost:${appPort}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sizeMode: "ratio",
      model: "gpt-image-2",
      prompt: "A simple centered green triangle on a plain white background",
      size: "1024x1024",
      aspectRatio: "3:2",
      resolution: "1K",
      quality: "low",
      outputFormat: "jpeg",
      background: "auto",
      count: 1,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const first = data.images?.[0];
  const buffer = Buffer.from(first?.b64_json || "", "base64");
  const actual = readImage(buffer);
  const ok =
    actual.format === expected.format &&
    actual.width === expected.width &&
    actual.height === expected.height &&
    capturedPayload?.size === "1024x688" &&
    capturedPayload?.output_format === "jpeg";

  console.log(JSON.stringify({
    ok,
    expected,
    actual,
    imageCount: data.images?.length || 0,
    upstreamPayload: capturedPayload,
    historyId: data.historyId,
  }, null, 2));

  if (!ok) process.exit(1);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => mock.close(resolve));
  await rm(appDataDir, { recursive: true, force: true });
}
