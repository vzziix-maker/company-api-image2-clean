import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const providerPort = 19931;
const blockedPort = 19932;
const appPort = 19933;
const allowedProviderHost = "ai-platform-cicada-llm-api.limayao.com";
const appDataDir = await mkdtemp(join(tmpdir(), "image2-provider-results-"));
const dnsLoaderPath = join(appDataDir, "provider-result-dns-loader.mjs");
let blockedHits = 0;

function pngBuffer(width = 32, height = 32) {
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

await writeFile(
  dnsLoaderPath,
  [
    'import dns from "node:dns";',
    'import dnsPromises from "node:dns/promises";',
    'import { syncBuiltinESMExports } from "node:module";',
    "",
    "const allowedHost = process.env.SECURITY_ALLOWED_PROVIDER_HOST;",
    "const originalLookup = dns.lookup.bind(dns);",
    "const originalPromisesLookup = dnsPromises.lookup.bind(dnsPromises);",
    "",
    "dns.lookup = function patchedLookup(hostname, options, callback) {",
    "  if (hostname !== allowedHost) return originalLookup(hostname, options, callback);",
    '  const cb = typeof options === "function" ? options : callback;',
    '  const opts = typeof options === "function" ? {} : options || {};',
    "  if (opts.all) {",
    '    process.nextTick(() => cb(null, [{ address: "127.0.0.1", family: 4 }]));',
    "    return;",
    "  }",
    '  process.nextTick(() => cb(null, "127.0.0.1", 4));',
    "};",
    "",
    "dnsPromises.lookup = async function patchedPromisesLookup(hostname, options) {",
    "  if (hostname !== allowedHost) return originalPromisesLookup(hostname, options);",
    '  if (options?.all) return [{ address: "127.0.0.1", family: 4 }];',
    '  return { address: "127.0.0.1", family: 4 };',
    "};",
    "",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"),
);

await writeFile(
  join(appDataDir, "settings.json"),
  JSON.stringify({
    activeProviderId: "result-security-provider",
    providerProfiles: [{
      id: "result-security-provider",
      name: "Result security provider",
      baseUrl: "http://" + allowedProviderHost + ":" + providerPort + "/v1",
      apiKey: "sk-test-only",
    }],
  }),
);

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const provider = createServer(async (request, response) => {
  if (request.url === "/v1/images/generations") {
    const body = await readJsonBody(request);
    const url =
      body.prompt === "blocked result"
        ? "http://127.0.0.1:" + blockedPort + "/secret.png"
        : body.prompt === "invalid image"
          ? "/invalid.png"
          : "/safe.png";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ url }], usage: { total_tokens: 1 } }));
    return;
  }
  if (request.url === "/safe.png") {
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(pngBuffer());
    return;
  }
  if (request.url === "/invalid.png") {
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(JSON.stringify({ apiKey: "not-an-image" }));
    return;
  }
  response.writeHead(404).end();
});

const blockedTarget = createServer((_request, response) => {
  blockedHits += 1;
  response.writeHead(200, { "Content-Type": "image/png" });
  response.end(pngBuffer());
});

await new Promise((resolve) => provider.listen(providerPort, "127.0.0.1", resolve));
await new Promise((resolve) => blockedTarget.listen(blockedPort, "127.0.0.1", resolve));

const child = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(appPort),
    APP_DATA_DIR: appDataDir,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import=" + dnsLoaderPath].filter(Boolean).join(" "),
    SECURITY_ALLOWED_PROVIDER_HOST: allowedProviderHost,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("127.0.0.1:" + appPort)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", (code) => reject(new Error("server exited early: " + code)));
  });
}

async function generate(prompt) {
  const response = await fetch("http://127.0.0.1:" + appPort + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      sizeMode: "ratio",
      aspectRatio: "1:1",
      resolution: "1K",
      quality: "low",
      outputFormat: "png",
      background: "auto",
      count: 1,
    }),
  });
  return { response, body: await response.json() };
}

try {
  await waitForServer();

  const blocked = await generate("blocked result");
  const invalid = await generate("invalid image");
  const safe = await generate("safe result");
  const safeUrl = safe.body.images?.[0]?.url;
  const saved = safeUrl ? await fetch(new URL(safeUrl, "http://127.0.0.1:" + appPort)) : null;
  const savedBuffer = saved ? Buffer.from(await saved.arrayBuffer()) : Buffer.alloc(0);
  const ok =
    blocked.response.status === 502 &&
    blocked.body.error?.code === "invalid_provider_image_url" &&
    blockedHits === 0 &&
    invalid.response.status === 502 &&
    invalid.body.error?.code === "invalid_provider_image_content" &&
    safe.response.status === 200 &&
    safeUrl?.startsWith("/api/history-assets/") &&
    saved?.status === 200 &&
    savedBuffer.toString("ascii", 1, 4) === "PNG";

  console.log(JSON.stringify({
    ok,
    blockedStatus: blocked.response.status,
    blockedCode: blocked.body.error?.code,
    blockedHits,
    invalidStatus: invalid.response.status,
    invalidCode: invalid.body.error?.code,
    safeStatus: safe.response.status,
    safeUrl,
    savedStatus: saved?.status,
  }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await Promise.all([
    new Promise((resolve) => provider.close(resolve)),
    new Promise((resolve) => blockedTarget.close(resolve)),
  ]);
  await rm(appDataDir, { recursive: true, force: true });
}
