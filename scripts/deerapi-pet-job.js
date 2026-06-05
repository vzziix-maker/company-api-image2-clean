import "../server/env.js";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.error(
    "Usage: node scripts/deerapi-pet-job.js --run-dir <dir> --job-id <id> [--size <size>] [--quality <quality>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    args[key] = value;
    index += 1;
  }
  if (!args["run-dir"] || !args["job-id"]) usage();
  return args;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function loadJob(runDir, jobId) {
  const manifestPath = resolve(runDir, "imagegen-jobs.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const job = manifest.jobs?.find((item) => item.id === jobId);
  if (!job) {
    throw new Error(`Unknown job id: ${jobId}`);
  }
  const prompt = await readFile(resolve(runDir, job.prompt_file), "utf8");
  const inputImages = (job.input_images || []).map((item) => ({
    ...item,
    absolutePath: resolve(runDir, item.path),
  }));
  return { job, prompt, inputImages };
}

async function fileForUpload(path) {
  const bytes = await readFile(path);
  const blob = new Blob([bytes], { type: "image/png" });
  return new File([blob], basename(path), { type: "image/png" });
}

async function makeEditForm({ model, prompt, size, quality, outputFormat, inputImages, keyStyle }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("quality", quality);
  form.set("output_format", outputFormat);
  for (const image of inputImages) {
    const key = keyStyle === "brackets" ? "image[]" : "image";
    form.append(key, await fileForUpload(image.absolutePath));
  }
  return form;
}

async function callJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(Number(process.env.DEER_API_TIMEOUT_MS || 180000)),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || response.statusText);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function generateImage({ apiBaseUrl, apiKey, model, prompt, size, quality, outputFormat }) {
  return callJson(`${apiBaseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      quality,
      output_format: outputFormat,
      n: 1,
    }),
  });
}

async function editImage(options) {
  const attempts = ["brackets", "plain"];
  let lastError;
  for (const keyStyle of attempts) {
    try {
      const form = await makeEditForm({ ...options, keyStyle });
      const data = await callJson(`${options.apiBaseUrl}/images/edits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: form,
      });
      return { data, keyStyle };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function imageBytesFromResponse(data) {
  const first = data?.data?.[0];
  if (!first) {
    throw new Error("Image response did not include data[0]");
  }
  if (first.b64_json) {
    return Buffer.from(first.b64_json, "base64");
  }
  if (first.url) {
    const response = await fetch(first.url);
    if (!response.ok) {
      throw new Error(`Failed to download generated image URL: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("Image response did not include b64_json or url");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolve(args["run-dir"]);
  const jobId = args["job-id"];
  const apiBaseUrl = (process.env.DEER_API_BASE_URL || "https://api.deerapi.com/v1").replace(/\/$/, "");
  const apiKey = requiredEnv("DEER_API_KEY");
  const model = args.model || "gpt-image-2";
  const size = args.size || (jobId === "base" ? "1024x1024" : "2048x1152");
  const quality = args.quality || "low";
  const outputFormat = "png";
  const { prompt, inputImages } = await loadJob(runDir, jobId);

  const data =
    inputImages.length > 0
      ? (await editImage({ apiBaseUrl, apiKey, model, prompt, size, quality, outputFormat, inputImages })).data
      : await generateImage({ apiBaseUrl, apiKey, model, prompt, size, quality, outputFormat });

  const bytes = await imageBytesFromResponse(data);
  const codexHome = process.env.CODEX_HOME || `${process.env.HOME}/.codex`;
  const outputDir = resolve(codexHome, "generated_images", "deerapi-pet", `${Date.now()}-${jobId}-${randomUUID()}`);
  await mkdir(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, `ig_${jobId}.png`);
  await writeFile(outputPath, bytes);
  await writeFile(
    resolve(outputDir, "response.json"),
    JSON.stringify(
      {
        created: data.created,
        usage: data.usage,
        revised_prompt: data.data?.[0]?.revised_prompt,
        job_id: jobId,
        input_images: inputImages.map((image) => ({ path: image.absolutePath, role: image.role })),
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: true, job_id: jobId, selected_source: outputPath }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message, status: error.status, details: error.details }, null, 2));
    process.exit(1);
  });
}
