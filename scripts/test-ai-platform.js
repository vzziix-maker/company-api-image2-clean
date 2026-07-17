import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockPort = 19931;
const appPort = 19932;
const appDataDir = await mkdtemp(join(tmpdir(), "image2-ai-platform-"));
const createRequests = [];
const litterboxRequests = [];
const taskPrompts = new Map();
let uploadIndex = 0;
let taskIndex = 0;
let resumeMayFinish = false;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function pngBuffer(width = 64, height = 64) {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt8(0x89, 0);
  buffer.write("PNG\r\n\x1a\n", 1, "latin1");
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(8, 24);
  buffer.writeUInt8(6, 25);
  return buffer;
}

const resultImage = pngBuffer(1024, 1024);
const mock = createServer(async (request, response) => {
  if (request.url === "/litterbox" && request.method === "POST") {
    const body = await readBody(request);
    const text = body.toString("latin1");
    uploadIndex += 1;
    const fileNumber = text.includes('filename="first.png"') ? 1 : text.includes('filename="second.png"') ? 2 : uploadIndex;
    litterboxRequests.push({
      hasTwelveHours: text.includes("12h"),
      hasFile: text.includes('name="fileToUpload"'),
    });
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(`https://litter.catbox.moe/test-${fileNumber}.png`);
    return;
  }

  if (request.url === "/v2/external/image/tencent/gpt-image2/create" && request.method === "POST") {
    const body = JSON.parse((await readBody(request)).toString("utf8"));
    taskIndex += 1;
    const taskId = String(9007199254741000n + BigInt(taskIndex));
    taskPrompts.set(taskId, body.ext?.prompt || "");
    createRequests.push(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 200, message: "ok", data: { task_id_for_swagger: taskId } }));
    return;
  }

  if (request.url?.startsWith("/v1/task/get")) {
    const taskId = new URL(request.url, `http://127.0.0.1:${mockPort}`).searchParams.get("task_id");
    const prompt = taskPrompts.get(taskId) || "";
    const running = prompt === "resume after restart" && !resumeMayFinish;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        code: 200,
        message: "ok",
        data: running
          ? { status: 10, task_id: taskId }
          : {
              status: 100,
              task_id: taskId,
              result: {
                code: 100,
                data: [{ url: `http://internal.test/result-${taskId}.png` }],
              },
            },
      }),
    );
    return;
  }

  if (request.url?.startsWith("/result-") && request.url.endsWith(".png")) {
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": String(resultImage.length),
    });
    response.end(resultImage);
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: { message: "not found" } }));
});

await new Promise((resolve) => mock.listen(mockPort, "127.0.0.1", resolve));

function startApp() {
  return spawn(process.execPath, ["server/index.js"], {
    env: {
      ...process.env,
      PORT: String(appPort),
      APP_DATA_DIR: appDataDir,
      AI_PLATFORM_BASE_URL: `http://127.0.0.1:${mockPort}`,
      AI_PLATFORM_POLL_INTERVAL_MS: "20",
      AI_PLATFORM_TASK_TIMEOUT_MS: "5000",
      AI_PLATFORM_RESULT_SOURCE_HOST: "internal.test",
      AI_PLATFORM_RESULT_CDN_ORIGIN: `http://127.0.0.1:${mockPort}`,
      LITTERBOX_UPLOAD_URL: `http://127.0.0.1:${mockPort}/litterbox`,
      LITTERBOX_SKIP_VERIFY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
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

async function stopApp(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function api(path, options) {
  const response = await fetch(`http://127.0.0.1:${appPort}${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function historyItems() {
  return (await api("/api/history?limit=100")).items || [];
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let child = startApp();
try {
  await waitForServer(child);

  const providers = await api("/api/provider-settings");
  assert.equal(providers.provider.id, "builtin-ai-platform");
  assert.equal(providers.profiles[0].builtIn, true);

  const editForm = new FormData();
  Object.entries({
    clientRequestId: "ai-platform-edit",
    prompt: "two temporary references",
    sizeMode: "ratio",
    aspectRatio: "1:1",
    resolution: "1K",
    quality: "medium",
    outputFormat: "png",
    background: "auto",
    count: "2",
  }).forEach(([key, value]) => editForm.set(key, value));
  editForm.append("image[]", new File([pngBuffer(800, 1200)], "first.png", { type: "image/png" }));
  editForm.append("image[]", new File([pngBuffer(1200, 800)], "second.png", { type: "image/png" }));
  const edited = await api("/api/edit", { method: "POST", body: editForm });
  assert.equal(edited.images.length, 2);

  const editHistory = (await historyItems()).find((item) => item.id === "ai-platform-edit");
  assert.equal(editHistory.status, "success");
  assert.equal(editHistory.source.images.length, 2);
  assert.equal(editHistory.images.length, 2);
  assert.deepEqual(editHistory.upstreamTaskIds.map(String).length, 2);
  assert.equal(litterboxRequests.length, 2);
  assert.ok(litterboxRequests.every((entry) => entry.hasTwelveHours && entry.hasFile));
  const editCreates = createRequests.filter((entry) => entry.ext?.prompt === "two temporary references");
  assert.equal(editCreates.length, 2);
  assert.deepEqual(editCreates[0].ext.image_url, [
    "https://litter.catbox.moe/test-1.png",
    "https://litter.catbox.moe/test-2.png",
  ]);

  const resumeRequest = fetch(`http://127.0.0.1:${appPort}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientRequestId: "ai-platform-resume",
      prompt: "resume after restart",
      sizeMode: "ratio",
      aspectRatio: "9:16",
      resolution: "1K",
      quality: "low",
      outputFormat: "png",
      background: "auto",
      count: 1,
    }),
  }).catch(() => null);

  await waitFor(async () => {
    const item = (await historyItems()).find((entry) => entry.id === "ai-platform-resume");
    return item?.status === "running" && item.upstreamTaskIds?.length === 1 ? item : null;
  }, "persisted AI platform task id");

  await stopApp(child);
  await resumeRequest;
  resumeMayFinish = true;
  child = startApp();
  await waitForServer(child);

  const resumed = await waitFor(async () => {
    const item = (await historyItems()).find((entry) => entry.id === "ai-platform-resume");
    return item?.status === "success" ? item : null;
  }, "resumed AI platform task");
  assert.equal(resumed.images.length, 1);
  assert.equal(resumed.upstreamTaskIds.every((id) => typeof id === "string"), true);

  const historyText = await readFile(join(appDataDir, "history.json"), "utf8");
  assert.equal(historyText.includes("litter.catbox.moe"), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: providers.provider.name,
        litterboxUploads: litterboxRequests.length,
        editTasks: editHistory.upstreamTaskIds.length,
        editImages: editHistory.images.length,
        resumedTask: resumed.status,
        temporaryUrlsPersisted: false,
      },
      null,
      2,
    ),
  );
} finally {
  await stopApp(child).catch(() => {});
  await new Promise((resolve) => mock.close(resolve));
  await rm(appDataDir, { recursive: true, force: true });
}
