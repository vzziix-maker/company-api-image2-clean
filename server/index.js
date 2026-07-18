import "./env.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { lookup as lookupCallback } from "node:dns";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import multer from "multer";
import { Agent, interceptors } from "undici";
import {
  AI_PLATFORM_PROVIDER,
  AI_PLATFORM_PROVIDER_ID,
  buildAiPlatformExt,
  createAiPlatformTasks,
  pollAiPlatformTasks,
  uploadLitterboxReferences,
} from "./ai-platform.js";

const app = express();
const MAX_EDIT_IMAGES = 5;
const MAX_EDIT_FILES = MAX_EDIT_IMAGES + 1;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: MAX_EDIT_FILES,
    fields: 16,
    fieldSize: 1 * 1024 * 1024,
  },
});

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 43287);
const IMAGE_API_BASE_URL = (
  process.env.IMAGE_API_BASE_URL ||
  process.env.LLM_API_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  process.env.OPENAI_API_BASE_URL ||
  process.env.DEER_API_BASE_URL ||
  "https://api.deerapi.com/v1"
).replace(/\/$/, "");
const IMAGE_API_KEY =
  process.env.IMAGE_API_KEY ||
  process.env.LLM_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.DEER_API_KEY;
const REQUEST_TIMEOUT_MS = Number(process.env.DEER_API_TIMEOUT_MS || process.env.IMAGE_API_TIMEOUT_MS || 3600000);
const UPSTREAM_HEADERS_TIMEOUT_MS = Number(
  process.env.IMAGE_API_HEADERS_TIMEOUT_MS || process.env.DEER_API_HEADERS_TIMEOUT_MS || REQUEST_TIMEOUT_MS
);
const UPSTREAM_BODY_TIMEOUT_MS = Number(
  process.env.IMAGE_API_BODY_TIMEOUT_MS || process.env.DEER_API_BODY_TIMEOUT_MS || REQUEST_TIMEOUT_MS
);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 500);
const DEFAULT_HISTORY_PAGE_SIZE = 30;
const MAX_HISTORY_PAGE_SIZE = 100;
const DATA_DIR = process.env.APP_DATA_DIR
  ? pathToFileURL(`${resolve(process.env.APP_DATA_DIR)}/`)
  : new URL("../.data/", import.meta.url);
const HISTORY_DIR = DATA_DIR;
const HISTORY_FILE = new URL("history.json", DATA_DIR);
const SETTINGS_FILE = new URL("settings.json", DATA_DIR);
const HISTORY_ASSETS_DIR = new URL("history-assets/", DATA_DIR);
const ALLOW_LOCAL_PROVIDER_URLS = process.env.ALLOW_LOCAL_PROVIDER_URLS === "1";
const PRIVATE_PROVIDER_HOST_ALLOWLIST = new Set(["ai-platform-cicada-llm-api.limayao.com"]);
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
const upstreamDispatcher = new Agent({
  headersTimeout: UPSTREAM_HEADERS_TIMEOUT_MS,
  bodyTimeout: UPSTREAM_BODY_TIMEOUT_MS,
}).compose([
  interceptors.dns({
    lookup: secureDnsLookup,
  }),
]);
const directDispatcher = new Agent({
  headersTimeout: UPSTREAM_HEADERS_TIMEOUT_MS,
  bodyTimeout: UPSTREAM_BODY_TIMEOUT_MS,
});
let historyWriteQueue = Promise.resolve();

app.use((request, response, next) => {
  if (isLoopbackAddress(request.socket.remoteAddress)) {
    next();
    return;
  }
  response.status(403).json({ error: { message: "Local API access is restricted to this computer." } });
});

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

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function isLoopbackAddress(address = "") {
  const normalized = String(address).replace(/^::ffff:/, "");
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

function paginateHistory(items, { cursor, limit }) {
  const startIndex = cursor ? items.findIndex((item) => item.id === cursor) + 1 : 0;
  const offset = startIndex > 0 ? startIndex : 0;
  const pageItems = items.slice(offset, offset + limit);
  const nextIndex = offset + pageItems.length;
  return {
    items: pageItems,
    nextCursor: nextIndex < items.length ? pageItems.at(-1)?.id || null : null,
    hasMore: nextIndex < items.length,
    total: items.length,
  };
}

function historyItemHasFavorite(item) {
  return Boolean(
    item?.images?.some((image) => image?.favorite === true) ||
    item?.source?.images?.some((image) => image?.favorite === true),
  );
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

function requireProviderConfig(provider) {
  if (!provider?.apiKey) {
    const error = new Error("Missing image API key. Fill provider settings or create .env.local before generating.");
    error.status = 500;
    throw error;
  }
  if (!provider?.baseUrl) {
    const error = new Error("Missing image API base URL. Fill provider settings or create .env.local before generating.");
    error.status = 500;
    throw error;
  }
}

function normalizeBaseUrl(value) {
  const baseUrl = normalizeString(value, "");
  if (!baseUrl) return "";
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function providerBaseUrlError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "invalid_provider_base_url";
  return error;
}

function findProviderBaseUrlError(error) {
  let current = error;
  while (current) {
    if (current.code === "invalid_provider_base_url") return current;
    current = current.cause;
  }
  return null;
}

function isBlockedIpAddress(address) {
  const normalized = String(address || "").replace(/^::ffff:/, "");
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (ipVersion === 6) {
    const lower = normalized.toLowerCase();
    return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  return false;
}

function isAllowedPrivateProviderHost(hostname) {
  return PRIVATE_PROVIDER_HOST_ALLOWLIST.has(String(hostname || "").toLowerCase());
}

async function assertProviderBaseUrlAllowed(baseUrl) {
  if (ALLOW_LOCAL_PROVIDER_URLS) return;
  const url = new URL(baseUrl);
  const hostname = url.hostname.toLowerCase();
  const allowPrivateResolution = isAllowedPrivateProviderHost(hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isBlockedIpAddress(hostname)) {
    throw providerBaseUrlError("Base URL must point to a public provider host.");
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw providerBaseUrlError("Base URL host could not be resolved.");
  }
  if (!allowPrivateResolution && (!addresses.length || addresses.some((entry) => isBlockedIpAddress(entry.address)))) {
    throw providerBaseUrlError("Base URL resolves to a blocked local or private address.");
  }
}

function secureDnsLookup(origin, options, callback) {
  lookupCallback(
    origin.hostname,
    {
      all: true,
      family: options.dualStack === false ? options.affinity : 0,
      order: "ipv4first",
    },
    (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      const resolvedAddresses = Array.from(addresses || []);
      if (
        !ALLOW_LOCAL_PROVIDER_URLS &&
        !isAllowedPrivateProviderHost(origin.hostname) &&
        (!resolvedAddresses.length || resolvedAddresses.some((entry) => isBlockedIpAddress(entry.address)))
      ) {
        callback(providerBaseUrlError("Base URL resolves to a blocked local or private address."));
        return;
      }
      callback(null, resolvedAddresses);
    },
  );
}

function getDefaultProviderSettings() {
  return {
    baseUrl: normalizeBaseUrl(IMAGE_API_BASE_URL),
    apiKey: normalizeString(IMAGE_API_KEY, ""),
    name: "环境变量",
    source: "env",
  };
}

function sanitizeProviderSettings(provider = {}) {
  return {
    baseUrl: normalizeBaseUrl(provider.baseUrl),
    apiKey: normalizeString(provider.apiKey, ""),
    savedAt: normalizeString(provider.savedAt, ""),
  };
}

function normalizeProviderProfileName(value, fallback) {
  return normalizeString(value, fallback).slice(0, 80);
}

function providerProfileNameFromBaseUrl(baseUrl, fallback) {
  try {
    return normalizeProviderProfileName(new URL(baseUrl).hostname, fallback);
  } catch {
    return fallback;
  }
}

function sanitizeProviderProfile(profile = {}, fallbackId = "") {
  const id = normalizeHistoryId(profile.id) || normalizeHistoryId(fallbackId);
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  const apiKey = normalizeString(profile.apiKey, "");
  if (!id || (!baseUrl && !apiKey)) return null;
  return {
    id,
    name: normalizeProviderProfileName(profile.name, providerProfileNameFromBaseUrl(baseUrl, "未命名 Key")),
    baseUrl,
    apiKey,
    savedAt: normalizeString(profile.savedAt, ""),
    updatedAt: normalizeString(profile.updatedAt, ""),
  };
}

function getSavedProviderProfiles(settings = {}) {
  const profiles = [];
  const usedIds = new Set();
  const addProfile = (profile, fallbackId) => {
    const sanitized = sanitizeProviderProfile(profile, fallbackId);
    if (!sanitized) return;
    let id = sanitized.id;
    if (usedIds.has(id)) {
      id = randomUUID();
    }
    usedIds.add(id);
    profiles.push({ ...sanitized, id });
  };

  if (Array.isArray(settings.providerProfiles)) {
    settings.providerProfiles.forEach((profile, index) => addProfile(profile, `profile-${index + 1}`));
  }

  if (!profiles.length) {
    const legacy = sanitizeProviderSettings(settings.provider);
    if (legacy.baseUrl && legacy.apiKey) {
      addProfile(
        {
          id: normalizeHistoryId(settings.activeProviderId) || "default",
          name: "默认 Key",
          ...legacy,
        },
        "default",
      );
    }
  }

  return profiles;
}

function getProviderProfileState(settings = {}) {
  const profiles = getSavedProviderProfiles(settings);
  const requestedActiveId = normalizeHistoryId(settings.activeProviderId);
  const selectedProfile = profiles.find((profile) => profile.id === requestedActiveId);
  const active = requestedActiveId === AI_PLATFORM_PROVIDER_ID || !selectedProfile ? AI_PLATFORM_PROVIDER : selectedProfile;
  return {
    profiles,
    active,
    activeProviderId: active.id,
  };
}

async function readProviderSettings() {
  const settings = await readSettings();
  const { active } = getProviderProfileState(settings || {});
  if (active.id === AI_PLATFORM_PROVIDER_ID) return AI_PLATFORM_PROVIDER;
  const fallback = getDefaultProviderSettings();
  return {
    ...active,
    baseUrl: active.baseUrl || fallback.baseUrl,
    apiKey: active.apiKey || fallback.apiKey,
    source: active.baseUrl && active.apiKey ? "saved" : fallback.source,
  };
}

function publicProviderSettings(provider) {
  return {
    id: provider.id || null,
    name: provider.name || null,
    baseUrl: provider.baseUrl,
    hasApiKey: Boolean(provider.apiKey),
    source: provider.source,
    adapter: provider.adapter || "openai-compatible",
    builtIn: Boolean(provider.builtIn),
    savedAt: provider.savedAt || null,
    updatedAt: provider.updatedAt || null,
  };
}

function publicProviderProfile(profile, activeProviderId) {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    hasApiKey: Boolean(profile.apiKey),
    source: profile.source || "saved",
    adapter: profile.adapter || "openai-compatible",
    builtIn: Boolean(profile.builtIn),
    savedAt: profile.savedAt || null,
    updatedAt: profile.updatedAt || null,
    active: profile.id === activeProviderId,
  };
}

function publicProviderPayload(settings = {}) {
  const { profiles, active, activeProviderId } = getProviderProfileState(settings);
  const provider = active.id === AI_PLATFORM_PROVIDER_ID ? active : { ...active, source: "saved" };
  return {
    provider: publicProviderSettings(provider),
    profiles: [AI_PLATFORM_PROVIDER, ...profiles].map((profile) => publicProviderProfile(profile, activeProviderId)),
    activeProviderId,
  };
}

function publicSettings(settings) {
  if (!settings) return null;
  const { provider, providerProfiles, activeProviderId, ...rest } = settings;
  const publicProvider = publicProviderPayload(settings);
  return {
    ...rest,
    ...publicProvider,
  };
}

async function writeProviderProfileSettings(settings, profiles, activeProviderId) {
  const active = profiles.find((profile) => profile.id === activeProviderId) || null;
  const selectedId = active?.id || AI_PLATFORM_PROVIDER_ID;
  const nextSettings = {
    ...settings,
    providerProfiles: profiles,
    activeProviderId: selectedId,
  };
  if (active) {
    nextSettings.provider = {
      baseUrl: active.baseUrl,
      apiKey: active.apiKey,
      savedAt: active.savedAt || active.updatedAt || new Date().toISOString(),
    };
  } else {
    delete nextSettings.provider;
  }
  await writeSettings(nextSettings);
  return nextSettings;
}

function notFoundError(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

async function updateProviderSettings(provider) {
  const settings = (await readSettings()) || {};
  const { profiles } = getProviderProfileState(settings);
  const requestedId = normalizeHistoryId(provider?.id);
  if (requestedId === AI_PLATFORM_PROVIDER_ID) {
    const error = new Error("AI中台是内置途径，不能修改。");
    error.status = 400;
    throw error;
  }
  const existingIndex = requestedId ? profiles.findIndex((profile) => profile.id === requestedId) : -1;
  if (requestedId && existingIndex < 0) {
    throw notFoundError("Provider profile not found.");
  }

  const existing = existingIndex >= 0 ? profiles[existingIndex] : null;
  const baseUrl = normalizeBaseUrl(provider?.baseUrl) || existing?.baseUrl || "";
  const apiKey = normalizeString(provider?.apiKey, "") || existing?.apiKey || "";
  if (!baseUrl) {
    const error = new Error("Base URL is invalid.");
    error.status = 400;
    throw error;
  }
  if (!apiKey) {
    const error = new Error("API key is required.");
    error.status = 400;
    throw error;
  }
  await assertProviderBaseUrlAllowed(baseUrl);

  const now = new Date().toISOString();
  const id = requestedId || randomUUID();
  const nextProvider = {
    id,
    name: normalizeProviderProfileName(
      provider?.name,
      existing?.name || providerProfileNameFromBaseUrl(baseUrl, `Key ${profiles.length + 1}`),
    ),
    baseUrl,
    apiKey,
    savedAt: existing?.savedAt || now,
    updatedAt: now,
  };

  const nextProfiles = existingIndex >= 0 ? profiles.map((profile, index) => (index === existingIndex ? nextProvider : profile)) : [...profiles, nextProvider];
  const nextSettings = await writeProviderProfileSettings(settings, nextProfiles, id);
  return publicProviderPayload(nextSettings);
}

async function selectProviderSettings(id) {
  const settings = (await readSettings()) || {};
  const { profiles } = getProviderProfileState(settings);
  const profileId = normalizeHistoryId(id);
  if (!profileId || (profileId !== AI_PLATFORM_PROVIDER_ID && !profiles.some((profile) => profile.id === profileId))) {
    throw notFoundError("Provider profile not found.");
  }
  const nextSettings = await writeProviderProfileSettings(settings, profiles, profileId);
  return publicProviderPayload(nextSettings);
}

async function deleteProviderSettings(id) {
  const settings = (await readSettings()) || {};
  const { profiles, activeProviderId } = getProviderProfileState(settings);
  const profileId = normalizeHistoryId(id);
  if (profileId === AI_PLATFORM_PROVIDER_ID) {
    const error = new Error("AI中台是内置途径，不能删除。");
    error.status = 400;
    throw error;
  }
  const nextProfiles = profiles.filter((profile) => profile.id !== profileId);
  if (!profileId || nextProfiles.length === profiles.length) {
    throw notFoundError("Provider profile not found.");
  }
  const nextActiveId = activeProviderId === profileId ? AI_PLATFORM_PROVIDER_ID : activeProviderId;
  const nextSettings = await writeProviderProfileSettings(settings, nextProfiles, nextActiveId);
  return publicProviderPayload(nextSettings);
}

async function readProviderProfileKey(id) {
  const settings = (await readSettings()) || {};
  const { profiles } = getProviderProfileState(settings);
  const profileId = normalizeHistoryId(id);
  if (profileId === AI_PLATFORM_PROVIDER_ID) {
    const error = new Error("AI中台不使用 Key。");
    error.status = 400;
    throw error;
  }
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw notFoundError("Provider profile not found.");
  }
  return profile.apiKey;
}

async function providerDraftToConfig(provider) {
  const settings = (await readSettings()) || {};
  const { profiles } = getProviderProfileState(settings);
  const requestedId = normalizeHistoryId(provider?.id);
  const existing = requestedId ? profiles.find((profile) => profile.id === requestedId) : null;
  if (requestedId && !existing) {
    throw notFoundError("Provider profile not found.");
  }
  return {
    baseUrl: normalizeBaseUrl(provider?.baseUrl) || existing?.baseUrl || "",
    apiKey: normalizeString(provider?.apiKey, "") || existing?.apiKey || "",
  };
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

function upstreamFetchError(error, url, baseUrl = "") {
  const cause = error.cause || {};
  const causeCode = error.code || cause.code;
  const causeMessage = cause.message || error.message;
  const upstreamError = new Error(`Image API connection failed${causeCode ? ` (${causeCode})` : ""}: ${causeMessage}`);
  upstreamError.status = 502;
  upstreamError.code = "upstream_fetch_failed";
  upstreamError.details = {
    url: baseUrl ? url.replace(baseUrl, "") : url,
    causeCode,
    causeMessage,
  };
  return upstreamError;
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

async function fetchDeer(url, options, externalSignal, baseUrl = "") {
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
      redirect: "error",
      signal: controller.signal,
      dispatcher: upstreamDispatcher,
      headersTimeout: UPSTREAM_HEADERS_TIMEOUT_MS,
      bodyTimeout: UPSTREAM_BODY_TIMEOUT_MS,
    });
  } catch (error) {
    if (externalSignal?.aborted) {
      throw canceledJobError();
    }
    const providerError = findProviderBaseUrlError(error);
    if (providerError) {
      throw providerError;
    }
    if (didTimeout || error.name === "TimeoutError" || error.name === "AbortError") {
      throw timeoutError();
    }
    const upstreamError = upstreamFetchError(error, url, baseUrl);
    console.error("Image API fetch failed:", upstreamError.details);
    throw upstreamError;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortExternal);
  }
}

async function downloadAiPlatformImages(urls, signal) {
  const images = await Promise.all(
    urls.map(async (url, index) => {
      const response = await fetch(url, {
        signal,
        dispatcher: directDispatcher,
        redirect: "error",
      });
      if (!response.ok) {
        const error = new Error(`生成结果下载失败（HTTP ${response.status}）。`);
        error.status = 502;
        error.code = "ai_platform_result_download_failed";
        throw error;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) {
        const error = new Error("生成结果地址没有返回图片。");
        error.status = 502;
        error.code = "ai_platform_result_download_failed";
        throw error;
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 25 * 1024 * 1024) {
        const error = new Error("生成结果图片超过 25MB，已停止下载。");
        error.status = 502;
        error.code = "ai_platform_result_download_failed";
        throw error;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 25 * 1024 * 1024) {
        const error = new Error("生成结果图片超过 25MB，已停止保存。");
        error.status = 502;
        error.code = "ai_platform_result_download_failed";
        throw error;
      }
      return {
        index,
        b64_json: buffer.toString("base64"),
      };
    }),
  );
  return saveGeneratedImages(images, "png", "result");
}

async function executeAiPlatformJob({ historyId, payload, sourceBody, referenceFiles = [], taskIds = [], controller }) {
  const ext = buildAiPlatformExt(payload, sourceBody);
  let upstreamTaskIds = taskIds.map(String).filter(Boolean);
  if (!upstreamTaskIds.length) {
    const referenceUrls = referenceFiles.length
      ? await uploadLitterboxReferences(referenceFiles, {
          signal: controller.signal,
          dispatcher: directDispatcher,
        })
      : [];
    upstreamTaskIds = await createAiPlatformTasks({
      ext,
      count: payload.n,
      referenceUrls,
      signal: controller.signal,
      dispatcher: directDispatcher,
    });
    await updateHistory(historyId, (item) => ({
      ...item,
      upstreamTaskIds,
    }));
  }

  const result = await pollAiPlatformTasks(upstreamTaskIds, {
    signal: controller.signal,
    dispatcher: directDispatcher,
  });
  const historyImages = await downloadAiPlatformImages(result.urls, controller.signal);
  const completedAt = new Date().toISOString();
  const updated = await updateHistory(historyId, (item) => ({
    ...item,
    status: "success",
    completedAt,
    durationMs: item.startedAt ? Date.now() - new Date(item.startedAt).getTime() : item.durationMs,
    images: historyImages,
    usage: result.useTokens == null ? undefined : { total_tokens: result.useTokens },
    error: null,
  }));
  return {
    created: Math.floor(new Date(completedAt).getTime() / 1000),
    images: historyImages,
    usage: updated?.usage,
    historyId,
  };
}

async function failAiPlatformHistory(historyId, error) {
  const item = (await readHistory()).find((entry) => entry.id === historyId);
  if (!item || item.status !== "running") return;
  await updateHistory(historyId, (current) => ({
    ...current,
    status: isCanceledJobError(error) ? "canceled" : "failed",
    completedAt: new Date().toISOString(),
    durationMs: current.startedAt ? Date.now() - new Date(current.startedAt).getTime() : current.durationMs,
    error: isCanceledJobError(error)
      ? null
      : {
          message: error.message,
          status: error.status || 500,
          code: error.code,
          details: error.details,
        },
  }));
}

async function resumeAiPlatformJobs() {
  const items = await readHistory();
  items
    .filter((item) => item.status === "running" && item.providerId === AI_PLATFORM_PROVIDER_ID)
    .forEach((item) => {
      if (!Array.isArray(item.upstreamTaskIds) || !item.upstreamTaskIds.length || !item.requestPayload) {
        failAiPlatformHistory(item.id, new Error("服务重启时 AI中台任务尚未完成提交，请重新生成。")).catch(console.error);
        return;
      }
      const controller = new AbortController();
      activeJobs.set(item.id, { controller, mode: item.mode, providerId: AI_PLATFORM_PROVIDER_ID });
      executeAiPlatformJob({
        historyId: item.id,
        payload: item.requestPayload,
        sourceBody: item.config || {},
        taskIds: item.upstreamTaskIds,
        controller,
      })
        .catch((error) => failAiPlatformHistory(item.id, controller.signal.aborted ? canceledJobError() : error))
        .finally(() => activeJobs.delete(item.id));
    });
}

app.get("/api/health", async (_request, response, next) => {
  try {
    const provider = await readProviderSettings();
    response.json({
      ok: true,
      apiBaseUrl: provider.baseUrl,
      hasApiKey: Boolean(provider.apiKey),
      provider: publicProviderSettings(provider),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/history", async (request, response, next) => {
  try {
    const allItems = await readHistory();
    const items = request.query.favorite === "1" ? allItems.filter(historyItemHasFavorite) : allItems;
    const limit = numberInRange(request.query.limit, DEFAULT_HISTORY_PAGE_SIZE, 1, MAX_HISTORY_PAGE_SIZE);
    const cursor = normalizeHistoryId(request.query.cursor);
    response.json(paginateHistory(items, { cursor, limit }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/history/:id/favorite", async (request, response, next) => {
  try {
    const kind = request.body?.kind;
    if (kind !== "result" && kind !== "source") {
      const error = new Error("收藏图片类型无效。");
      error.status = 400;
      throw error;
    }
    if (typeof request.body?.favorite !== "boolean") {
      const error = new Error("收藏状态无效。");
      error.status = 400;
      throw error;
    }
    const imageId = normalizeString(request.body?.imageId, "");
    const imageIndex = Number(request.body?.imageIndex);
    const favorite = request.body.favorite;
    let targetFound = false;
    const updated = await updateHistory(request.params.id, (item) => {
      const images = kind === "result" ? item.images || [] : item.source?.images || [];
      const targetIndex = imageId
        ? images.findIndex((image) => image?.id === imageId)
        : Number.isInteger(imageIndex) && imageIndex >= 0 && imageIndex < images.length
          ? imageIndex
          : -1;
      if (targetIndex < 0) return item;
      targetFound = true;
      const nextImages = images.map((image, index) => (index === targetIndex ? { ...image, favorite } : image));
      return kind === "result"
        ? { ...item, images: nextImages }
        : { ...item, source: { ...(item.source || {}), images: nextImages } };
    });
    if (!updated) {
      const error = new Error("历史记录不存在。");
      error.status = 404;
      throw error;
    }
    if (!targetFound) {
      const error = new Error("历史图片不存在。");
      error.status = 404;
      throw error;
    }
    response.json({ ok: true, item: updated });
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
    response.json({ settings: publicSettings(await readSettings()) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (request, response, next) => {
  try {
    const currentSettings = (await readSettings()) || {};
    const settings = {
      ...currentSettings,
      mode: request.body?.mode === "edit" ? "edit" : "generate",
      config: bodyToUiConfig(request.body?.config || {}),
      savedAt: new Date().toISOString(),
    };
    await writeSettings(settings);
    response.json({ ok: true, settings: publicSettings(settings) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/provider-settings", async (_request, response, next) => {
  try {
    response.json(publicProviderPayload((await readSettings()) || {}));
  } catch (error) {
    next(error);
  }
});

app.put("/api/provider-settings", async (request, response, next) => {
  try {
    const payload = await updateProviderSettings(request.body || {});
    response.json({ ok: true, ...payload });
  } catch (error) {
    next(error);
  }
});

app.post("/api/provider-settings/select", async (request, response, next) => {
  try {
    const payload = await selectProviderSettings(request.body?.id);
    response.json({ ok: true, ...payload });
  } catch (error) {
    next(error);
  }
});

app.get("/api/provider-settings/:id/key", async (request, response, next) => {
  try {
    const apiKey = await readProviderProfileKey(request.params.id);
    response.json({ ok: true, apiKey });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/provider-settings/:id", async (request, response, next) => {
  try {
    const payload = await deleteProviderSettings(request.params.id);
    response.json({ ok: true, ...payload });
  } catch (error) {
    next(error);
  }
});

app.post("/api/provider-settings/verify", async (request, response, next) => {
  try {
    const provider = await providerDraftToConfig(request.body || {});
    requireProviderConfig(provider);
    await assertProviderBaseUrlAllowed(provider.baseUrl);
    const upstreamResponse = await fetchDeer(
      `${provider.baseUrl}/models`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
        },
      },
      undefined,
      provider.baseUrl,
    );
    const data = await parseDeerResponse(upstreamResponse);
    const models = Array.isArray(data?.data) ? data.data : [];
    const hasImage2 = models.some((model) => model?.id === "gpt-image-2");
    if (!hasImage2) {
      const error = new Error("未在该 Base URL 中找到 gpt-image-2 模型。");
      error.status = 400;
      error.details = { modelCount: models.length };
      throw error;
    }
    response.json({ ok: true, model: "gpt-image-2", modelCount: models.length });
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
    const provider = await readProviderSettings();
    const usesAiPlatform = provider.adapter === "ai-platform";
    if (!usesAiPlatform) {
      requireProviderConfig(provider);
      await assertProviderBaseUrlAllowed(provider.baseUrl);
    }
    payload = buildPayload(request.body, "generate");
    if (usesAiPlatform) {
      payload.output_format = "png";
      delete payload.background;
    }
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
      providerId: provider.id || null,
      images: [],
    });
    activeJobs.set(history.id, { controller, mode: "generate", providerId: provider.id || null });

    if (usesAiPlatform) {
      const clientData = await executeAiPlatformJob({
        historyId: history.id,
        payload,
        sourceBody: request.body,
        controller,
      });
      sendJsonIfOpen(response, clientData);
      return;
    }

    const deerResponse = await fetchDeer(`${provider.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }, controller.signal, provider.baseUrl);

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
  } catch (caughtError) {
    const error = controller.signal.aborted && !isCanceledJobError(caughtError) ? canceledJobError() : caughtError;
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
                details: error.details,
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
      const provider = await readProviderSettings();
      const usesAiPlatform = provider.adapter === "ai-platform";
      if (!usesAiPlatform) {
        requireProviderConfig(provider);
        await assertProviderBaseUrlAllowed(provider.baseUrl);
      }
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
      if (usesAiPlatform) {
        payload.output_format = "png";
        delete payload.background;
      }
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
        providerId: provider.id || null,
        source: {
          images: sourceImages,
          mask: sourceMask,
        },
        images: [],
      });
      activeJobs.set(history.id, { controller, mode: "edit", providerId: provider.id || null });

      if (usesAiPlatform) {
        const clientData = await executeAiPlatformJob({
          historyId: history.id,
          payload,
          sourceBody: request.body,
          referenceFiles: images,
          controller,
        });
        sendJsonIfOpen(response, clientData);
        return;
      }

      const deerResponse = await fetchDeer(`${provider.baseUrl}/images/edits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: formData,
      }, controller.signal, provider.baseUrl);

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
    } catch (caughtError) {
      const error = controller.signal.aborted && !isCanceledJobError(caughtError) ? canceledJobError() : caughtError;
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
                  details: error.details,
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
  if (error instanceof multer.MulterError) {
    error.status = 400;
  }
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

app.listen(PORT, HOST, () => {
  console.log(`Image API server listening on http://${HOST}:${PORT}`);
  resumeAiPlatformJobs().catch((error) => {
    console.error("Failed to resume AI platform jobs:", error);
  });
});
