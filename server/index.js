import "./env.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import multer from "multer";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

const PORT = Number(process.env.PORT || 8787);
const FALLBACK_IMAGE_API_BASE_URL = (
  process.env.IMAGE_API_BASE_URL ||
  process.env.LLM_API_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  process.env.OPENAI_API_BASE_URL ||
  process.env.DEER_API_BASE_URL ||
  ""
).replace(/\/$/, "");
const FALLBACK_IMAGE_API_KEY =
  process.env.IMAGE_API_KEY ||
  process.env.LLM_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.DEER_API_KEY;
const REQUEST_TIMEOUT_MS = Number(process.env.DEER_API_TIMEOUT_MS || process.env.IMAGE_API_TIMEOUT_MS || 1800000);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 30);
const DATA_DIR = process.env.APP_DATA_DIR
  ? pathToFileURL(`${resolve(process.env.APP_DATA_DIR)}/`)
  : new URL("../.data/", import.meta.url);
const HISTORY_DIR = DATA_DIR;
const HISTORY_FILE = new URL("history.json", DATA_DIR);
const SETTINGS_FILE = new URL("settings.json", DATA_DIR);
const API_CONFIG_FILE = new URL("api-config.json", DATA_DIR);
const HISTORY_ASSETS_DIR = new URL("history-assets/", DATA_DIR);
const MAX_EDIT_IMAGES = 5;
const SMART_SIZE_VALUE = "smart";
const SMART_ASPECT_RATIO_VALUE = "smart";
const DEFAULT_PRESET_SIZE = "1408x480";
const DEFAULT_SMART_ASPECT_RATIO = "9:16";
const MIN_PIXELS = 655360;
const MAX_PIXELS = 8294400;
const MAX_EDGE = 3840;
const MAX_ASPECT_RATIO = 3;

const OUTPUT_FORMATS = new Set(["png", "jpeg"]);
const QUALITIES = new Set(["low", "medium", "high", "auto"]);
const BACKGROUNDS = new Set(["transparent", "opaque", "auto"]);
const ASPECT_RATIOS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const RESOLUTIONS = new Set(["1K", "2K", "4K"]);
const RESOLUTION_LONG_EDGE = {
  "1K": 1024,
  "2K": 2048,
  "4K": 3840,
};
const activeJobs = new Map();
let historyWriteQueue = Promise.resolve();

app.use(express.json({ limit: "1mb" }));

async function readHistory() {
  try {
    const text = await readFile(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];

    const { items, changed } = await migrateInlineHistoryImages(parsed);
    if (changed) {
      await writeHistory(items);
    }
    return items;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeHistory(items) {
  await mkdir(HISTORY_DIR, { recursive: true });
  const limitedItems = Number.isFinite(HISTORY_LIMIT) ? items.slice(0, HISTORY_LIMIT) : items;
  await writeFile(HISTORY_FILE, JSON.stringify(limitedItems, null, 2));
}

function withHistoryWriteLock(operation) {
  const nextOperation = historyWriteQueue.then(operation, operation);
  historyWriteQueue = nextOperation.catch(() => {});
  return nextOperation;
}

function normalizeHistoryId(value) {
  const id = String(value || "").trim();
  if (!/^[\w.-]{1,160}$/.test(id)) return "";
  return id;
}

async function appendHistory(entry) {
  return withHistoryWriteLock(async () => {
    const items = await readHistory();
    const { id, ...restEntry } = entry;
    const saved = {
      id: normalizeHistoryId(id) || randomUUID(),
      createdAt: new Date().toISOString(),
      ...restEntry,
    };
    await writeHistory([saved, ...items.filter((item) => item.id !== saved.id)]);
    return saved;
  });
}

async function updateHistory(id, updater) {
  return withHistoryWriteLock(async () => {
    const items = await readHistory();
    let updatedItem = null;
    const nextItems = items.map((item) => {
      if (item.id !== id) return item;
      updatedItem = typeof updater === "function" ? updater(item) : { ...item, ...updater };
      return updatedItem;
    });
    await writeHistory(nextItems);
    return updatedItem;
  });
}

function sendJsonIfOpen(response, payload, status = 200) {
  if (response.destroyed || response.writableEnded) return;
  response.status(status).json(payload);
}

function safeAssetName(name, fallback) {
  const cleaned = String(name || fallback)
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

function assetUrl(id) {
  return `/api/history-assets/${id}`;
}

async function saveHistoryAsset(file, prefix) {
  if (!file) return null;

  const id = randomUUID();
  const extension = extname(file.originalname || "") || ".png";
  const filename = `${prefix}-${id}${extension}`;
  await mkdir(HISTORY_ASSETS_DIR, { recursive: true });
  await writeFile(new URL(filename, HISTORY_ASSETS_DIR), file.buffer);

  return {
    id: filename,
    url: assetUrl(filename),
    name: file.originalname || safeAssetName(filename, "image.png"),
    type: file.mimetype,
    size: file.size,
  };
}

async function saveGeneratedImageAsset(image, outputFormat = "png", prefix = "result") {
  if (!image?.b64_json) return image;

  const buffer = Buffer.from(image.b64_json, "base64");
  const safeFormat = outputFormat === "jpeg" ? "jpeg" : "png";
  const filename = `${prefix}-${randomUUID()}.${safeFormat === "jpeg" ? "jpg" : "png"}`;
  await mkdir(HISTORY_ASSETS_DIR, { recursive: true });
  await writeFile(new URL(filename, HISTORY_ASSETS_DIR), buffer);

  return {
    index: image.index,
    id: filename,
    url: assetUrl(filename),
    revised_prompt: image.revised_prompt,
    type: `image/${safeFormat}`,
    size: buffer.length,
  };
}

async function saveGeneratedImages(images = [], outputFormat = "png", prefix = "result") {
  return Promise.all(images.map((image, index) => saveGeneratedImageAsset({ index, ...image }, outputFormat, prefix)));
}

async function migrateInlineHistoryImages(items) {
  let changed = false;
  const migratedItems = [];

  for (const item of items) {
    if (!item?.images?.some((image) => image?.b64_json)) {
      migratedItems.push(item);
      continue;
    }

    const outputFormat = item.config?.outputFormat || item.requestPayload?.output_format || "png";
    const prefix = `result-${safeAssetName(item.id, "legacy")}`;
    const images = await Promise.all(
      item.images.map((image, index) =>
        image?.b64_json
          ? saveGeneratedImageAsset({ index, ...image }, outputFormat, prefix)
          : image,
      ),
    );
    migratedItems.push({ ...item, images });
    changed = true;
  }

  return { items: migratedItems, changed };
}

async function deleteHistoryAssets(items) {
  const assetIds = items.flatMap((item) => [
    ...((item.images || []).map((asset) => asset.id).filter(Boolean)),
    ...((item.source?.images || []).map((asset) => asset.id).filter(Boolean)),
    item.source?.mask?.id,
  ]).filter(Boolean);

  await Promise.all(
    assetIds.map((id) =>
      rm(new URL(safeAssetName(id, ""), HISTORY_ASSETS_DIR), { force: true }).catch((error) => {
        console.error("Failed to remove history asset:", error);
      }),
    ),
  );
}

async function readSettings() {
  try {
    return JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeSettings(settings) {
  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function normalizeBaseUrl(value, fallback = "") {
  const baseUrl = normalizeString(value, fallback).replace(/\/+$/, "");
  if (!baseUrl) return "";
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeApiKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

function maskApiKey(value) {
  const key = normalizeApiKey(value);
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function sanitizeApiConfig(config = {}) {
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKey: normalizeApiKey(config.apiKey),
  };
}

function publicApiConfig(config = {}) {
  const sanitized = sanitizeApiConfig(config);
  return {
    baseUrl: sanitized.baseUrl,
    hasApiKey: Boolean(sanitized.apiKey),
    apiKeyPreview: maskApiKey(sanitized.apiKey),
  };
}

async function readSavedApiConfig() {
  try {
    return sanitizeApiConfig(JSON.parse(await readFile(API_CONFIG_FILE, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { baseUrl: "", apiKey: "" };
    throw error;
  }
}

async function writeApiConfig(config) {
  const sanitized = sanitizeApiConfig(config);
  if (!sanitized.baseUrl) {
    const error = new Error("Base URL 无效。请填写完整的 http(s) 地址。");
    error.status = 400;
    throw error;
  }
  if (!sanitized.apiKey) {
    const error = new Error("API Key 不能为空。");
    error.status = 400;
    throw error;
  }

  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(API_CONFIG_FILE, JSON.stringify({
    ...sanitized,
    savedAt: new Date().toISOString(),
  }, null, 2));
  return sanitized;
}

async function getImageApiConfig() {
  const saved = await readSavedApiConfig();
  return {
    baseUrl: saved.baseUrl || FALLBACK_IMAGE_API_BASE_URL,
    apiKey: saved.apiKey || FALLBACK_IMAGE_API_KEY || "",
  };
}

async function requireConfig() {
  const config = await getImageApiConfig();
  if (!config.apiKey) {
    const error = new Error("Missing API Key. Open API 设置 and save a Base URL and API Key before generating images.");
    error.status = 500;
    throw error;
  }
  if (!config.baseUrl) {
    const error = new Error("Missing Base URL. Open API 设置 and save a Base URL and API Key before generating images.");
    error.status = 500;
    throw error;
  }
  return config;
}

function normalizeString(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function parseSize(size) {
  if (size === "auto") return null;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function validateSize(size) {
  if (size === "auto") return;

  const parsed = parseSize(size);
  if (!parsed) {
    const error = new Error(`Invalid size "${size}". Use WIDTHxHEIGHT or auto.`);
    error.status = 400;
    throw error;
  }

  const { width, height } = parsed;
  const pixels = width * height;
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (width > MAX_EDGE || height > MAX_EDGE) {
    const error = new Error(`Invalid size "${size}". Maximum edge is ${MAX_EDGE}px.`);
    error.status = 400;
    throw error;
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    const error = new Error(`Invalid size "${size}". Both edges must be multiples of 16.`);
    error.status = 400;
    throw error;
  }
  if (ratio > MAX_ASPECT_RATIO) {
    const error = new Error(`Invalid size "${size}". Long edge to short edge ratio must not exceed ${MAX_ASPECT_RATIO}:1.`);
    error.status = 400;
    throw error;
  }
  if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) {
    const error = new Error(`Invalid size "${size}". Total pixels must be between ${MIN_PIXELS} and ${MAX_PIXELS}.`);
    error.status = 400;
    throw error;
  }
}

function ceilTo16(value) {
  return Math.ceil(value / 16) * 16;
}

function floorTo16(value) {
  return Math.floor(value / 16) * 16;
}

function roundTo16(value) {
  return Math.round(value / 16) * 16;
}

function fitAspectRatio(width, height) {
  if (width / height > MAX_ASPECT_RATIO) {
    return { width: floorTo16(height * MAX_ASPECT_RATIO), height };
  }
  if (height / width > MAX_ASPECT_RATIO) {
    return { width, height: floorTo16(width * MAX_ASPECT_RATIO) };
  }
  return { width, height };
}

function adaptSizeToApi(size) {
  if (size === "auto") return size;

  const parsed = parseSize(size);
  if (!parsed) return size;

  const width = Math.max(16, roundTo16(parsed.width));
  const height = Math.max(16, roundTo16(parsed.height));
  const aspectFitted = fitAspectRatio(width, height);
  const fitted = fitPixelRange(aspectFitted.width, aspectFitted.height);
  return `${fitted.width}x${fitted.height}`;
}

function sizeFromDimensions(dimensions) {
  if (!dimensions?.width || !dimensions?.height) return "";
  return `${dimensions.width}x${dimensions.height}`;
}

function greatestCommonDivisor(a, b) {
  let nextA = Math.abs(Math.round(a));
  let nextB = Math.abs(Math.round(b));
  while (nextB) {
    const remainder = nextA % nextB;
    nextA = nextB;
    nextB = remainder;
  }
  return nextA || 1;
}

function aspectRatioFromDimensions(dimensions) {
  if (!dimensions?.width || !dimensions?.height) return DEFAULT_SMART_ASPECT_RATIO;
  const divisor = greatestCommonDivisor(dimensions.width, dimensions.height);
  return `${Math.round(dimensions.width / divisor)}:${Math.round(dimensions.height / divisor)}`;
}

function getPngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function getJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function getWebpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (format === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function getImageDimensions(file) {
  const buffer = file?.buffer;
  if (!buffer?.length) return null;
  return getPngDimensions(buffer) || getJpegDimensions(buffer) || getWebpDimensions(buffer);
}

function resolveSmartAspectRatio(mode, referenceDimensions) {
  return mode === "edit" ? aspectRatioFromDimensions(referenceDimensions) : DEFAULT_SMART_ASPECT_RATIO;
}

function resolveSmartPresetSize(mode, referenceDimensions) {
  if (mode === "edit") {
    return sizeFromDimensions(referenceDimensions) || DEFAULT_PRESET_SIZE;
  }
  return DEFAULT_PRESET_SIZE;
}

function fitPixelRange(width, height) {
  let { width: nextWidth, height: nextHeight } = fitAspectRatio(width, height);

  if (nextWidth * nextHeight < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / (nextWidth * nextHeight));
    nextWidth = ceilTo16(nextWidth * scale);
    nextHeight = ceilTo16(nextHeight * scale);
  }

  if (nextWidth * nextHeight > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / (nextWidth * nextHeight));
    nextWidth = floorTo16(nextWidth * scale);
    nextHeight = floorTo16(nextHeight * scale);
  }

  while (nextWidth * nextHeight > MAX_PIXELS) {
    if (nextWidth >= nextHeight) {
      nextWidth -= 16;
    } else {
      nextHeight -= 16;
    }
  }

  while (nextWidth * nextHeight < MIN_PIXELS) {
    if (nextWidth <= nextHeight) {
      nextWidth += 16;
    } else {
      nextHeight += 16;
    }
  }

  return { width: nextWidth, height: nextHeight };
}

function resolveRatioSize(aspectRatio, resolution) {
  const ratioMatch = /^(\d+):(\d+)$/.exec(aspectRatio || "");
  if (!ratioMatch) {
    const error = new Error(`Invalid aspect ratio "${aspectRatio}".`);
    error.status = 400;
    throw error;
  }
  if (!RESOLUTIONS.has(resolution)) {
    const error = new Error(`Invalid resolution "${resolution}".`);
    error.status = 400;
    throw error;
  }

  const [ratioWidth, ratioHeight] = ratioMatch.slice(1).map(Number);
  if (ratioWidth <= 0 || ratioHeight <= 0) {
    const error = new Error(`Invalid aspect ratio "${aspectRatio}".`);
    error.status = 400;
    throw error;
  }
  const longEdge = RESOLUTION_LONG_EDGE[resolution];
  let width;
  let height;

  if (ratioWidth >= ratioHeight) {
    width = longEdge;
    height = roundTo16((longEdge * ratioHeight) / ratioWidth);
  } else {
    height = longEdge;
    width = roundTo16((longEdge * ratioWidth) / ratioHeight);
  }

  const fitted = fitPixelRange(width, height);
  return `${fitted.width}x${fitted.height}`;
}

function buildPayload(body, mode, options = {}) {
  const prompt = normalizeString(body.prompt, "");
  if (!prompt) {
    const error = new Error("prompt is required.");
    error.status = 400;
    throw error;
  }

  const model = normalizeString(body.model, "gpt-image-2");
  const sizeMode = normalizeString(body.sizeMode, "preset");
  const requestedSize = normalizeString(body.size, DEFAULT_PRESET_SIZE);
  const outputFormat = normalizeString(body.outputFormat ?? body.output_format, "png");
  const quality = normalizeString(body.quality, "low");
  const background = normalizeString(body.background, "auto");
  const aspectRatio = normalizeString(body.aspectRatio ?? body.aspect_ratio, "1:1");
  const resolution = normalizeString(body.resolution, "1K");
  const count = Number(body.count ?? body.n ?? 4);

  if (sizeMode !== "preset" && sizeMode !== "ratio") {
    const error = new Error(`Invalid size mode "${sizeMode}".`);
    error.status = 400;
    throw error;
  }
  if (!RESOLUTIONS.has(resolution)) {
    const error = new Error(`Invalid resolution "${resolution}".`);
    error.status = 400;
    throw error;
  }

  const referenceDimensions = options.referenceDimensions || null;
  const effectiveAspectRatio =
    aspectRatio === SMART_ASPECT_RATIO_VALUE
      ? resolveSmartAspectRatio(mode, referenceDimensions)
      : aspectRatio;
  const effectiveRequestedSize =
    requestedSize === SMART_SIZE_VALUE
      ? resolveSmartPresetSize(mode, referenceDimensions)
      : requestedSize;
  const requestedPayloadSize = sizeMode === "ratio" ? resolveRatioSize(effectiveAspectRatio, resolution) : effectiveRequestedSize;
  const size = adaptSizeToApi(requestedPayloadSize);

  validateSize(size);
  if (!OUTPUT_FORMATS.has(outputFormat)) {
    const error = new Error(`Invalid output format "${outputFormat}".`);
    error.status = 400;
    throw error;
  }
  if (!QUALITIES.has(quality)) {
    const error = new Error(`Invalid quality "${quality}".`);
    error.status = 400;
    throw error;
  }
  if (background === "transparent" && model === "gpt-image-2") {
    const error = new Error("gpt-image-2 does not support transparent background. Choose auto or opaque.");
    error.status = 400;
    throw error;
  }
  if (background === "transparent" && outputFormat === "jpeg") {
    const error = new Error("transparent background requires png output format.");
    error.status = 400;
    throw error;
  }
  if (!BACKGROUNDS.has(background)) {
    const error = new Error(`Invalid background "${background}".`);
    error.status = 400;
    throw error;
  }
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    const error = new Error("count must be an integer from 1 to 4.");
    error.status = 400;
    throw error;
  }
  if (aspectRatio !== SMART_ASPECT_RATIO_VALUE && !/^(\d+):(\d+)$/.test(aspectRatio)) {
    const error = new Error(`Invalid aspect ratio "${aspectRatio}".`);
    error.status = 400;
    throw error;
  }

  const payload = {
    model,
    prompt,
    size,
    quality,
    output_format: outputFormat,
    n: count,
  };

  if (background !== "auto") {
    payload.background = background;
  }

  return payload;
}

async function parseDeerResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || response.statusText || "DeerAPI request failed.";
    const error = new Error(message);
    error.status = response.status;
    error.details = data;
    const headerRetryAfter = Number(response.headers.get("retry-after"));
    const messageRetryAfter = /retry after\s+(\d+)\s+seconds?/i.exec(message)?.[1];
    const retryAfter = Number.isFinite(headerRetryAfter) && headerRetryAfter > 0 ? headerRetryAfter : Number(messageRetryAfter || 0);
    if (response.status === 429 || /rate limit|exceeded the call rate limit|retry after/i.test(message)) {
      error.code = "rate_limit_exceeded";
      if (retryAfter > 0) {
        error.retryAfter = retryAfter;
      }
    }
    throw error;
  }

  return data;
}

function toClientResponse(data) {
  return {
    created: data?.created,
    usage: data?.usage,
    images: (data?.data || []).map((item, index) => ({
      index,
      b64_json: item.b64_json,
      url: item.url,
      revised_prompt: item.revised_prompt,
    })),
    raw: data,
  };
}

function payloadToUiConfig(payload, source = {}) {
  return {
    sizeMode: normalizeString(source.sizeMode, "preset"),
    model: payload.model,
    prompt: payload.prompt,
    size: normalizeString(source.size, payload.size),
    resolvedSize: payload.size,
    quality: payload.quality,
    outputFormat: payload.output_format,
    background: payload.background || "auto",
    count: payload.n || 4,
    aspectRatio: normalizeString(source.aspectRatio ?? source.aspect_ratio, "1:1"),
    resolution: normalizeString(source.resolution, "1K"),
  };
}

function bodyToUiConfig(body = {}) {
  const sizeMode = normalizeString(body.sizeMode, "preset");
  const requestedSize = normalizeString(body.size, DEFAULT_PRESET_SIZE);
  const aspectRatio = normalizeString(body.aspectRatio ?? body.aspect_ratio, "1:1");
  const resolution = normalizeString(body.resolution, "1K");
  const resolvedSize =
    sizeMode === "ratio"
      ? resolveRatioSize(aspectRatio === SMART_ASPECT_RATIO_VALUE ? DEFAULT_SMART_ASPECT_RATIO : aspectRatio, RESOLUTIONS.has(resolution) ? resolution : "1K")
      : adaptSizeToApi(requestedSize === SMART_SIZE_VALUE ? resolveSmartPresetSize("generate") : requestedSize);

  return {
    sizeMode,
    model: normalizeString(body.model, "gpt-image-2"),
    prompt: normalizeString(body.prompt, ""),
    size: requestedSize,
    resolvedSize,
    quality: normalizeString(body.quality, "low"),
    outputFormat: normalizeString(body.outputFormat ?? body.output_format, "png"),
    background: normalizeString(body.background, "auto"),
    count: Number(body.count ?? body.n ?? 4),
    aspectRatio,
    resolution,
  };
}

function fileSummary(file) {
  return file && { name: file.originalname, type: file.mimetype, size: file.size };
}

function collectEditImages(files = {}) {
  return [...(files.image || []), ...(files["image[]"] || [])];
}

function timeoutError() {
  const error = new Error(`Image API request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`);
  error.status = 504;
  error.code = "upstream_timeout";
  return error;
}

function canceledJobError() {
  const error = new Error("Request was canceled.");
  error.status = 499;
  error.code = "canceled";
  return error;
}

function isCanceledJobError(error) {
  return error?.code === "canceled";
}

async function fetchDeer(url, options, externalSignal) {
  const controller = new AbortController();
  let didTimeout = false;
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const abortExternal = () => {
    controller.abort();
  };

  if (externalSignal?.aborted) {
    abortExternal();
  } else {
    externalSignal?.addEventListener("abort", abortExternal, { once: true });
  }

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (externalSignal?.aborted) {
      throw canceledJobError();
    }
    if (didTimeout || error.name === "TimeoutError" || error.name === "AbortError") {
      throw timeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortExternal);
  }
}

async function testApiConfigConnection(config) {
  const sanitized = sanitizeApiConfig(config);
  if (!sanitized.baseUrl || !sanitized.apiKey) {
    const error = new Error("请先填写 Base URL 和 API Key。");
    error.status = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${sanitized.baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${sanitized.apiKey}`,
      },
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json().catch(() => ({})) : null;
    if (!response.ok) {
      const message = data?.error?.message || data?.message || response.statusText || "API 配置检测失败。";
      const error = new Error(message);
      error.status = response.status;
      if (response.status === 401 || response.status === 403) {
        error.message = "API Key 无效或没有访问权限。";
      }
      throw error;
    }
    if (!Array.isArray(data?.data)) {
      const error = new Error("Base URL 不是 OpenAI 兼容 API 地址。请确认地址包含 /v1。");
      error.status = 400;
      throw error;
    }
    return {
      ok: true,
      modelCount: data.data.length,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeout = new Error("连接检测超时。请确认 Base URL 可访问。");
      timeout.status = 504;
      throw timeout;
    }
    if (!error.status) {
      error.status = 502;
      error.message = "Base URL 不可访问或返回异常。";
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

app.get("/api/health", async (_request, response, next) => {
  try {
    response.json({
      ok: true,
      apiConfig: publicApiConfig(await getImageApiConfig()),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/history", async (_request, response, next) => {
  try {
    response.json({ items: await readHistory() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/history-assets/:id", async (request, response, next) => {
  try {
    const id = safeAssetName(request.params.id, "");
    if (!id || id !== request.params.id) {
      const error = new Error("Invalid asset id.");
      error.status = 400;
      throw error;
    }

    const asset = await readFile(new URL(id, HISTORY_ASSETS_DIR));
    response.type(extname(id) || "png").send(asset);
  } catch (error) {
    if (error.code === "ENOENT") {
      error.status = 404;
      error.message = "History asset not found.";
    }
    next(error);
  }
});

app.get("/api/settings", async (_request, response, next) => {
  try {
    response.json({ settings: await readSettings() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (request, response, next) => {
  try {
    const settings = {
      mode: request.body?.mode === "edit" ? "edit" : "generate",
      config: bodyToUiConfig(request.body?.config || {}),
      savedAt: new Date().toISOString(),
    };
    await writeSettings(settings);
    response.json({ ok: true, settings });
  } catch (error) {
    next(error);
  }
});

app.get("/api/api-config", async (_request, response, next) => {
  try {
    response.json({ apiConfig: publicApiConfig(await getImageApiConfig()) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/api-config", async (request, response, next) => {
  try {
    const apiConfig = await writeApiConfig(request.body || {});
    response.json({ ok: true, apiConfig: publicApiConfig(apiConfig) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/api-config/test", async (request, response, next) => {
  try {
    const config = request.body?.apiKey ? request.body : await getImageApiConfig();
    const result = await testApiConfigConnection(config);
    response.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/resolve-params", (request, response, next) => {
  try {
    const mode = request.body?.mode === "edit" ? "edit" : "generate";
    const payload = buildPayload(request.body || {}, mode);
    response.json({
      payload,
      config: payloadToUiConfig(payload, request.body),
      unsupportedFieldsDropped: ["aspectRatio", "resolution"],
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/history", async (_request, response, next) => {
  try {
    await deleteHistoryAssets(await readHistory());
    await writeHistory([]);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/history/:id", async (request, response, next) => {
  try {
    const activeJob = activeJobs.get(request.params.id);
    if (activeJob) {
      activeJob.controller.abort();
      activeJobs.delete(request.params.id);
    }
    const items = await readHistory();
    const deletedItems = items.filter((item) => item.id === request.params.id);
    await deleteHistoryAssets(deletedItems);
    await writeHistory(items.filter((item) => item.id !== request.params.id));
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/history/:id/cancel", async (request, response, next) => {
  try {
    const activeJob = activeJobs.get(request.params.id);
    if (activeJob) {
      activeJob.controller.abort();
      activeJobs.delete(request.params.id);
    }
    const canceledAt = new Date().toISOString();
    const updated = await updateHistory(request.params.id, (item) => ({
      ...item,
      status: "canceled",
      completedAt: canceledAt,
      durationMs: item.startedAt ? Date.now() - new Date(item.startedAt).getTime() : item.durationMs,
      error: null,
    }));
    response.json({ ok: true, item: updated });
  } catch (error) {
    next(error);
  }
});

app.post("/api/generate", async (request, response, next) => {
  const startedAt = Date.now();
  let payload;
  let history;
  const controller = new AbortController();
  try {
    const apiConfig = await requireConfig();
    payload = buildPayload(request.body, "generate");
    const clientRequestId = normalizeHistoryId(request.body?.clientRequestId);
    history = await appendHistory({
      id: clientRequestId,
      clientRequestId,
      mode: "generate",
      status: "running",
      startedAt: new Date(startedAt).toISOString(),
      durationMs: 0,
      config: payloadToUiConfig(payload, request.body),
      requestPayload: payload,
      images: [],
    });
    activeJobs.set(history.id, { controller, mode: "generate" });

    const deerResponse = await fetchDeer(`${apiConfig.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }, controller.signal);

    const data = await parseDeerResponse(deerResponse);
    const clientData = toClientResponse(data);
    const historyImages = await saveGeneratedImages(clientData.images, payload.output_format, "result");
    await updateHistory(history.id, (item) => ({
      ...item,
      status: "success",
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      images: historyImages,
      usage: clientData.usage,
    }));
    sendJsonIfOpen(response, { ...clientData, historyId: history.id });
  } catch (error) {
    if (history) {
      try {
        await updateHistory(history.id, (item) => ({
          ...item,
          status: isCanceledJobError(error) ? "canceled" : "failed",
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          error: isCanceledJobError(error)
            ? null
            : {
                message: error.message,
                status: error.status || 500,
                code: error.code,
                retryAfter: error.retryAfter,
              },
        }));
      } catch (historyError) {
        console.error("Failed to update history:", historyError);
      }
    }
    if (isCanceledJobError(error)) {
      sendJsonIfOpen(response, { error: { message: "已取消请求。", code: "canceled" } }, 499);
    } else {
      next(error);
    }
  } finally {
    if (history) activeJobs.delete(history.id);
  }
});

app.post(
  "/api/edit",
  upload.fields([
    { name: "image", maxCount: MAX_EDIT_IMAGES },
    { name: "image[]", maxCount: MAX_EDIT_IMAGES },
    { name: "mask", maxCount: 1 },
  ]),
  async (request, response, next) => {
    const startedAt = Date.now();
    let payload;
    let images = [];
    let mask;
    let history;
    const controller = new AbortController();
    try {
      const apiConfig = await requireConfig();
      images = collectEditImages(request.files);
      mask = request.files?.mask?.[0];
      if (!images.length) {
        const error = new Error("At least one image is required.");
        error.status = 400;
        throw error;
      }
      if (images.length > MAX_EDIT_IMAGES) {
        const error = new Error(`A maximum of ${MAX_EDIT_IMAGES} images is supported.`);
        error.status = 400;
        throw error;
      }

      const referenceDimensions = getImageDimensions(images[0]);
      payload = buildPayload(request.body, "edit", { referenceDimensions });
      const formData = new FormData();
      formData.set("model", payload.model);
      formData.set("prompt", payload.prompt);
      formData.set("size", payload.size);
      formData.set("quality", payload.quality);
      formData.set("output_format", payload.output_format);
      formData.set("n", String(payload.n));
      if (payload.background) formData.set("background", payload.background);
      if (payload.aspect_ratio) formData.set("aspect_ratio", payload.aspect_ratio);
      if (payload.resolution) formData.set("resolution", payload.resolution);
      images.forEach((image, index) => {
        formData.append("image[]", new Blob([image.buffer], { type: image.mimetype }), image.originalname || `image-${index + 1}.png`);
      });
      if (mask) {
        formData.set("mask", new Blob([mask.buffer], { type: mask.mimetype }), mask.originalname || "mask.png");
      }
      const sourceImages = await Promise.all(images.map((image, index) => saveHistoryAsset(image, `source-${index + 1}`)));
      const sourceMask = await saveHistoryAsset(mask, "mask");
      const clientRequestId = normalizeHistoryId(request.body?.clientRequestId);
      history = await appendHistory({
        id: clientRequestId,
        clientRequestId,
        mode: "edit",
        status: "running",
        startedAt: new Date(startedAt).toISOString(),
        durationMs: 0,
        config: payloadToUiConfig(payload, request.body),
        requestPayload: payload,
        source: {
          images: sourceImages,
          mask: sourceMask,
        },
        images: [],
      });
      activeJobs.set(history.id, { controller, mode: "edit" });

      const deerResponse = await fetchDeer(`${apiConfig.baseUrl}/images/edits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiConfig.apiKey}`,
        },
        body: formData,
      }, controller.signal);

      const data = await parseDeerResponse(deerResponse);
      const clientData = toClientResponse(data);
      const historyImages = await saveGeneratedImages(clientData.images, payload.output_format, "result");
      await updateHistory(history.id, (item) => ({
        ...item,
        status: "success",
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        images: historyImages,
        usage: clientData.usage,
      }));
      sendJsonIfOpen(response, { ...clientData, historyId: history.id });
    } catch (error) {
      if (history) {
        try {
          await updateHistory(history.id, (item) => ({
            ...item,
            status: isCanceledJobError(error) ? "canceled" : "failed",
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            error: isCanceledJobError(error)
              ? null
              : {
                  message: error.message,
                  status: error.status || 500,
                  code: error.code,
                  retryAfter: error.retryAfter,
                },
          }));
        } catch (historyError) {
          console.error("Failed to update history:", historyError);
        }
      }
      if (isCanceledJobError(error)) {
        sendJsonIfOpen(response, { error: { message: "已取消请求。", code: "canceled" } }, 499);
      } else {
        next(error);
      }
    } finally {
      if (history) activeJobs.delete(history.id);
    }
  }
);

app.use((error, _request, response, _next) => {
  const status = error.status || 500;
  if (error.retryAfter) {
    response.set("Retry-After", String(error.retryAfter));
  }
  response.status(status).json({
    error: {
      message: error.message || "Internal server error.",
      code: error.code,
      retryAfter: error.retryAfter,
      details: error.details,
    },
  });
});

app.listen(PORT, () => {
  console.log(`Image API server listening on http://localhost:${PORT}`);
});
