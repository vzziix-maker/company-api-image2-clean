import { createServer } from "node:http";
import { spawn } from "node:child_process";

const mockPort = 18878;
const appPort = 18879;
const retryAfter = 24;
const message =
  "Your requests to gpt-image-2 for gpt-image-2 in East US 2 have exceeded the call rate limit for your current OpenAI S0 pricing tier. This request was for ImageGenerations_Create under Azure OpenAI API version 2025-04-01-preview. Please retry after 24 seconds.";

const mock = createServer((request, response) => {
  if (request.url === "/v1/images/generations") {
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
    });
    response.end(JSON.stringify({ error: { message, type: "rate_limit_error", code: "rate_limit_exceeded" } }));
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
    DEER_API_BASE_URL: `http://localhost:${mockPort}/v1`,
    DEER_API_KEY: "test-key",
    HISTORY_LIMIT: "5",
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
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("exit", (code) => reject(new Error(`server exited early: ${code}`)));
  });

  const response = await fetch(`http://localhost:${appPort}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sizeMode: "preset",
      model: "gpt-image-2",
      prompt: "rate limit test",
      size: "1024x1024",
      quality: "low",
      outputFormat: "png",
      background: "auto",
      count: 1,
      aspectRatio: "1:1",
      resolution: "1K",
    }),
  });

  const data = await response.json();
  const ok =
    response.status === 429 &&
    data.error?.code === "rate_limit_exceeded" &&
    data.error?.retryAfter === retryAfter &&
    /retry after 24 seconds/i.test(data.error?.message || "");

  console.log(JSON.stringify({
    ok,
    status: response.status,
    code: data.error?.code,
    retryAfter: data.error?.retryAfter,
  }, null, 2));

  if (!ok) process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => mock.close(resolve));
}
