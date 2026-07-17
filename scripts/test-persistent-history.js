import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockPort = Number(process.env.MOCK_IMAGE_API_PORT || 19888);
const appPort = Number(process.env.MOCK_APP_PORT || 19889);
const appDataDir = await mkdtemp(join(tmpdir(), "image2-persistent-history-"));
await writeFile(
  join(appDataDir, "settings.json"),
  JSON.stringify({
    activeProviderId: "test-provider",
    providerProfiles: [{
      id: "test-provider",
      name: "测试 Key",
      baseUrl: `http://localhost:${mockPort}/v1`,
      apiKey: "test-key",
    }],
  }),
);
const capturedRequests = [];

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
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

const mock = createServer(async (request, response) => {
  const body = await readBody(request);
  const parsed = JSON.parse(body.toString("utf8") || "{}");
  capturedRequests.push({ url: request.url, body: parsed });

  if (request.url === "/v1/images/generations") {
    await new Promise((resolve) => setTimeout(resolve, parsed.prompt === "persistent-one" ? 350 : 500));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(imageResponse(Number(parsed.n || 1), parsed.prompt));
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

async function readHistory() {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/history`);
  if (!response.ok) {
    throw new Error(`history failed: ${response.status}`);
  }
  return (await response.json()).items || [];
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

function startGenerate(clientRequestId, prompt) {
  const controller = new AbortController();
  const promise = fetch(`http://127.0.0.1:${appPort}/api/generate`, {
    method: "POST",
    signal: controller.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientRequestId,
      model: "gpt-image-2",
      prompt,
      sizeMode: "ratio",
      aspectRatio: "16:9",
      resolution: "2K",
      quality: "high",
      outputFormat: "png",
      background: "auto",
      count: 1,
    }),
  }).catch((error) => error);

  return { controller, promise };
}

try {
  await waitForServer();

  const first = startGenerate("persistent-task-one", "persistent-one");
  const second = startGenerate("persistent-task-two", "persistent-two");

  const runningItems = await waitFor(async () => {
    const items = await readHistory();
    const firstItem = items.find((item) => item.id === "persistent-task-one");
    const secondItem = items.find((item) => item.id === "persistent-task-two");
    return firstItem?.status === "running" && secondItem?.status === "running" ? [firstItem, secondItem] : null;
  }, "both running history records");

  first.controller.abort();
  second.controller.abort();
  await Promise.allSettled([first.promise, second.promise]);

  const completedItems = await waitFor(async () => {
    const items = await readHistory();
    const firstItem = items.find((item) => item.id === "persistent-task-one");
    const secondItem = items.find((item) => item.id === "persistent-task-two");
    return firstItem?.status === "success" && secondItem?.status === "success" ? [firstItem, secondItem] : null;
  }, "both persisted records to finish");

  const ok =
    runningItems.length === 2 &&
    completedItems.length === 2 &&
    completedItems.every((item) => item.images?.length === 1 && item.images[0].url && !item.images[0].b64_json) &&
    capturedRequests.length === 2;

  console.log(
    JSON.stringify(
      {
        ok,
        running: runningItems.map((item) => ({ id: item.id, status: item.status, prompt: item.config?.prompt })),
        completed: completedItems.map((item) => ({
          id: item.id,
          status: item.status,
          images: item.images?.length || 0,
          firstImageUrl: item.images?.[0]?.url,
        })),
        upstreamRequests: capturedRequests.length,
      },
      null,
      2,
    ),
  );

  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  child.kill();
  mock.close();
  await rm(appDataDir, { recursive: true, force: true });
}
