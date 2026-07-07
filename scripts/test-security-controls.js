import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const appPort = Number(process.env.MOCK_APP_PORT || 19909);
const blockedPort = Number(process.env.MOCK_BLOCKED_PORT || 19910);
const appDataDir = await mkdtemp(join(tmpdir(), "image2-security-"));
const rebindHost = "security-rebind.test";
const allowedPrivateHost = "ai-platform-cicada-llm-api.limayao.com";
const dnsLoaderPath = join(appDataDir, "dns-rebind-loader.mjs");
let blockedHits = 0;
let allowedPrivateHits = 0;

await mkdir(appDataDir, { recursive: true });
await writeFile(
  dnsLoaderPath,
  `
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const rebindHost = process.env.SECURITY_REBIND_HOST;
const allowedPrivateHost = process.env.SECURITY_ALLOWED_PRIVATE_HOST;
const publicAddress = "93.184.216.34";
const blockedAddress = "127.0.0.1";
const allowedPrivateAddress = "10.66.186.204";
const originalLookup = dns.lookup.bind(dns);
const originalPromisesLookup = dnsPromises.lookup.bind(dnsPromises);

dns.lookup = function patchedLookup(hostname, options, callback) {
  if (hostname === allowedPrivateHost) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options || {};
    if (opts.all) {
      process.nextTick(() => cb(null, [{ address: blockedAddress, family: 4 }]));
      return;
    }
    process.nextTick(() => cb(null, blockedAddress, 4));
    return;
  }
  if (hostname !== rebindHost) return originalLookup(hostname, options, callback);
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options || {};
  if (opts.all) {
    process.nextTick(() => cb(null, [{ address: blockedAddress, family: 4 }]));
    return;
  }
  process.nextTick(() => cb(null, blockedAddress, 4));
};

dnsPromises.lookup = async function patchedPromisesLookup(hostname, options) {
  if (hostname === allowedPrivateHost) {
    if (options?.all) return [{ address: allowedPrivateAddress, family: 4 }];
    return { address: allowedPrivateAddress, family: 4 };
  }
  if (hostname !== rebindHost) return originalPromisesLookup(hostname, options);
  if (options?.all) return [{ address: publicAddress, family: 4 }];
  return { address: publicAddress, family: 4 };
};

syncBuiltinESMExports();
`,
);
await writeFile(
  join(appDataDir, "settings.json"),
  JSON.stringify(
    {
      provider: {
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-fake-security-key",
        savedAt: "2026-07-07T00:00:00.000Z",
      },
      mode: "generate",
      config: {
        prompt: "saved prompt",
      },
    },
    null,
    2,
  ),
);

const blockedMock = createServer((_request, response) => {
  if (_request.headers.host?.startsWith(allowedPrivateHost)) {
    allowedPrivateHits += 1;
  } else {
    blockedHits += 1;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data: [{ id: "gpt-image-2" }] }));
});

await new Promise((resolve) => blockedMock.listen(blockedPort, "127.0.0.1", resolve));

const child = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(appPort),
    IMAGE_API_BASE_URL: "https://api.example.com/v1",
    IMAGE_API_KEY: "sk-env-security-key",
    APP_DATA_DIR: appDataDir,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${dnsLoaderPath}`].filter(Boolean).join(" "),
    SECURITY_REBIND_HOST: rebindHost,
    SECURITY_ALLOWED_PRIVATE_HOST: allowedPrivateHost,
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

try {
  await waitForServer();

  const settingsResponse = await fetch(`http://127.0.0.1:${appPort}/api/settings`);
  const settingsBody = await readJson(settingsResponse);
  const putSettingsResponse = await fetch(`http://127.0.0.1:${appPort}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "generate", config: { prompt: "new prompt" } }),
  });
  const putSettingsBody = await readJson(putSettingsResponse);
  const settingsText = JSON.stringify([settingsBody, putSettingsBody]);

  const blockedBaseUrl = `http://127.0.0.1:${blockedPort}/v1`;
  const verifyResponse = await fetch(`http://127.0.0.1:${appPort}/api/provider-settings/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: blockedBaseUrl, apiKey: "sk-local-target" }),
  });
  const verifyBody = await readJson(verifyResponse);

  const saveProviderResponse = await fetch(`http://127.0.0.1:${appPort}/api/provider-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: blockedBaseUrl, apiKey: "sk-local-target" }),
  });
  const saveProviderBody = await readJson(saveProviderResponse);

  const rebindBaseUrl = `http://${rebindHost}:${blockedPort}/v1`;
  const rebindVerifyResponse = await fetch(`http://127.0.0.1:${appPort}/api/provider-settings/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: rebindBaseUrl, apiKey: "sk-rebind-target" }),
  });
  const rebindVerifyBody = await readJson(rebindVerifyResponse);

  const allowedPrivateBaseUrl = `http://${allowedPrivateHost}:${blockedPort}/v1`;
  const allowedPrivateVerifyResponse = await fetch(`http://127.0.0.1:${appPort}/api/provider-settings/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: allowedPrivateBaseUrl, apiKey: "sk-allowed-private-target" }),
  });
  const allowedPrivateVerifyBody = await readJson(allowedPrivateVerifyResponse);

  const editForm = new FormData();
  editForm.set("prompt", "too many files");
  editForm.set("sizeMode", "ratio");
  editForm.set("aspectRatio", "1:1");
  editForm.set("resolution", "1K");
  editForm.set("quality", "low");
  editForm.set("outputFormat", "png");
  editForm.set("background", "auto");
  editForm.set("count", "1");
  for (let index = 0; index < 5; index += 1) {
    editForm.append("image", new File(["x"], `image-${index}.png`, { type: "image/png" }));
  }
  for (let index = 0; index < 2; index += 1) {
    editForm.append("image[]", new File(["x"], `image-array-${index}.png`, { type: "image/png" }));
  }
  const uploadResponse = await fetch(`http://127.0.0.1:${appPort}/api/edit`, {
    method: "POST",
    body: editForm,
  });
  const uploadBody = await readJson(uploadResponse);

  const ok =
    settingsResponse.status === 200 &&
    putSettingsResponse.status === 200 &&
    !settingsText.includes("sk-fake-security-key") &&
    !settingsText.includes("sk-env-security-key") &&
    settingsBody.settings?.provider?.hasApiKey === true &&
    verifyResponse.status === 400 &&
    verifyBody.error?.code === "invalid_provider_base_url" &&
    saveProviderResponse.status === 400 &&
    saveProviderBody.error?.code === "invalid_provider_base_url" &&
    rebindVerifyResponse.status === 400 &&
    rebindVerifyBody.error?.code === "invalid_provider_base_url" &&
    allowedPrivateVerifyResponse.status === 200 &&
    allowedPrivateVerifyBody.ok === true &&
    blockedHits === 0 &&
    allowedPrivateHits === 1 &&
    uploadResponse.status === 400 &&
    (uploadBody.error?.code === "LIMIT_FILE_COUNT" || uploadBody.error?.message);

  console.log(
    JSON.stringify(
      {
        ok,
        settingsRedacted: !settingsText.includes("sk-fake-security-key"),
        verifyStatus: verifyResponse.status,
        saveProviderStatus: saveProviderResponse.status,
        rebindVerifyStatus: rebindVerifyResponse.status,
        allowedPrivateVerifyStatus: allowedPrivateVerifyResponse.status,
        blockedHits,
        allowedPrivateHits,
        uploadStatus: uploadResponse.status,
        uploadCode: uploadBody.error?.code,
      },
      null,
      2,
    ),
  );

  if (!ok) process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => blockedMock.close(resolve));
  await rm(appDataDir, { recursive: true, force: true });
}
