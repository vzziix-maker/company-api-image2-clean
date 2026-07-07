import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockPort = Number(process.env.MOCK_IMAGE_API_PORT || 19878);
const appPort = Number(process.env.MOCK_APP_PORT || 19879);
const capturedRequests = [];
const appDataDir = await mkdtemp(join(tmpdir(), "image2-payload-routing-"));

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=([^;]+)/i.exec(contentType || "")?.[1];
  if (!boundary) return {};

  const raw = buffer.toString("latin1");
  const fields = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1];
    if (!name) continue;

    const valueStart = part.indexOf("\r\n\r\n");
    if (valueStart === -1) continue;

    const value = part.slice(valueStart + 4).replace(/\r\n$/, "");
    if (/filename="/.test(part)) {
      fields[name] = [...(fields[name] || []), { file: true, size: Buffer.from(value, "latin1").length }];
    } else {
      fields[name] = value;
    }
  }
  return fields;
}

function imageResponse(count, prefix) {
  return JSON.stringify({
    created: Math.floor(Date.now() / 1000),
    data: Array.from({ length: count }, (_, index) => ({
      b64_json: Buffer.from(`${prefix}-${index + 1}`).toString("base64"),
    })),
    usage: { total_tokens: count },
  });
}

function pngBuffer(width, height) {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt8(0x89, 0);
  buffer.write("PNG\r\n\x1a\n", 1, "latin1");
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(8, 24);
  buffer.writeUInt8(6, 25);
  buffer.writeUInt8(0, 26);
  buffer.writeUInt8(0, 27);
  buffer.writeUInt8(0, 28);
  return buffer;
}

const mock = createServer(async (request, response) => {
  const body = await readBody(request);
  const contentType = request.headers["content-type"] || "";
  const entry = {
    method: request.method,
    url: request.url,
    contentType,
    body: {},
  };

  if (contentType.includes("application/json")) {
    entry.body = JSON.parse(body.toString("utf8") || "{}");
  } else if (contentType.includes("multipart/form-data")) {
    entry.body = parseMultipart(body, contentType);
  }
  capturedRequests.push(entry);

  if (request.url === "/v1/images/generations") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(imageResponse(Number(entry.body.n || 1), "generate"));
    return;
  }

  if (request.url === "/v1/images/edits") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(imageResponse(Number(entry.body.n || 1), "edit"));
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
    HISTORY_LIMIT: "50",
    ALLOW_LOCAL_PROVIDER_URLS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const createdHistoryIds = [];

async function waitForServer() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${appPort}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", (code) => reject(new Error(`server exited early: ${code}`)));
  });
}

async function deleteCreatedHistory() {
  await Promise.all(
    createdHistoryIds.map((id) =>
      fetch(`http://127.0.0.1:${appPort}/api/history/${id}`, { method: "DELETE" }).catch(() => {}),
    ),
  );
}

try {
  await waitForServer();

  const generateResponse = await fetch(`http://127.0.0.1:${appPort}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "generate",
      model: "gpt-image-2",
      prompt: "mock generate",
      sizeMode: "ratio",
      aspectRatio: "16:9",
      resolution: "2K",
      quality: "high",
      outputFormat: "jpeg",
      background: "auto",
      count: 3,
    }),
  });
  const generateData = await generateResponse.json();
  if (generateData.historyId) createdHistoryIds.push(generateData.historyId);

  const editForm = new FormData();
  Object.entries({
    model: "gpt-image-2",
    prompt: "mock edit",
    sizeMode: "ratio",
    aspectRatio: "9:16",
    resolution: "2K",
    quality: "medium",
    outputFormat: "png",
    background: "auto",
    count: "2",
  }).forEach(([key, value]) => editForm.set(key, value));
  editForm.append("image[]", new File([pngBuffer(900, 1600)], "source-a.png", { type: "image/png" }));
  editForm.append("image[]", new File([pngBuffer(1200, 800)], "source-b.png", { type: "image/png" }));

  const editResponse = await fetch(`http://127.0.0.1:${appPort}/api/edit`, {
    method: "POST",
    body: editForm,
  });
  const editData = await editResponse.json();
  if (editData.historyId) createdHistoryIds.push(editData.historyId);

  const smartRatioForm = new FormData();
  Object.entries({
    model: "gpt-image-2",
    prompt: "mock smart ratio edit",
    sizeMode: "ratio",
    aspectRatio: "smart",
    resolution: "2K",
    quality: "medium",
    outputFormat: "png",
    background: "auto",
    count: "1",
  }).forEach(([key, value]) => smartRatioForm.set(key, value));
  smartRatioForm.append("image[]", new File([pngBuffer(1200, 800)], "smart-ratio-source.png", { type: "image/png" }));
  const smartRatioResponse = await fetch(`http://127.0.0.1:${appPort}/api/edit`, {
    method: "POST",
    body: smartRatioForm,
  });
  const smartRatioData = await smartRatioResponse.json();
  if (smartRatioData.historyId) createdHistoryIds.push(smartRatioData.historyId);

  const smartPresetForm = new FormData();
  Object.entries({
    model: "gpt-image-2",
    prompt: "mock smart preset edit",
    sizeMode: "preset",
    size: "smart",
    quality: "medium",
    outputFormat: "png",
    background: "auto",
    count: "1",
  }).forEach(([key, value]) => smartPresetForm.set(key, value));
  smartPresetForm.append("image[]", new File([pngBuffer(1234, 987)], "smart-preset-source.png", { type: "image/png" }));
  const smartPresetResponse = await fetch(`http://127.0.0.1:${appPort}/api/edit`, {
    method: "POST",
    body: smartPresetForm,
  });
  const smartPresetData = await smartPresetResponse.json();
  if (smartPresetData.historyId) createdHistoryIds.push(smartPresetData.historyId);

  const historyData = await (await fetch(`http://127.0.0.1:${appPort}/api/history`)).json();
  const historyById = Object.fromEntries(
    createdHistoryIds.map((id) => {
      const item = historyData.items.find((entry) => entry.id === id);
      return [
        id,
        item && {
          mode: item.mode,
          count: item.config?.count,
          requestN: item.requestPayload?.n,
          images: item.images?.length || 0,
          sourceImages: item.source?.images?.length || 0,
          outputFormat: item.config?.outputFormat,
          quality: item.config?.quality,
          background: item.config?.background,
          resolvedSize: item.config?.resolvedSize,
          sizeMode: item.config?.sizeMode,
          size: item.config?.size,
          aspectRatio: item.config?.aspectRatio,
        },
      ];
    }),
  );

  const generatePayload = capturedRequests.find((entry) => entry.url === "/v1/images/generations")?.body;
  const editPayloads = capturedRequests.filter((entry) => entry.url === "/v1/images/edits").map((entry) => entry.body);
  const editPayload = editPayloads[0];
  const smartRatioPayload = editPayloads[1];
  const smartPresetPayload = editPayloads[2];
  const ok =
    generateResponse.status === 200 &&
    generateData.images?.length === 3 &&
    generatePayload?.n === 3 &&
    generatePayload?.size === "2048x1152" &&
    generatePayload?.quality === "high" &&
    generatePayload?.output_format === "jpeg" &&
    !("background" in generatePayload) &&
    editResponse.status === 200 &&
    editData.images?.length === 2 &&
    editPayload?.n === "2" &&
    editPayload?.size === "1152x2048" &&
    editPayload?.quality === "medium" &&
    editPayload?.output_format === "png" &&
    (editPayload?.["image[]"] || []).length === 2 &&
    smartRatioResponse.status === 200 &&
    smartRatioPayload?.size === "2048x1360" &&
    historyById[smartRatioData.historyId]?.aspectRatio === "smart" &&
    smartPresetResponse.status === 200 &&
    smartPresetPayload?.size === "1232x992" &&
    historyById[smartPresetData.historyId]?.size === "smart" &&
    Object.values(historyById).every((item) => item?.count === item?.requestN && item?.images === item?.count);

  console.log(
    JSON.stringify(
      {
        ok,
        generate: {
          status: generateResponse.status,
          images: generateData.images?.length || 0,
          upstreamPayload: generatePayload,
        },
        edit: {
          status: editResponse.status,
          images: editData.images?.length || 0,
          upstreamPayload: editPayload,
        },
        smartRatio: {
          status: smartRatioResponse.status,
          images: smartRatioData.images?.length || 0,
          upstreamPayload: smartRatioPayload,
        },
        smartPreset: {
          status: smartPresetResponse.status,
          images: smartPresetData.images?.length || 0,
          upstreamPayload: smartPresetPayload,
        },
        history: historyById,
      },
      null,
      2,
    ),
  );

  if (!ok) process.exitCode = 1;
} finally {
  await deleteCreatedHistory();
  child.kill("SIGTERM");
  await new Promise((resolve) => mock.close(resolve));
  await rm(appDataDir, { recursive: true, force: true });
}
