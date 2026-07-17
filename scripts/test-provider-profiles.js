import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockPort = 19921;
const appPort = 19922;
const appDataDir = await mkdtemp(join(tmpdir(), "image2-provider-profiles-"));
const baseUrl = `http://127.0.0.1:${mockPort}/v1`;
const upstreamAuthHeaders = [];

await writeFile(
  join(appDataDir, "settings.json"),
  JSON.stringify(
    {
      provider: {
        baseUrl,
        apiKey: "sk-legacy",
        savedAt: "2026-07-07T00:00:00.000Z",
      },
    },
    null,
    2,
  ),
);

const mock = createServer(async (request, response) => {
  if (request.url === "/v1/images/generations") {
    upstreamAuthHeaders.push(request.headers.authorization);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        data: [{ b64_json: Buffer.from("image").toString("base64") }],
        usage: { total_tokens: 1 },
      }),
    );
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data: [{ id: "gpt-image-2" }] }));
});

await new Promise((resolve) => mock.listen(mockPort, "127.0.0.1", resolve));

const child = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(appPort),
    APP_DATA_DIR: appDataDir,
    IMAGE_API_BASE_URL: baseUrl,
    IMAGE_API_KEY: "sk-env",
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

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function api(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${appPort}${path}`, options);
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function generate() {
  return api("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "provider profile test",
      sizeMode: "ratio",
      aspectRatio: "1:1",
      resolution: "1K",
      quality: "low",
      outputFormat: "png",
      background: "auto",
      count: 1,
    }),
  });
}

try {
  await waitForServer();

  const initial = await api("/api/provider-settings");
  const initialText = JSON.stringify(initial);
  const builtinId = initial.profiles?.find((profile) => profile.builtIn)?.id;
  const legacyId = initial.profiles?.find((profile) => !profile.builtIn)?.id;

  const created = await api("/api/provider-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "备用 Key",
      baseUrl,
      apiKey: "sk-second",
    }),
  });
  const secondId = created.provider?.id;

  await api("/api/provider-settings/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: legacyId }),
  });
  await generate();

  await api("/api/provider-settings/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: secondId }),
  });
  await generate();

  const edited = await api("/api/provider-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: secondId,
      name: "重命名 Key",
      baseUrl,
      apiKey: "",
    }),
  });
  await generate();

  const secondKey = await api(`/api/provider-settings/${secondId}/key`);

  const afterDeleteSecond = await api(`/api/provider-settings/${secondId}`, { method: "DELETE" });
  const afterDeleteLegacy = await api(`/api/provider-settings/${legacyId}`, { method: "DELETE" });

  const responseText = JSON.stringify([initial, created, edited, afterDeleteSecond, afterDeleteLegacy]);
  const ok =
    initial.profiles?.length === 2 &&
    initial.provider?.id === builtinId &&
    initial.provider?.builtIn === true &&
    initial.provider?.hasApiKey === false &&
    !initialText.includes("sk-legacy") &&
    created.profiles?.length === 3 &&
    created.provider?.id === secondId &&
    created.provider?.name === "备用 Key" &&
    edited.provider?.id === secondId &&
    edited.provider?.name === "重命名 Key" &&
    secondKey.apiKey === "sk-second" &&
    afterDeleteSecond.profiles?.length === 2 &&
    afterDeleteSecond.provider?.id === builtinId &&
    afterDeleteLegacy.profiles?.length === 1 &&
    afterDeleteLegacy.provider?.id === builtinId &&
    upstreamAuthHeaders.at(-3) === "Bearer sk-legacy" &&
    upstreamAuthHeaders.at(-2) === "Bearer sk-second" &&
    upstreamAuthHeaders.at(-1) === "Bearer sk-second" &&
    !responseText.includes("sk-legacy") &&
    !responseText.includes("sk-second") &&
    !responseText.includes("sk-env");

  console.log(
    JSON.stringify(
      {
        ok,
        profileCountAfterCreate: created.profiles?.length,
        activeAfterEdit: edited.provider?.name,
        activeAfterDelete: afterDeleteSecond.provider?.id,
        providerAfterDeletingAll: afterDeleteLegacy.provider?.name,
        upstreamAuthHeaders,
      },
      null,
      2,
    ),
  );

  if (!ok) process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => mock.close(resolve));
  await rm(appDataDir, { recursive: true, force: true });
}
