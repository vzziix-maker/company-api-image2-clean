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
const DEFAULT_RESULT_SOURCE_HOST = "ai-platform-resource-test.oss-cn-shanghai-internal.aliyuncs.com";
const DEFAULT_RESULT_CDN_ORIGIN = "https://cdn-ai-platform-resource-test.cds8.cn";
const AI_PLATFORM_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9", "9:21"];

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
    throw adapterError(`参考图临时上传失败（HTTP ${response.status}）。`, "reference_upload_failed", 502);
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
  if (process.env.LITTERBOX_SKIP_VERIFY !== "1") {
    const verification = await fetchImpl(url, {
      method: "HEAD",
      signal,
      dispatcher,
      redirect: "error",
    });
    const contentType = verification.headers.get("content-type") || "";
    if (!verification.ok || !contentType.startsWith("image/")) {
      throw adapterError("参考图临时地址暂时不可访问。", "reference_upload_failed", 502);
    }
  }
  return url.toString();
}

export async function uploadLitterboxReferences(files, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 3;
  return Promise.all(
    files.map(async (file) => {
      let lastError;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          return await uploadLitterboxFile(file, options);
        } catch (error) {
          if (error.code === "canceled" || options.signal?.aborted) throw error;
          lastError = error;
          if (attempt < retries) await abortableDelay(250 * attempt, options.signal);
        }
      }
      if (lastError?.code === "reference_upload_failed") throw lastError;
      throw adapterError("参考图临时上传失败，请稍后重试。", "reference_upload_failed", 502, {
        cause: lastError?.message,
      });
    }),
  );
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
