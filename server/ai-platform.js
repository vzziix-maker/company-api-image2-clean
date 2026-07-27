import { randomUUID } from "node:crypto";

export const AI_PLATFORM_PROVIDER_ID = "builtin-ai-platform";
export const AI_PLATFORM_PROVIDER = Object.freeze({
  id: AI_PLATFORM_PROVIDER_ID,
  name: "AI中台",
  baseUrl: "",
  apiKey: "",
  source: "builtin",
  adapter: "ai-platform",
  builtIn: true,
});

const DEFAULT_AI_PLATFORM_BASE_URL = "http://ai-platform-dev.cds8.cn";
const DEFAULT_LITTERBOX_UPLOAD_URL = "https://litterbox.catbox.moe/resources/internals/api.php";
const DEFAULT_UGUU_UPLOAD_URL = "https://uguu.se/upload.php";
const DEFAULT_FILEBIN_ORIGIN = "https://filebin.net";
const DEFAULT_RESULT_SOURCE_HOST = "ai-platform-resource-test.oss-cn-shanghai-internal.aliyuncs.com";
const DEFAULT_RESULT_CDN_ORIGIN = "https://cdn-ai-platform-resource-test.cds8.cn";
const AI_PLATFORM_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9", "9:21"];
const filebinCleanupUrls = new Map();

function adapterError(message, code, status = 502, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details) error.details = details;
  return error;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function responseData(response, label) {
  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    throw adapterError(
      `${label}失败（HTTP ${response.status}）。`,
      "ai_platform_request_failed",
      response.status,
      data || { response: text.slice(0, 500) },
    );
  }
  if (!data) {
    throw adapterError(`${label}返回了无法解析的数据。`, "ai_platform_invalid_response", 502);
  }
  return data;
}

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size || ""));
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function nearestAspectRatio(size) {
  const dimensions = parseSize(size);
  if (!dimensions) return "9:16";
  const target = dimensions.width / dimensions.height;
  return AI_PLATFORM_RATIOS.reduce((nearest, candidate) => {
    const [width, height] = candidate.split(":").map(Number);
    const [nearestWidth, nearestHeight] = nearest.split(":").map(Number);
    const distance = Math.abs(Math.log(target / (width / height)));
    const nearestDistance = Math.abs(Math.log(target / (nearestWidth / nearestHeight)));
    return distance < nearestDistance ? candidate : nearest;
  }, AI_PLATFORM_RATIOS[0]);
}

function resolutionFromSize(size) {
  const dimensions = parseSize(size);
  if (!dimensions) return "1K";
  const longEdge = Math.max(dimensions.width, dimensions.height);
  if (longEdge <= 1024) return "1K";
  if (longEdge <= 2048) return "2K";
  return "4K";
}

export function buildAiPlatformExt(payload, body = {}) {
  const sizeMode = body.sizeMode === "ratio" ? "ratio" : "preset";
  const requestedResolution = ["1K", "2K", "4K"].includes(body.resolution) ? body.resolution : "1K";
  return {
    prompt: payload.prompt,
    model_version: payload.quality === "low" ? "image2_low" : payload.quality === "medium" ? "image2_medium" : "image2_high",
    aspect_radio: nearestAspectRatio(payload.size),
    resolution: sizeMode === "ratio" ? requestedResolution : resolutionFromSize(payload.size),
  };
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(adapterError("请求已取消。", "canceled", 499));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function uploadLitterboxFile(file, options) {
  const {
    signal,
    fetchImpl = fetch,
    dispatcher,
    uploadUrl = process.env.LITTERBOX_UPLOAD_URL || DEFAULT_LITTERBOX_UPLOAD_URL,
  } = options;
  const formData = new FormData();
  formData.set("reqtype", "fileupload");
  formData.set("time", "12h");
  formData.set("fileToUpload", new Blob([file.buffer], { type: file.mimetype }), file.originalname || "reference.png");

  const response = await fetchImpl(uploadUrl, {
    method: "POST",
    body: formData,
    signal,
    dispatcher,
  });
  const text = (await response.text()).trim();
  if (!response.ok) {
    throw adapterError(`Litterbox 上传失败（HTTP ${response.status}）。`, "reference_upload_failed", 502, {
      provider: "Litterbox",
      upstreamStatus: response.status,
      response: text.slice(0, 300),
    });
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw adapterError("参考图临时上传返回了无效地址。", "reference_upload_failed", 502);
  }
  if (url.protocol !== "https:" || url.hostname !== "litter.catbox.moe") {
    throw adapterError("参考图临时上传返回了不受信任的地址。", "reference_upload_failed", 502);
  }
  await verifyTemporaryImage(url, { ...options, verificationMethod: "HEAD" });
  return url.toString();
}

async function verifyTemporaryImage(url, options = {}) {
  if (options.skipVerify || process.env.TEMP_UPLOAD_SKIP_VERIFY === "1" || process.env.LITTERBOX_SKIP_VERIFY === "1") return;
  const {
    signal,
    fetchImpl = fetch,
    dispatcher,
    verificationMethod = "HEAD",
  } = options;
  const verification = await fetchImpl(url, {
    method: verificationMethod,
    headers: verificationMethod === "GET" ? { Range: "bytes=0-0" } : undefined,
    signal,
    dispatcher,
    redirect: verificationMethod === "HEAD" ? "error" : "follow",
  });
  const contentType = verification.headers.get("content-type") || "";
  if (verificationMethod === "GET") await verification.body?.cancel().catch(() => {});
  if (!verification.ok || !contentType.startsWith("image/")) {
    throw adapterError("参考图临时地址暂时不可访问。", "reference_upload_failed", 502, {
      upstreamStatus: verification.status,
      contentType,
    });
  }
}

async function uploadUguuFile(file, options) {
  const {
    signal,
    fetchImpl = fetch,
    dispatcher,
    uguuUploadUrl = process.env.UGUU_UPLOAD_URL || DEFAULT_UGUU_UPLOAD_URL,
  } = options;
  const formData = new FormData();
  formData.set("files[]", new Blob([file.buffer], { type: file.mimetype }), file.originalname || "reference.png");
  const response = await fetchImpl(uguuUploadUrl, {
    method: "POST",
    body: formData,
    signal,
    dispatcher,
  });
  const text = (await response.text()).trim();
  const data = parseJson(text);
  if (!response.ok || data?.success !== true) {
    throw adapterError(`Uguu 上传失败（HTTP ${response.status}）。`, "reference_upload_failed", 502, {
      provider: "Uguu",
      upstreamStatus: response.status,
      response: text.slice(0, 300),
    });
  }
  const url = new URL(data.files?.[0]?.url || "");
  if (url.protocol !== "https:" || !(url.hostname === "uguu.se" || url.hostname.endsWith(".uguu.se"))) {
    throw adapterError("Uguu 返回了不受信任的地址。", "reference_upload_failed", 502, { provider: "Uguu" });
  }
  await verifyTemporaryImage(url, { ...options, verificationMethod: "HEAD" });
  return url.toString();
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function filebinOrigin(options = {}) {
  return new URL(options.filebinOrigin || process.env.FILEBIN_ORIGIN || DEFAULT_FILEBIN_ORIGIN);
}

async function uploadFilebinFile(file, options) {
  const {
    signal,
    fetchImpl = fetch,
    dispatcher,
  } = options;
  const origin = filebinOrigin(options);
  const binId = `image2-${randomUUID()}`;
  const filename = `reference-${randomUUID()}${extensionForMimeType(file.mimetype)}`;
  const url = new URL(`${encodeURIComponent(binId)}/${encodeURIComponent(filename)}`, `${origin.toString().replace(/\/$/, "")}/`);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": file.mimetype || "application/octet-stream" },
    body: file.buffer,
    signal,
    dispatcher,
    redirect: "error",
  });
  const text = (await response.text()).trim();
  if (!response.ok) {
    throw adapterError(`Filebin 上传失败（HTTP ${response.status}）。`, "reference_upload_failed", 502, {
      provider: "Filebin",
      upstreamStatus: response.status,
      response: text.slice(0, 300),
    });
  }
  try {
    const downloadResponse = await fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": "curl/8.7.1" },
      signal,
      dispatcher,
      redirect: "manual",
    });
    await downloadResponse.body?.cancel().catch(() => {});
    const signedUrl = new URL(downloadResponse.headers.get("location") || "");
    const expectedStorageHost = options.filebinStorageHost || process.env.FILEBIN_STORAGE_HOST || "storage.filebin.net";
    if (downloadResponse.status !== 302 || signedUrl.protocol !== "https:" || signedUrl.hostname !== expectedStorageHost) {
      throw adapterError("Filebin 没有返回受信任的图片直链。", "reference_upload_failed", 502, {
        provider: "Filebin",
        upstreamStatus: downloadResponse.status,
      });
    }
    await verifyTemporaryImage(signedUrl, { ...options, verificationMethod: "GET" });
    filebinCleanupUrls.set(signedUrl.toString(), url.toString());
    return signedUrl.toString();
  } catch (error) {
    await fetchImpl(url, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
      dispatcher,
      redirect: "error",
    }).catch(() => {});
    throw error;
  }
}

function uploadFailureSummary(provider, error) {
  const status = error?.details?.upstreamStatus;
  return status ? `${provider} HTTP ${status}` : `${provider} ${error?.message || "请求失败"}`;
}

async function uploadWithRetries(provider, file, options, retries) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const configuredTimeout = Number(options.timeoutMs || process.env.TEMP_UPLOAD_TIMEOUT_MS || 120000);
      const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120000;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      return await provider.upload(file, { ...options, signal });
    } catch (error) {
      if (error.code === "canceled" || options.signal?.aborted) throw error;
      lastError = error;
      if (error.name === "TimeoutError") break;
      if (attempt < retries) await abortableDelay(200 * attempt, options.signal);
    }
  }
  throw lastError;
}

export async function uploadTemporaryReferences(files, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 2;
  const providers = [
    { name: "Litterbox", upload: uploadLitterboxFile },
    { name: "Uguu", upload: uploadUguuFile },
    { name: "Filebin", upload: uploadFilebinFile },
  ];
  const urls = [];
  for (const file of files) {
    const failures = [];
    let uploadedUrl = "";
    for (const provider of providers) {
      try {
        uploadedUrl = await uploadWithRetries(provider, file, options, retries);
        break;
      } catch (error) {
        if (error.code === "canceled" || options.signal?.aborted) throw error;
        failures.push(uploadFailureSummary(provider.name, error));
      }
    }
    if (!uploadedUrl) {
      throw adapterError(`参考图临时上传失败：${failures.join("；")}。`, "reference_upload_failed", 502, {
        providers: failures,
      });
    }
    urls.push(uploadedUrl);
  }
  return urls;
}

export const uploadLitterboxReferences = uploadTemporaryReferences;

export async function cleanupTemporaryReferences(urls, options = {}) {
  const origin = filebinOrigin(options);
  const { fetchImpl = fetch, dispatcher } = options;
  const results = await Promise.allSettled(
    urls.map(async (value) => {
      const cleanupUrl = filebinCleanupUrls.get(value) || value;
      const url = new URL(cleanupUrl);
      if (url.origin !== origin.origin) return false;
      try {
        const response = await fetchImpl(url, {
          method: "DELETE",
          signal: AbortSignal.timeout(10000),
          dispatcher,
          redirect: "error",
        });
        if (!response.ok) throw new Error(`Filebin cleanup failed with HTTP ${response.status}.`);
        return true;
      } finally {
        filebinCleanupUrls.delete(value);
      }
    }),
  );
  return {
    deleted: results.filter((result) => result.status === "fulfilled" && result.value === true).length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
}

export async function createAiPlatformTasks({ ext, count, referenceUrls = [], signal, fetchImpl = fetch, dispatcher }) {
  const baseUrl = (process.env.AI_PLATFORM_BASE_URL || DEFAULT_AI_PLATFORM_BASE_URL).replace(/\/$/, "");
  return Promise.all(
    Array.from({ length: count }, async () => {
      const response = await fetchImpl(`${baseUrl}/v2/external/image/tencent/gpt-image2/create`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          ext: {
            ...ext,
            ...(referenceUrls.length ? { image_url: referenceUrls } : {}),
          },
          user_id: "image2-local-app",
        }),
        signal,
        dispatcher,
      });
      const data = await responseData(response, "AI中台任务创建");
      const taskId = String(data?.data?.task_id_for_swagger || "");
      if (data.code !== 200 || !taskId) {
        throw adapterError(data.message || "AI中台没有返回有效任务 ID。", "ai_platform_create_failed", 502, data);
      }
      return taskId;
    }),
  );
}

async function pollAiPlatformTask(taskId, options) {
  const {
    signal,
    fetchImpl = fetch,
    dispatcher,
    pollIntervalMs = Number(process.env.AI_PLATFORM_POLL_INTERVAL_MS || 3000),
    timeoutMs = Number(process.env.AI_PLATFORM_TASK_TIMEOUT_MS || 3600000),
  } = options;
  const baseUrl = (process.env.AI_PLATFORM_BASE_URL || DEFAULT_AI_PLATFORM_BASE_URL).replace(/\/$/, "");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetchImpl(`${baseUrl}/v1/task/get?task_id=${encodeURIComponent(taskId)}`, {
      headers: { Accept: "application/json" },
      signal,
      dispatcher,
    });
    const data = await responseData(response, "AI中台任务查询");
    const task = data?.data || {};
    if (task.status === 99) {
      throw adapterError(task.result?.message || "AI中台生成失败。", "ai_platform_generation_failed", 502, task.result);
    }
    if (task.status === 100) {
      const result = task.result || {};
      const urls = (result.data || []).map((item) => item?.url).filter(Boolean);
      if (result.code !== 100 || !urls.length) {
        throw adapterError(result.message || "AI中台任务成功但没有返回图片。", "ai_platform_invalid_response", 502, result);
      }
      return { urls, useTokens: result.use_tokens ?? null };
    }
    await abortableDelay(pollIntervalMs, signal);
  }
  throw adapterError("AI中台生成超过 60 分钟，已停止等待。", "upstream_timeout", 504);
}

export function rewriteAiPlatformResultUrl(value) {
  const url = new URL(value);
  const sourceHost = process.env.AI_PLATFORM_RESULT_SOURCE_HOST || DEFAULT_RESULT_SOURCE_HOST;
  const cdnOrigin = new URL(process.env.AI_PLATFORM_RESULT_CDN_ORIGIN || DEFAULT_RESULT_CDN_ORIGIN);
  if (url.hostname === sourceHost) {
    url.protocol = cdnOrigin.protocol;
    url.hostname = cdnOrigin.hostname;
    url.port = cdnOrigin.port;
  }
  if (url.origin !== cdnOrigin.origin) {
    throw adapterError("AI中台返回了不受信任的结果地址。", "ai_platform_invalid_response", 502);
  }
  return url.toString();
}

export async function pollAiPlatformTasks(taskIds, options = {}) {
  const results = await Promise.all(taskIds.map((taskId) => pollAiPlatformTask(String(taskId), options)));
  return {
    urls: results.flatMap((result) => result.urls).map(rewriteAiPlatformResultUrl),
    useTokens: results.reduce((total, result) => total + (Number(result.useTokens) || 0), 0) || null,
  };
}
