import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertCircleIcon, ArrowUpIcon, SettingsIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { createImageDownloadFilename } from "./download-filenames.js";
import {
  ATTENTION_DOCUMENT_TITLE,
  ATTENTION_DOCUMENT_TITLE_FRAMES,
  createCompletionReminderBatch,
  DEFAULT_DOCUMENT_TITLE,
  EMPTY_ATTENTION_DOCUMENT_TITLE,
  pageNeedsAttention,
  requestBrowserNotificationPermission,
  sendBrowserCompletionNotification,
  updateCompletionReminderBatch,
} from "./notification-reminders.js";
import { createApiSubmissionConfig, restoreSmartConfigFromReference } from "./history-config.js";
import { loadReferenceImageDraft, saveReferenceImageDraft } from "./reference-image-draft-storage.js";
import "./styles.css";

const SMART_SIZE_VALUE = "smart";
const SMART_ASPECT_RATIO_VALUE = "smart";
const SMART_LABEL = "智能";
const DEFAULT_PRESET_SIZE = "1408x480";
const DEFAULT_SMART_ASPECT_RATIO = "9:16";
const sizeOptions = [SMART_SIZE_VALUE, DEFAULT_PRESET_SIZE, "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"];
const sizeModeOptions = [
  { value: "preset", label: "直接尺寸" },
  { value: "ratio", label: "比例+分辨率" },
];
const qualityOptions = ["low", "medium", "high", "auto"];
const countOptions = [1, 2, 3, 4];
const aspectRatioOptions = [SMART_ASPECT_RATIO_VALUE, "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const resolutionOptions = ["1K", "2K", "4K"];
const CLIENT_TIMEOUT_MS = 3610000;
const HISTORY_PAGE_SIZE = 30;
const MAX_EDIT_IMAGES = 5;
const SETTINGS_STORAGE_KEY = "deerapi-gpt-image-2-settings-v1";
const PANEL_WIDTHS_STORAGE_KEY = "deerapi-gpt-image-2-panel-widths-v1";
const MIN_PIXELS = 655360;
const MAX_PIXELS = 8294400;
const MAX_ASPECT_RATIO = 3;
const RESOLUTION_LONG_EDGE = {
  "1K": 1024,
  "2K": 2048,
  "4K": 3840,
};

const initialConfig = {
  sizeMode: "preset",
  model: "gpt-image-2",
  prompt: "A simple red apple on a white background",
  size: SMART_SIZE_VALUE,
  quality: "low",
  outputFormat: "png",
  background: "auto",
  count: 4,
  aspectRatio: SMART_ASPECT_RATIO_VALUE,
  resolution: "1K",
};

const defaultPanelWidths = {
  control: 480,
  preview: 692,
  history: 420,
};

const panelWidthLimits = {
  control: { min: 320, max: 760 },
  preview: { min: 360, max: 1200 },
  history: { min: 300, max: 760 },
};

function createLocalId(prefix = "workspace") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createEmptyImageSlots() {
  return Array.from({ length: MAX_EDIT_IMAGES }, () => null);
}

function createRefreshConfig(model = initialConfig.model) {
  return {
    ...initialConfig,
    model: model || initialConfig.model,
    prompt: "",
    sizeMode: "ratio",
    size: SMART_SIZE_VALUE,
    aspectRatio: SMART_ASPECT_RATIO_VALUE,
    resolution: "2K",
    quality: "medium",
    outputFormat: "png",
    background: "auto",
    count: 4,
  };
}

function createWorkspace({ mode = "generate", config = initialConfig, statusKind = "idle" } = {}) {
  return {
    id: createLocalId(),
    mode,
    config: {
      ...initialConfig,
      ...config,
    },
    imageSlots: createEmptyImageSlots(),
    maskFile: null,
    maskOpen: false,
    images: [],
    error: "",
    status: "",
    statusKind,
    loading: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
    submittedAt: null,
    startedAt: null,
    durationMs: null,
    rateLimitUntil: 0,
    clientRequestId: null,
    historyId: null,
    previewOnly: false,
    sourceSnapshot: null,
    submittedSnapshot: null,
  };
}

function createRefreshWorkspace(model = initialConfig.model) {
  return createWorkspace({
    mode: "generate",
    config: createRefreshConfig(model),
  });
}

function createSubmissionWorkspace(workspace, submissionMode, submittedConfig, submittedSnapshot, sourceSnapshot, requestId, startedAt) {
  return {
    ...createWorkspace({
      mode: submissionMode,
      config: submittedConfig,
      statusKind: "running",
    }),
    id: requestId,
    mode: submissionMode,
    imageSlots: [...workspace.imageSlots],
    maskFile: workspace.maskFile,
    maskOpen: workspace.maskOpen,
    images: [],
    error: "",
    status: "",
    loading: true,
    createdAt: new Date(startedAt).toISOString(),
    completedAt: null,
    submittedAt: new Date(startedAt).toISOString(),
    startedAt,
    durationMs: null,
    rateLimitUntil: 0,
    clientRequestId: requestId,
    historyId: requestId,
    previewOnly: false,
    sourceSnapshot,
    submittedSnapshot,
  };
}

function createLocalAsset(file, prefix, index) {
  if (!file || typeof URL === "undefined") return null;
  return {
    id: createLocalId(`${prefix}-${index + 1}`),
    url: URL.createObjectURL(file),
    name: file.name,
    type: file.type,
    size: file.size,
    file,
    local: true,
  };
}

function createLocalSourceSnapshot(imageFiles, maskFile) {
  return {
    images: imageFiles.map((file, index) => createLocalAsset(file, "source", index)).filter(Boolean),
    mask: createLocalAsset(maskFile, "mask", 0),
  };
}

function cleanupSourceSnapshot(snapshot) {
  if (!snapshot || typeof URL === "undefined") return;
  [...(snapshot.images || []), snapshot.mask].filter(Boolean).forEach((asset) => {
    if (asset.local && asset.url) {
      URL.revokeObjectURL(asset.url);
    }
  });
}

function loadSavedSettings() {
  if (typeof window === "undefined") {
    return { mode: "generate", config: initialConfig, source: "default" };
  }

  try {
    const rawSettings = window.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (!rawSettings) {
      return { mode: "generate", config: initialConfig, source: "default" };
    }
    const saved = JSON.parse(rawSettings);
    return {
      mode: saved.mode === "edit" ? "edit" : "generate",
      config: {
        ...initialConfig,
        ...(saved.config || {}),
      },
      source: "local",
    };
  } catch {
    return { mode: "generate", config: initialConfig, source: "default" };
  }
}

function saveSettingsLocally(settings) {
  try {
    window.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return Boolean(window.localStorage);
  } catch {
    return false;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePanelWidths(widths = {}) {
  return Object.fromEntries(
    Object.entries(defaultPanelWidths).map(([key, defaultWidth]) => {
      const limits = panelWidthLimits[key];
      const nextWidth = Number(widths[key]);
      return [key, clamp(Number.isFinite(nextWidth) ? nextWidth : defaultWidth, limits.min, limits.max)];
    }),
  );
}

function loadSavedPanelWidths() {
  if (typeof window === "undefined") return defaultPanelWidths;

  try {
    const rawWidths = window.localStorage?.getItem(PANEL_WIDTHS_STORAGE_KEY);
    return normalizePanelWidths(rawWidths ? JSON.parse(rawWidths) : defaultPanelWidths);
  } catch {
    return defaultPanelWidths;
  }
}

function savePanelWidthsLocally(widths) {
  try {
    window.localStorage?.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Panel width persistence is a UI preference; ignore storage failures.
  }
}

function requestJson(url, options = {}) {
  if (typeof fetch === "function") {
    return fetch(url, options).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const apiError = new Error(data?.error?.message || "Request failed.");
        apiError.status = response.status;
        apiError.code = data?.error?.code;
        apiError.retryAfter = Number(data?.error?.retryAfter || response.headers.get("retry-after") || 0);
        throw apiError;
      }
      return data;
    });
  }

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(options.method || "GET", url);
    Object.entries(options.headers || {}).forEach(([key, value]) => request.setRequestHeader(key, value));
    request.onload = () => {
      let data = {};
      try {
        data = request.responseText ? JSON.parse(request.responseText) : {};
      } catch {
        data = {};
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(data);
      } else {
        const apiError = new Error(data?.error?.message || "Request failed.");
        apiError.status = request.status;
        apiError.code = data?.error?.code;
        apiError.retryAfter = Number(data?.error?.retryAfter || request.getResponseHeader("retry-after") || 0);
        reject(apiError);
      }
    };
    request.onerror = () => reject(new Error("Network request failed."));
    request.send(options.body || null);
  });
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

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(size || "");
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
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

function getFirstImageDimensions(imageDimensions = []) {
  return imageDimensions.find((item) => item?.width && item?.height) || null;
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
  const [ratioWidth, ratioHeight] = String(aspectRatio || DEFAULT_SMART_ASPECT_RATIO).split(":").map(Number);
  const longEdge = RESOLUTION_LONG_EDGE[resolution] || 1024;
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

function resolveSmartAspectRatio(mode, imageDimensions = []) {
  if (mode === "edit") {
    return aspectRatioFromDimensions(getFirstImageDimensions(imageDimensions));
  }
  return DEFAULT_SMART_ASPECT_RATIO;
}

function resolveSmartPresetSize(mode, imageDimensions = []) {
  if (mode === "edit") {
    return sizeFromDimensions(getFirstImageDimensions(imageDimensions)) || DEFAULT_PRESET_SIZE;
  }
  return DEFAULT_PRESET_SIZE;
}

function resolveConfigForSubmission(config, mode = "generate", imageDimensions = []) {
  const nextConfig = { ...config };
  if (nextConfig.sizeMode === "ratio") {
    if (nextConfig.aspectRatio === SMART_ASPECT_RATIO_VALUE) {
      nextConfig.aspectRatio = resolveSmartAspectRatio(mode, imageDimensions);
    }
  } else if (nextConfig.size === SMART_SIZE_VALUE) {
    nextConfig.size = resolveSmartPresetSize(mode, imageDimensions);
  }
  return nextConfig;
}

function getResolvedSize(config, mode = "generate", imageDimensions = []) {
  const resolvedConfig = resolveConfigForSubmission(config, mode, imageDimensions);
  if (resolvedConfig.sizeMode === "ratio") {
    return resolveRatioSize(resolvedConfig.aspectRatio || DEFAULT_SMART_ASPECT_RATIO, resolvedConfig.resolution || "1K");
  }
  return adaptSizeToApi(resolvedConfig.size);
}

function buildImageSrc(image, outputFormat) {
  if (image?.b64_json) {
    return `data:image/${outputFormat};base64,${image.b64_json}`;
  }
  return image?.url || "";
}

function outputMimeType(outputFormat = "png") {
  return outputFormat === "jpeg" ? "image/jpeg" : "image/png";
}

async function blobFromImageSrc(src, outputFormat = "png") {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error("无法读取图片。");
  }
  const blob = await response.blob();
  return blob.type ? blob : new Blob([blob], { type: outputMimeType(outputFormat) });
}

async function readImageDimensions(file) {
  if (!file) return null;
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dimensions;
  }

  if (typeof Image === "undefined" || typeof URL === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = reject;
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fileFromResultImage(image, outputFormat = "png") {
  const src = buildImageSrc(image, outputFormat);
  const blob = await blobFromImageSrc(src, outputFormat);
  const extension = outputFormat === "jpeg" ? "jpg" : outputFormat;
  return new File([blob], `result-${(image.index ?? 0) + 1}.${extension}`, { type: blob.type || outputMimeType(outputFormat) });
}

async function copyImageToClipboard(image, outputFormat = "png") {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("当前浏览器不支持复制图片到剪贴板。");
  }
  const src = buildImageSrc(image, outputFormat);
  const blob = await blobFromImageSrc(src, outputFormat);
  const clipboardBlob = blob.type === "image/png" ? blob : await convertBlobToPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardBlob })]);
}

async function convertBlobToPng(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob((pngBlob) => {
      if (pngBlob) {
        resolve(pngBlob);
      } else {
        reject(new Error("无法转换图片格式。"));
      }
    }, "image/png");
  });
}

function getHistoryResultEntries(item) {
  const outputFormat = item.config?.outputFormat || "png";
  const total = item.images?.length || 0;
  return (item.images || [])
    .map((image, index) => {
      const imageIndex = Number.isFinite(image.index) ? image.index : index;
      return {
        key: `${item.id}:result:${imageIndex}`,
        item,
        itemId: item.id,
        kind: "result",
        image,
        outputFormat,
        imageIndex,
        generatedAt: item.completedAt || item.createdAt,
        total,
        src: buildImageSrc(image, outputFormat),
        alt: `生成结果 ${imageIndex + 1}`,
      };
    })
    .filter((entry) => entry.src);
}

function getHistorySourceEntries(item) {
  const total = item.source?.images?.length || 0;
  return (item.source?.images || [])
    .map((image, index) => ({
    key: `${item.id}:source:${image.id || index}`,
    item,
    itemId: item.id,
    kind: "source",
    image,
    outputFormat: "png",
    imageIndex: index,
    total,
    src: image.url,
    alt: `参考图 ${index + 1}`,
    }))
    .filter((entry) => entry.src);
}

function fileSizeLabel(size) {
  if (!Number.isFinite(size)) return "";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileFromAsset(asset, fallbackName) {
  if (!asset?.url) return null;
  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`无法读取历史参考图：${asset.name || fallbackName}`);
  }
  const blob = await response.blob();
  return new File([blob], asset.name || fallbackName, { type: asset.type || blob.type || "image/png" });
}

function Field({ label, children, className = "" }) {
  return (
    <label className={cn("field", className)}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function HelpTip({ text }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="help-tip" role="img" tabIndex={0} aria-label={text}>
          <AlertCircleIcon aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{text}</TooltipContent>
    </Tooltip>
  );
}

function SelectField({ label, value, onChange, options, getDisabled }) {
  return (
    <Field label={label}>
      <Select value={String(value)} onValueChange={onChange}>
        <SelectTrigger className="field-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option || "none"} value={String(option)} disabled={getDisabled?.(option) || false}>
                {option === SMART_SIZE_VALUE || option === SMART_ASPECT_RATIO_VALUE ? SMART_LABEL : option || "不指定"}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function createProviderDraft(provider = {}) {
  return {
    id: provider.id || "",
    name: provider.name || "",
    baseUrl: provider.baseUrl || "",
    apiKey: "",
  };
}

function providerProfileFromProvider(provider) {
  if (!provider || provider.source !== "saved") return null;
  return {
    id: provider.id || "default",
    name: provider.name || "默认 Key",
    baseUrl: provider.baseUrl || "",
    hasApiKey: Boolean(provider.hasApiKey),
    source: "saved",
    savedAt: provider.savedAt || null,
    updatedAt: provider.updatedAt || null,
    active: true,
  };
}

function ProviderSettingsDialog({
  open,
  editorOpen,
  provider,
  profiles,
  draft,
  busy,
  result,
  onOpenChange,
  onEditorOpenChange,
  onDraftChange,
  onUseProfile,
  onEdit,
  onNew,
  onDelete,
  onVerify,
  onSave,
}) {
  const draftProfile = profiles.find((profile) => profile.id === draft.id);
  const hasSavedKey = Boolean(draftProfile?.hasApiKey);
  const isEditing = Boolean(draft.id);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="provider-dialog">
          <DialogHeader>
            <DialogTitle>模型设置</DialogTitle>
            <DialogDescription>管理兼容 OpenAI 的 Base URL 和 Key，用于调用 gpt-image-2。</DialogDescription>
          </DialogHeader>

          <div className="provider-list">
            {profiles.length ? (
              profiles.map((profile) => {
                const active = provider?.id === profile.id;
                return (
                  <div className="provider-list-item" key={profile.id}>
                    <button className="provider-list-main" type="button" onClick={() => onUseProfile(profile.id)}>
                      <span className="provider-list-title">
                        {profile.name || profile.baseUrl}
                        {active && <Badge variant="secondary">当前</Badge>}
                      </span>
                      <span className="provider-list-url">{profile.baseUrl}</span>
                    </button>
                    <div className="provider-list-actions">
                      {!active && (
                        <Button variant="outline" size="sm" type="button" disabled={busy === "select"} onClick={() => onUseProfile(profile.id)}>
                          使用
                        </Button>
                      )}
                      <Button variant="outline" size="sm" type="button" onClick={() => onEdit(profile)}>
                        修改
                      </Button>
                      <Button variant="outline" size="sm" type="button" disabled={busy === "delete"} onClick={() => onDelete(profile.id)}>
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="provider-empty">
                <p>还没有保存的 Key。</p>
                <span>新增后可在这里切换、修改和删除。</span>
              </div>
            )}
          </div>

          {result?.message && <p className={cn("provider-result", result.tone === "error" && "is-error")}>{result.message}</p>}

          <DialogFooter>
            <Button type="button" onClick={onNew}>
              新增 Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editorOpen} onOpenChange={onEditorOpenChange}>
        <DialogContent className="provider-dialog">
          <DialogHeader>
            <DialogTitle>{isEditing ? "修改 Key" : "新增 Key"}</DialogTitle>
            <DialogDescription>{isEditing ? "Key 留空会保留原 Key；重新填写则替换。" : "填写兼容 OpenAI 的 Base URL 和 Key。"}</DialogDescription>
          </DialogHeader>

          <div className="provider-form">
            <Field label="名称">
              <Input
                value={draft.name}
                onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
                placeholder="例如：公司 Key"
              />
            </Field>
            <Field label="Base URL">
              <Input
                value={draft.baseUrl}
                onChange={(event) => onDraftChange({ ...draft, baseUrl: event.target.value })}
                placeholder="https://example.com/v1"
              />
            </Field>
            <Field label="Key">
              <Input
                type="password"
                value={draft.apiKey}
                onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })}
                placeholder={hasSavedKey ? "已保存，留空则不替换" : "sk-..."}
              />
            </Field>
            <div className="provider-status">
              <Badge variant={hasSavedKey ? "secondary" : "outline"}>{hasSavedKey ? "已保存 Key" : "未保存 Key"}</Badge>
              {provider?.name && <Badge variant="outline">当前：{provider.name}</Badge>}
              {provider?.baseUrl && <span>{provider.baseUrl}</span>}
            </div>
            {result?.message && <p className={cn("provider-result", result.tone === "error" && "is-error")}>{result.message}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" type="button" disabled={busy === "verify"} onClick={onVerify}>
              {busy === "verify" ? "验证中..." : "验证"}
            </Button>
            <Button type="button" disabled={busy === "save"} onClick={onSave}>
              {busy === "save" ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function hasInternalImageSlotDrag(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes("application/x-image-slot-index");
}

function ImageSlot({ index, file, preview, onPick, onRemove, onMove }) {
  const inputRef = useRef(null);
  const dragDepthRef = useRef(0);
  const dragGhostRef = useRef(null);
  const draggingSelfRef = useRef(false);
  const hoverSuppressTimerRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [sortActive, setSortActive] = useState(false);
  const [draggingSelf, setDraggingSelf] = useState(false);
  const [suppressHover, setSuppressHover] = useState(false);
  const [pasteActive, setPasteActive] = useState(false);

  function pickFiles(fileList) {
    const nextFiles = Array.from(fileList || []).filter((item) => item.type.startsWith("image/"));
    if (nextFiles.length) {
      onPick(index, nextFiles);
    }
  }

  useEffect(() => {
    if (!pasteActive) return undefined;

    function handlePaste(event) {
      const files = Array.from(event.clipboardData?.files || []);
      const imageFiles = files.filter((item) => item.type.startsWith("image/"));
      if (!imageFiles.length) return;
      event.preventDefault();
      onPick(index, imageFiles);
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [index, onPick, pasteActive]);

  function clearDragState() {
    dragDepthRef.current = 0;
    setDragActive(false);
    setSortActive(false);
  }

  function cleanupDragGhost() {
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;
  }

  function suppressHoverBriefly() {
    window.clearTimeout(hoverSuppressTimerRef.current);
    setSuppressHover(true);
    setPasteActive(false);
    hoverSuppressTimerRef.current = window.setTimeout(() => {
      setSuppressHover(false);
    }, 110);
  }

  function createDragGhost(slotElement, event) {
    cleanupDragGhost();
    const ghost = slotElement.cloneNode(true);
    const rect = slotElement.getBoundingClientRect();
    ghost.classList.add("slot-drag-ghost");
    ghost.removeAttribute("role");
    ghost.removeAttribute("tabindex");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);
    dragGhostRef.current = ghost;
    event.dataTransfer.setDragImage(ghost, Math.min(rect.width / 2, 92), Math.min(rect.height / 2, 76));
  }

  function resetDragSession() {
    const wasDraggingSelf = draggingSelfRef.current;
    draggingSelfRef.current = false;
    clearDragState();
    setDraggingSelf(false);
    setPasteActive(false);
    cleanupDragGhost();
    if (wasDraggingSelf) {
      suppressHoverBriefly();
    }
  }

  useEffect(() => {
    resetDragSession();
    window.addEventListener("dragend", resetDragSession, true);
    window.addEventListener("drop", resetDragSession, true);
    window.addEventListener("blur", resetDragSession);
    return () => {
      window.removeEventListener("dragend", resetDragSession, true);
      window.removeEventListener("drop", resetDragSession, true);
      window.removeEventListener("blur", resetDragSession);
      window.clearTimeout(hoverSuppressTimerRef.current);
      cleanupDragGhost();
    };
  }, []);

  function handleDrop(event) {
    event.preventDefault();
    const isInternalMove = hasInternalImageSlotDrag(event.dataTransfer);
    resetDragSession();
    if (isInternalMove) {
      suppressHoverBriefly();
    }

    const sourceIndexValue = event.dataTransfer.getData("application/x-image-slot-index");
    const sourceIndex = Number(sourceIndexValue);
    if (sourceIndexValue && Number.isInteger(sourceIndex) && sourceIndex >= 0) {
      onMove(sourceIndex, index);
      return;
    }

    pickFiles(event.dataTransfer.files);
  }

  function handleDragStart(event) {
    if (!file) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-image-slot-index", String(index));
    event.dataTransfer.setData("text/plain", String(index));
    draggingSelfRef.current = true;
    setDraggingSelf(true);
    setPasteActive(false);
    createDragGhost(event.currentTarget, event);
  }

  function handleRemove(event) {
    event.stopPropagation();
    onRemove(index);
  }

  return (
    <div
      className={cn(
        "image-slot",
        file && "filled",
        dragActive && "drag-active",
        sortActive && "sort-active",
        draggingSelf && "dragging-self",
        suppressHover && "suppress-hover",
        pasteActive && "paste-active",
      )}
      onClick={() => inputRef.current?.click()}
      draggable={Boolean(file)}
      onDragStart={handleDragStart}
      onDragEnd={() => {
        resetDragSession();
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (hasInternalImageSlotDrag(event.dataTransfer)) {
          setSortActive(true);
          setDragActive(false);
        } else {
          setDragActive(true);
          setSortActive(false);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (hasInternalImageSlotDrag(event.dataTransfer)) {
          event.dataTransfer.dropEffect = "move";
          setSortActive(true);
        } else {
          event.dataTransfer.dropEffect = "copy";
          setDragActive(true);
        }
      }}
      onDragLeave={() => {
        dragDepthRef.current -= 1;
        if (dragDepthRef.current <= 0) {
          clearDragState();
        }
      }}
      onDrop={handleDrop}
      onMouseEnter={() => {
        if (!suppressHover) {
          setPasteActive(true);
        }
      }}
      onMouseLeave={() => {
        setPasteActive(false);
        setSuppressHover(false);
        window.clearTimeout(hoverSuppressTimerRef.current);
      }}
      onMouseMove={(event) => {
        if (!suppressHover) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const hasPointerLeft =
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom;
        if (hasPointerLeft) {
          setSuppressHover(false);
        }
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      <input
        ref={inputRef}
        accept="image/png,image/jpeg,image/webp"
        type="file"
        onChange={(event) => {
          pickFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {file && preview ? (
        <>
          <img src={preview.url} alt={`Source preview ${index + 1}`} />
          <Button className="slot-remove" variant="ghost" size="icon-sm" type="button" onClick={handleRemove} aria-label={`删除第 ${index + 1} 张图片`}>
            ×
          </Button>
          <div className="slot-meta">
            <strong>#{index + 1}</strong>
            <span title={file.name}>{file.name}</span>
            <small>{fileSizeLabel(file.size)}</small>
          </div>
        </>
      ) : (
        <div className="slot-empty" title="点击、拖入图片，或把鼠标悬停在此坑位后 Ctrl/Cmd+V 粘贴图片">
          <strong>#{index + 1}</strong>
          <span>点击 / 拖入</span>
          <small>可粘贴</small>
        </div>
      )}
      {dragActive && <div className="slot-drop-hint">放手置入</div>}
      {sortActive && <div className="slot-drop-hint">放手换位</div>}
    </div>
  );
}

function ImageViewer({ entry, notice, positionLabel, onClose, onNavigate, onCopy, onImport }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [pointerDown, setPointerDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const imageRef = useRef(null);
  const dragRef = useRef({
    active: false,
    moved: false,
    panning: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    originX: 0,
    originY: 0,
  });

  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setPointerDown(false);
    setPanning(false);
  }, [entry?.key]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.code === "Escape") {
        onClose();
        return;
      }
      if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName) || event.target?.isContentEditable) {
        return;
      }
      if (event.key?.toLowerCase() === "a" || event.key === "ArrowLeft") {
        event.preventDefault();
        onNavigate(-1);
        return;
      }
      if (event.key?.toLowerCase() === "d" || event.key === "ArrowRight") {
        event.preventDefault();
        onNavigate(1);
      }
    }

    function resetDragState() {
      dragRef.current = {
        active: false,
        moved: false,
        panning: false,
        pointerId: null,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0,
        originX: 0,
        originY: 0,
      };
      setPointerDown(false);
      setPanning(false);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", resetDragState);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", resetDragState);
      resetDragState();
    };
  }, [onClose, onNavigate]);

  function handleWheel(event) {
    event.preventDefault();
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return;

    const nextScaleFactor = event.deltaY < 0 ? 1.12 : 0.88;
    setScale((currentScale) => {
      const nextScale = Math.min(8, Math.max(0.25, currentScale * nextScaleFactor));
      const actualFactor = nextScale / currentScale;
      const anchorX = event.clientX - (rect.left + rect.width / 2);
      const anchorY = event.clientY - (rect.top + rect.height / 2);

      setOffset((currentOffset) => ({
        x: currentOffset.x - anchorX * (actualFactor - 1),
        y: currentOffset.y - anchorY * (actualFactor - 1),
      }));
      return nextScale;
    });
  }

  function handlePointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setPointerDown(true);
    dragRef.current = {
      active: true,
      moved: false,
      panning: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
  }

  function handlePointerMove(event) {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;

    drag.currentX = event.clientX;
    drag.currentY = event.clientY;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
      drag.moved = true;
      if (!drag.panning) {
        drag.panning = true;
        setPanning(true);
      }
    }
    if (!drag.panning) return;
    setOffset({ x: drag.originX + deltaX, y: drag.originY + deltaY });
  }

  function finishPointer(event) {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const shouldClose = !drag.panning && !drag.moved;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = {
      active: false,
      moved: false,
      panning: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      originX: 0,
      originY: 0,
    };
    setPointerDown(false);
    setPanning(false);
    if (shouldClose) {
      onClose();
      return;
    }
    window.setTimeout(() => {
      drag.moved = false;
    }, 0);
  }

  function cancelPointer(event) {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = {
      active: false,
      moved: false,
      panning: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      originX: 0,
      originY: 0,
    };
    setPointerDown(false);
    setPanning(false);
  }

  function handleViewerClick(event) {
    if (event.target !== event.currentTarget) return;
    onClose();
  }

  const canUseResultActions = entry?.kind === "result" && entry?.image;

  return (
    <div className="image-viewer" onClick={handleViewerClick} onWheel={handleWheel}>
      {notice && <div className="image-viewer-notice">{notice}</div>}
      <div className="image-viewer-toolbar" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
        {positionLabel && <span className="image-viewer-counter">{positionLabel}</span>}
        {canUseResultActions && (
          <div className="image-viewer-actions">
            <a
              href={entry.src}
              download={createImageDownloadFilename({
                imageIndex: entry.imageIndex,
                outputFormat: entry.outputFormat,
                generatedAt: entry.generatedAt,
              })}
            >
              下载
            </a>
            <button type="button" onClick={() => onCopy?.(entry.image, entry.outputFormat)}>
              复制
            </button>
            <button type="button" onClick={() => onImport?.(entry.image, entry.outputFormat)}>
              导入
            </button>
          </div>
        )}
      </div>
      <div
        className="image-viewer-frame"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        }}
      >
        <img
          ref={imageRef}
          className={`image-viewer-img ${pointerDown ? "is-pressing" : ""} ${panning ? "is-panning" : ""}`}
          src={entry?.src}
          alt={entry?.alt}
          draggable="false"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={cancelPointer}
        />
      </div>
    </div>
  );
}

function ImageResults({ images, outputFormat, generatedAt, loading, elapsedSeconds, onPreview, onCopy, onImport }) {
  if (loading) {
    return (
      <Card className="empty-state" size="sm">
        <CardHeader>
          <CardTitle>生成中</CardTitle>
          <CardDescription>{elapsedSeconds ? `请求进行中... ${elapsedSeconds}s` : "请求进行中..."}</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="mx-auto h-24 w-24 rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (!images.length) {
    return (
      <Card className="empty-state" size="sm">
        <CardHeader>
          <CardTitle>结果预览</CardTitle>
          <CardDescription>生成或编辑成功后，图片会显示在这里。</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="results-grid">
        {images.map((image) => {
          const src = buildImageSrc(image, outputFormat);
          const alt = `Result ${image.index + 1}`;
          return (
            <Card className="result-card" key={image.index} size="sm">
              <button className="result-image-button" type="button" onClick={() => onPreview?.(image)}>
                <img src={src} alt={alt} />
              </button>
              <div className="result-actions">
                <span>#{image.index + 1}</span>
                <div className="result-action-buttons">
                  <Button asChild variant="outline" size="sm">
                    <a href={src} download={createImageDownloadFilename({ imageIndex: image.index, outputFormat, generatedAt })}>下载</a>
                  </Button>
                  <Button variant="outline" size="sm" type="button" onClick={() => onCopy?.(image, outputFormat)}>
                    复制
                  </Button>
                  <Button variant="outline" size="sm" type="button" onClick={() => onImport?.(image, outputFormat)}>
                    导入
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
    </div>
  );
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function getHistoryStartedMs(item) {
  const startedMs = new Date(item?.startedAt || item?.createdAt || 0).getTime();
  return Number.isFinite(startedMs) ? startedMs : 0;
}

function getRunningHistoryDuration(item, now) {
  if (item?.status !== "running") return item?.durationMs;
  const startedMs = getHistoryStartedMs(item);
  return startedMs ? Math.max(0, now - startedMs) : item?.durationMs;
}

function workspaceMatchesHistoryItem(workspace, item) {
  const keys = [workspace?.historyId, workspace?.clientRequestId].filter(Boolean);
  return keys.includes(item?.id) || keys.includes(item?.clientRequestId);
}

function isRateLimitError(error) {
  return error?.code === "rate_limit_exceeded" || /rate limit|exceeded the call rate limit|retry after/i.test(error?.message || "");
}

function getRetryAfter(error) {
  const explicit = Number(error?.retryAfter || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromMessage = Number(/retry after\s+(\d+)\s+seconds?/i.exec(error?.message || "")?.[1] || 0);
  return Number.isFinite(fromMessage) && fromMessage > 0 ? fromMessage : 0;
}

function isLocalTimeoutError(error) {
  return error?.code === "upstream_timeout";
}

function isGatewayTimeoutError(error) {
  return error?.status === 504 || /gateway\s+time[-\s]?out/i.test(error?.message || "");
}

function isUpstreamOperationTimeoutError(error) {
  return /operation was timeout|timed out|time[-\s]?out|timeout/i.test(error?.message || "");
}

function formatSubmitError(error) {
  if (isLocalTimeoutError(error)) {
    return "本地等待图片服务超过 60 分钟，已自动停止。可以降低数量、尺寸或质量后重试。";
  }
  if (isGatewayTimeoutError(error)) {
    return "上游服务网关超时了。通常是图片服务或中转 API 在完成前断开；可以降低数量、尺寸或质量后重试。";
  }
  if (isUpstreamOperationTimeoutError(error)) {
    return "上游图片服务处理超时了。可以稍后重试，或降低数量、尺寸、质量后重试。";
  }
  return error.message;
}

function historyStatusLabel(status) {
  if (status === "success") return "成功";
  if (status === "running") return "生成中";
  if (status === "canceled") return "已取消";
  return "失败";
}

function historyStatusVariant(status) {
  if (status === "failed") return "destructive";
  if (status === "running") return "default";
  return "secondary";
}

function HistoryPanel({
  history,
  error,
  hasMore,
  loadingMore,
  total,
  onLoadMore,
  onView,
  onEdit,
  onDelete,
  onCancel,
  onPreview,
  onImportResult,
  onImportSource,
}) {
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const historyListRef = useRef(null);
  const loadMoreRef = useRef(null);

  function confirmDelete(item) {
    setPendingDeleteId(null);
    onDelete(item);
  }

  function scrollHistoryToTop() {
    historyListRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    if (!hasMore || !onLoadMore) return undefined;
    const target = loadMoreRef.current;
    if (!target) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onLoadMore();
      },
      { root: target.closest(".history-list"), rootMargin: "160px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  return (
    <aside className="history-panel">
        <div className="history-header">
          <div>
            <h2>历史记录</h2>
            <span>{total ? `${history.length} / ${total} 条` : `${history.length} 条`}</span>
          </div>
        </div>

        {error && (
          <div className="history-empty history-empty-error">
            <strong>历史加载失败</strong>
            <span>{error}</span>
          </div>
        )}

        {!error && !history.length && (
          <div className="history-empty">
            <strong>暂无记录</strong>
            <span>生成、改图、失败请求都会保存在这里。</span>
          </div>
        )}

        <div className="history-list" ref={historyListRef}>
          {history.map((item) => (
            <Card className="history-item" key={item.id} size="sm">
              <div className="history-meta">
                <Badge className="status-pill" variant={historyStatusVariant(item.status)}>
                  {historyStatusLabel(item.status)}
                </Badge>
                <span>{item.mode === "generate" ? "生图" : "改图"}</span>
                <span>{item.config?.resolvedSize || item.config?.size}</span>
                <span>{formatDate(item.createdAt)}</span>
                <span>{formatDuration(item.durationMs)}</span>
              </div>
              <p>{item.config?.prompt || item.error?.message || "无 prompt"}</p>
              {!!item.images?.length && (
                <div className="history-thumbs">
                  {item.images.slice(0, 4).map((image) => {
                    const src = buildImageSrc(image, item.config?.outputFormat || "png");
                    const alt = `历史结果 ${image.index + 1}`;
                    return (
                      <div className="history-thumb-wrap" key={image.index}>
                        <button className="history-thumb-button" type="button" onClick={() => onPreview(item, "result", image.index)}>
                          <img src={src} alt={alt} loading="lazy" />
                        </button>
                        <Button
                          className="history-thumb-import"
                          variant="outline"
                          size="xs"
                          type="button"
                          aria-label={`导入历史结果 ${image.index + 1}`}
                          onClick={() => onImportResult(image, item.config?.outputFormat || "png")}
                        >
                          导入
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              {!!item.source?.images?.length && (
                <div className="history-source-thumbs">
                  {item.source.images.slice(0, 5).map((image, index) => {
                    const alt = `历史参考图 ${index + 1}`;
                    return (
                      <div className="history-thumb-wrap" key={image.id || index}>
                        <button className="history-thumb-button" type="button" onClick={() => onPreview(item, "source", index)}>
                          <img src={image.url} alt={alt} loading="lazy" />
                        </button>
                        <Button
                          className="history-thumb-import"
                          variant="outline"
                          size="xs"
                          type="button"
                          aria-label={`导入历史参考图 ${index + 1}`}
                          onClick={() => onImportSource(image, index)}
                        >
                          导入
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              {item.error?.message && (
                <div className="history-error">
                  {isRateLimitError(item.error)
                    ? `限流：建议等待 ${getRetryAfter(item.error) || 60}s 后再试。`
                    : formatSubmitError(item.error)}
                </div>
              )}
              <div className="history-actions">
                <Button variant="outline" size="sm" type="button" onClick={() => onView(item)}>
                  查看
                </Button>
                <Button variant="outline" size="sm" type="button" onClick={() => onEdit(item)}>
                  再次编辑
                </Button>
                {item.status === "running" ? (
                  <Button variant="outline" size="sm" type="button" onClick={() => onCancel(item)}>
                    取消
                  </Button>
                ) : (
                  <AlertDialog open={pendingDeleteId === item.id} onOpenChange={(open) => setPendingDeleteId(open ? item.id : null)}>
                    <Button variant="outline" size="sm" type="button" onClick={() => setPendingDeleteId(item.id)}>
                      删除
                    </Button>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>确认删除？</AlertDialogTitle>
                        <AlertDialogDescription>这条历史记录会被移除。</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction variant="outline" onClick={() => confirmDelete(item)}>
                          确认删除
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </Card>
          ))}
          {(hasMore || loadingMore) && (
            <Button className="history-load-more" variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore} ref={loadMoreRef} type="button">
              {loadingMore ? "加载中..." : "加载更多"}
            </Button>
          )}
        </div>
        {!!history.length && (
          <Button
            className="history-back-top"
            variant="outline"
            size="icon-sm"
            type="button"
            aria-label="返回历史顶部"
            onClick={scrollHistoryToTop}
          >
            <ArrowUpIcon aria-hidden="true" />
          </Button>
        )}
    </aside>
  );
}

function PanelResizeHandle({ label, onResizeStart }) {
  return (
    <Button
      className="panel-resize-handle"
      variant="ghost"
      size="icon"
      type="button"
      aria-label={`调整${label}宽度`}
      onPointerDown={onResizeStart}
      tabIndex={-1}
    />
  );
}

function App({ initialSettings }) {
  const savedSettingsRef = useRef(initialSettings || loadSavedSettings());
  const initialWorkspaceRef = useRef(null);
  if (!initialWorkspaceRef.current) {
    initialWorkspaceRef.current = createWorkspace({
      mode: "generate",
      config: savedSettingsRef.current.config,
    });
  }

  const [workspaces, setWorkspaces] = useState(() => [initialWorkspaceRef.current]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(initialWorkspaceRef.current.id);
  const [previewWorkspaceId, setPreviewWorkspaceId] = useState(initialWorkspaceRef.current.id);
  const [history, setHistory] = useState([]);
  const [historyNextCursor, setHistoryNextCursor] = useState(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyError, setHistoryError] = useState("");
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [settingsReady, setSettingsReady] = useState(savedSettingsRef.current.source !== "default");
  const [panelWidths, setPanelWidths] = useState(loadSavedPanelWidths);
  const [clockNow, setClockNow] = useState(Date.now());
  const [viewerIndex, setViewerIndex] = useState(null);
  const [viewerMode, setViewerMode] = useState(null);
  const [viewerItemId, setViewerItemId] = useState(null);
  const [viewerNotice, setViewerNotice] = useState("");
  const [adHocViewerEntries, setAdHocViewerEntries] = useState(null);
  const [submitLockedUntil, setSubmitLockedUntil] = useState(0);
  const [imageDimensions, setImageDimensions] = useState(createEmptyImageSlots);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerEditorOpen, setProviderEditorOpen] = useState(false);
  const [provider, setProvider] = useState(() => savedSettingsRef.current.provider || { baseUrl: "", hasApiKey: false, source: "env" });
  const [providerProfiles, setProviderProfiles] = useState(() => savedSettingsRef.current.providerProfiles || []);
  const [providerDraft, setProviderDraft] = useState(() => createProviderDraft(savedSettingsRef.current.provider));
  const [providerBusy, setProviderBusy] = useState("");
  const [providerResult, setProviderResult] = useState(null);
  const [attentionPending, setAttentionPending] = useState(false);
  const [referenceDraftReady, setReferenceDraftReady] = useState(false);
  const activeRequestsRef = useRef(new Map());
  const canceledRequestsRef = useRef(new Set());
  const completionReminderBatchRef = useRef(createCompletionReminderBatch());
  const workspacesRef = useRef(workspaces);
  const [imagePreviews, setImagePreviews] = useState(createEmptyImageSlots);
  const resizeDragRef = useRef(null);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) || workspaces[0];
  const previewWorkspace = workspaces.find((workspace) => workspace.id === previewWorkspaceId) || activeWorkspace;
  const config = activeWorkspace?.config || initialConfig;
  const imageSlots = activeWorkspace?.imageSlots || createEmptyImageSlots();
  const imageFiles = imageSlots.filter(Boolean);
  const mode = imageFiles.length ? "edit" : "generate";
  const previewImages = previewWorkspace?.images || [];
  const previewOutputFormat = previewWorkspace?.config?.outputFormat || config.outputFormat;
  const previewLoading = Boolean(previewWorkspace?.loading);
  const previewElapsedSeconds =
    previewLoading && previewWorkspace?.startedAt ? Math.max(1, Math.floor((clockNow - previewWorkspace.startedAt) / 1000)) : 0;
  const rateLimitRemaining = activeWorkspace?.rateLimitUntil
    ? Math.max(0, Math.ceil((activeWorkspace.rateLimitUntil - clockNow) / 1000))
    : 0;
  const submitLockRemaining = Math.max(0, submitLockedUntil - clockNow);
  const syncedHistoryKeys = new Set(
    history.flatMap((item) => [item.id, item.clientRequestId].filter(Boolean)),
  );
  const localProcessHistory = workspaces
    .filter((workspace) => {
      if (workspace.previewOnly) return false;
      if (!workspace.submittedAt || !["running", "canceled", "success", "failed"].includes(workspace.statusKind)) {
        return false;
      }
      return !syncedHistoryKeys.has(workspace.historyId) && !syncedHistoryKeys.has(workspace.clientRequestId);
    })
    .map((workspace) => {
      const snapshot = workspace.submittedSnapshot || {};
      return {
        id: workspace.historyId || workspace.id,
        workspaceId: workspace.id,
        local: true,
        mode: snapshot.mode || workspace.mode,
        status: workspace.statusKind,
        createdAt: workspace.submittedAt || workspace.createdAt,
        completedAt: workspace.completedAt || workspace.submittedAt || workspace.createdAt,
        durationMs:
          workspace.statusKind === "running" && workspace.startedAt
            ? Math.max(0, clockNow - workspace.startedAt)
            : workspace.durationMs,
        config: snapshot.config || {
          ...workspace.config,
          resolvedSize: getResolvedSize(workspace.config, workspace.mode, workspace.id === activeWorkspaceId ? imageDimensions : []),
        },
        source: snapshot.source || workspace.sourceSnapshot,
        images: workspace.statusKind === "success" ? workspace.images : [],
        error: workspace.error ? { message: workspace.error } : undefined,
      };
    });
  const serverHistory = history.map((item) => ({
    ...item,
    durationMs: getRunningHistoryDuration(item, clockNow),
  }));
  const visibleHistory = [...localProcessHistory, ...serverHistory].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const resultViewerEntries = visibleHistory.flatMap(getHistoryResultEntries);
  const sourceViewerItem = visibleHistory.find((item) => item.id === viewerItemId || item.clientRequestId === viewerItemId);
  const sourceViewerEntries = sourceViewerItem ? getHistorySourceEntries(sourceViewerItem) : [];
  const activeViewerEntries = adHocViewerEntries || (viewerMode === "source" ? sourceViewerEntries : resultViewerEntries);
  const viewerEntry = Number.isInteger(viewerIndex) ? activeViewerEntries[viewerIndex] : null;
  const viewerPositionLabel =
    viewerEntry && viewerEntry.total ? `${viewerEntry.imageIndex + 1}/${viewerEntry.total}` : "";
  const hasRunningHistory = history.some((item) => item.status === "running");
  const hasLoadingWorkspace = workspaces.some((workspace) => workspace.loading);
  const anyLiveTimer =
    submitLockRemaining > 0 ||
    workspaces.some((workspace) => workspace.loading || (workspace.rateLimitUntil && workspace.rateLimitUntil > clockNow)) ||
    hasRunningHistory;
  const workspaceStyle = {
    "--control-panel-width": `${panelWidths.control}px`,
    "--preview-panel-width": `${panelWidths.preview}px`,
    "--history-panel-width": `${panelWidths.history}px`,
  };

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    const reminderTasks = visibleHistory.map((item) => ({
      key: item.id || item.clientRequestId || item.workspaceId,
      status: item.status,
      imageCount: item.status === "success" ? item.images?.length || 0 : 0,
    }));
    const result = updateCompletionReminderBatch(completionReminderBatchRef.current, reminderTasks);
    completionReminderBatchRef.current = result.batch;
    if (result.shouldNotify) {
      notifyGenerationComplete(result.imageCount);
    }
  }, [visibleHistory]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    if (!attentionPending) {
      document.title = DEFAULT_DOCUMENT_TITLE;
      return undefined;
    }

    let frameIndex = 0;
    document.title = ATTENTION_DOCUMENT_TITLE_FRAMES[frameIndex] || ATTENTION_DOCUMENT_TITLE;
    const timer = window.setInterval(() => {
      frameIndex = (frameIndex + 1) % ATTENTION_DOCUMENT_TITLE_FRAMES.length;
      document.title = ATTENTION_DOCUMENT_TITLE_FRAMES[frameIndex] || ATTENTION_DOCUMENT_TITLE;
    }, 110);

    return () => {
      window.clearInterval(timer);
      document.title = DEFAULT_DOCUMENT_TITLE;
    };
  }, [attentionPending]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    function clearAttentionIfSeen() {
      if (!pageNeedsAttention(document)) {
        setAttentionPending(false);
      }
    }

    document.title = DEFAULT_DOCUMENT_TITLE;
    clearAttentionIfSeen();
    document.addEventListener("visibilitychange", clearAttentionIfSeen);
    window.addEventListener("focus", clearAttentionIfSeen);
    return () => {
      document.removeEventListener("visibilitychange", clearAttentionIfSeen);
      window.removeEventListener("focus", clearAttentionIfSeen);
    };
  }, []);

  useEffect(() => {
    savePanelWidthsLocally(panelWidths);
  }, [panelWidths]);

  useEffect(() => {
    if (workspaces.some((workspace) => workspace.id === previewWorkspaceId)) return;
    setPreviewWorkspaceId(activeWorkspaceId);
  }, [activeWorkspaceId, previewWorkspaceId, workspaces]);

  useEffect(() => {
    const previews = imageSlots.map((file) => (file ? { url: URL.createObjectURL(file) } : null));
    setImagePreviews(previews);
    return () => {
      previews.forEach((preview) => {
        if (preview) URL.revokeObjectURL(preview.url);
      });
    };
  }, [imageSlots]);

  useEffect(() => {
    let canceled = false;
    Promise.all(imageSlots.map((file) => readImageDimensions(file).catch(() => null))).then((dimensions) => {
      if (!canceled) {
        setImageDimensions(dimensions);
      }
    });
    return () => {
      canceled = true;
    };
  }, [imageSlots]);

  useEffect(() => {
    return () => {
      activeRequestsRef.current.forEach(({ controller, timeoutId }) => {
        window.clearTimeout(timeoutId);
        controller.abort();
      });
      workspacesRef.current.forEach((workspace) => cleanupSourceSnapshot(workspace.sourceSnapshot));
    };
  }, []);

  useEffect(() => {
    loadHistory().catch((error) => {
      setHistoryError(error.message || "历史接口请求失败。");
    });
    loadProviderSettings();
    if (savedSettingsRef.current.source === "default") {
      loadSavedSettingsFromServer();
    } else {
      setSettingsReady(true);
    }
    loadReferenceImageDraft(MAX_EDIT_IMAGES)
      .then((savedSlots) => {
        if (!savedSlots.some(Boolean)) return;
        updateWorkspace(initialWorkspaceRef.current.id, (workspace) => ({
          ...workspace,
          mode: "edit",
          imageSlots: savedSlots,
        }));
      })
      .catch(() => {})
      .finally(() => setReferenceDraftReady(true));
  }, []);

  useEffect(() => {
    if (!settingsReady || !activeWorkspace) return;
    const settings = { mode, config: activeWorkspace.config };
    const savedLocally = saveSettingsLocally(settings);
    if (!savedLocally) {
      saveSettingsToServer(settings);
    }
  }, [mode, activeWorkspace?.config, settingsReady]);

  useEffect(() => {
    if (!referenceDraftReady || !activeWorkspace || activeWorkspace.previewOnly) return;
    saveReferenceImageDraft(activeWorkspace.imageSlots).catch(() => {});
  }, [activeWorkspace?.imageSlots, activeWorkspace?.previewOnly, referenceDraftReady]);

  useEffect(() => {
    if (!anyLiveTimer) return undefined;
    const timer = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [anyLiveTimer]);

  useEffect(() => {
    if (!hasRunningHistory && !hasLoadingWorkspace) return undefined;
    const poller = window.setInterval(() => {
      loadHistory().catch(() => {});
    }, 2000);
    return () => window.clearInterval(poller);
  }, [hasRunningHistory, hasLoadingWorkspace]);

  useEffect(() => {
    if (viewerIndex === null) return;
    if (!activeViewerEntries.length) {
      setViewerIndex(null);
      setAdHocViewerEntries(null);
      setViewerMode(null);
      setViewerItemId(null);
      setViewerNotice("");
      return;
    }
    if (viewerIndex >= activeViewerEntries.length) {
      setViewerIndex(activeViewerEntries.length - 1);
    }
  }, [activeViewerEntries.length, viewerIndex]);

  useEffect(() => {
    if (!viewerNotice) return undefined;
    const timer = window.setTimeout(() => setViewerNotice(""), 1400);
    return () => window.clearTimeout(timer);
  }, [viewerNotice]);

  function showToast(message, tone = "success", duration = 1800) {
    if (!message) return;
    const options = { duration };
    if (tone === "error") {
      toast.error(message, options);
      return;
    }
    if (tone === "warning") {
      toast.warning(message, options);
      return;
    }
    if (tone === "info") {
      toast.info(message, options);
      return;
    }
    toast.success(message, options);
  }

  function ensureBrowserNotificationPermission() {
    if (typeof window === "undefined") return;
    requestBrowserNotificationPermission(window);
  }

  function notifyGenerationComplete(imageCount = 0) {
    if (typeof window !== "undefined") {
      sendBrowserCompletionNotification(imageCount, window);
    }
    if (typeof document !== "undefined" && pageNeedsAttention(document)) {
      setAttentionPending(true);
    }
  }

  useEffect(() => {
    function handlePointerMove(event) {
      const drag = resizeDragRef.current;
      if (!drag) return;
      const limits = panelWidthLimits[drag.panelKey];
      const nextWidth = clamp(drag.startWidth + event.clientX - drag.startX, limits.min, limits.max);
      setPanelWidths((current) => ({
        ...current,
        [drag.panelKey]: nextWidth,
      }));
    }

    function stopResize() {
      if (!resizeDragRef.current) return;
      resizeDragRef.current = null;
      document.body.classList.remove("is-resizing-panel");
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    window.addEventListener("blur", stopResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      window.removeEventListener("blur", stopResize);
      stopResize();
    };
  }, []);

  function updateWorkspace(workspaceId, updater) {
    setWorkspaces((current) =>
      current.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        return typeof updater === "function" ? updater(workspace) : { ...workspace, ...updater };
      }),
    );
  }

  function updateActiveWorkspace(updater) {
    if (!activeWorkspaceId) return;
    updateWorkspace(activeWorkspaceId, updater);
  }

  function startPanelResize(panelKey, event) {
    event.preventDefault();
    event.stopPropagation();
    resizeDragRef.current = {
      panelKey,
      startX: event.clientX,
      startWidth: panelWidths[panelKey],
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add("is-resizing-panel");
  }

  function updateConfig(key, value) {
    updateActiveWorkspace((workspace) => ({
      ...workspace,
      config: {
        ...workspace.config,
        [key]: value,
      },
    }));
  }

  function setImageSlot(index, files) {
    const nextFiles = Array.isArray(files) ? files : [files];
    updateActiveWorkspace((workspace) => {
      const nextSlots = [...workspace.imageSlots];
      nextFiles.slice(0, MAX_EDIT_IMAGES - index).forEach((file, fileIndex) => {
        nextSlots[index + fileIndex] = file;
      });
      return {
        ...workspace,
        mode: "edit",
        imageSlots: nextSlots,
        status: "",
      };
    });
  }

  function importImageFilesToEmptySlots(files) {
    const nextFiles = (Array.isArray(files) ? files : [files]).filter(Boolean);
    if (!nextFiles.length) return 0;

    const availableSlots = imageSlots.filter((slot) => !slot).length;
    const importedCount = Math.min(availableSlots, nextFiles.length);
    if (!importedCount) return 0;

    updateActiveWorkspace((workspace) => {
      const nextSlots = [...workspace.imageSlots];
      nextFiles.forEach((file) => {
        const emptyIndex = nextSlots.findIndex((slot) => !slot);
        if (emptyIndex < 0) return;
        nextSlots[emptyIndex] = file;
      });

      return {
        ...workspace,
        mode: "edit",
        imageSlots: nextSlots,
        status: "",
      };
    });
    return importedCount;
  }

  function removeImageSlot(index) {
    updateActiveWorkspace((workspace) => {
      const nextSlots = workspace.imageSlots.map((item, itemIndex) => (itemIndex === index ? null : item));
      return {
        ...workspace,
        mode: nextSlots.some(Boolean) ? "edit" : "generate",
        imageSlots: nextSlots,
      };
    });
  }

  function moveImageSlot(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    updateActiveWorkspace((workspace) => {
      const nextSlots = [...workspace.imageSlots];
      if (!nextSlots[fromIndex]) return workspace;
      const sourceFile = nextSlots[fromIndex];
      nextSlots[fromIndex] = nextSlots[toIndex] || null;
      nextSlots[toIndex] = sourceFile;
      return {
        ...workspace,
        mode: nextSlots.some(Boolean) ? "edit" : "generate",
        imageSlots: nextSlots,
        status: "",
      };
    });
  }

  function getSelectedImageFiles(workspace = activeWorkspace) {
    return (workspace?.imageSlots || []).filter(Boolean);
  }

  async function readApiJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiError = new Error(data?.error?.message || "Request failed.");
      apiError.status = response.status;
      apiError.code = data?.error?.code;
      apiError.retryAfter = Number(data?.error?.retryAfter || response.headers.get("retry-after") || 0);
      throw apiError;
    }
    return data;
  }

  async function loadHistory() {
    const response = await fetch(`/api/history?limit=${HISTORY_PAGE_SIZE}`);
    const data = await readApiJson(response);
    const items = data.items || [];
    setHistoryError("");
    setHistory(items);
    setHistoryNextCursor(data.nextCursor || null);
    setHistoryHasMore(Boolean(data.hasMore));
    setHistoryTotal(Number(data.total || items.length));
    syncWorkspacesWithHistory(items);
    return items;
  }

  async function loadMoreHistory() {
    if (!historyHasMore || historyLoadingMore || !historyNextCursor) return [];
    setHistoryLoadingMore(true);
    try {
      const response = await fetch(`/api/history?limit=${HISTORY_PAGE_SIZE}&cursor=${encodeURIComponent(historyNextCursor)}`);
      const data = await readApiJson(response);
      const items = data.items || [];
      setHistoryError("");
      setHistory((current) => {
        const existingIds = new Set(current.map((item) => item.id));
        return [...current, ...items.filter((item) => !existingIds.has(item.id))];
      });
      setHistoryNextCursor(data.nextCursor || null);
      setHistoryHasMore(Boolean(data.hasMore));
      setHistoryTotal(Number(data.total || historyTotal || history.length + items.length));
      syncWorkspacesWithHistory(items);
      return items;
    } catch (error) {
      setHistoryError(error.message || "历史接口请求失败。");
      throw error;
    } finally {
      setHistoryLoadingMore(false);
    }
  }

  function syncWorkspacesWithHistory(items) {
    const itemByHistoryKey = new Map();
    items.forEach((item) => {
      [item.id, item.clientRequestId].filter(Boolean).forEach((key) => itemByHistoryKey.set(key, item));
    });

    setWorkspaces((current) =>
      current.map((workspace) => {
        const item = itemByHistoryKey.get(workspace.historyId) || itemByHistoryKey.get(workspace.clientRequestId);
        if (!item) return workspace;
        if (workspace.previewOnly) {
          const nextStatusKind = item.status || "failed";
          const nextIsRunning = nextStatusKind === "running";
          return {
            ...workspace,
            mode: item.mode || workspace.mode,
            config: {
              ...initialConfig,
              ...(item.config || workspace.config),
            },
            loading: nextIsRunning,
            statusKind: nextStatusKind,
            images: nextStatusKind === "success" ? item.images || [] : [],
            error: item.error?.message ? formatSubmitError(item.error) : "",
            status: nextStatusKind === "success" ? `完成：收到 ${item.images?.length || 0} 张图片。` : "",
            submittedAt: item.startedAt || item.createdAt || workspace.submittedAt,
            startedAt: nextIsRunning ? getHistoryStartedMs(item) || workspace.startedAt || Date.now() : null,
            durationMs: nextIsRunning ? null : item.durationMs ?? workspace.durationMs,
            clientRequestId: item.clientRequestId || item.id || workspace.clientRequestId,
            historyId: item.id || workspace.historyId,
          };
        }

        const nextStatusKind = item.status || "failed";
        const nextIsRunning = nextStatusKind === "running";
        const nextStartedAt = getHistoryStartedMs(item) || workspace.startedAt || Date.now();
        const nextImages = item.images || [];
        const nextError = item.error?.message
          ? isRateLimitError(item.error)
            ? `历史记录：上游限流，建议等待 ${getRetryAfter(item.error) || 60}s 后重试。`
            : formatSubmitError(item.error)
          : "";
        const nextStatus =
          nextStatusKind === "success"
            ? `完成：收到 ${nextImages.length} 张图片。`
            : nextStatusKind === "running"
              ? workspace.status || "请求进行中。"
              : nextStatusKind === "canceled"
                ? "已取消"
                : "";

        return {
          ...workspace,
          loading: nextIsRunning,
          statusKind: nextStatusKind,
          images: nextStatusKind === "success" ? nextImages : [],
          error: nextError,
          status: nextStatus,
          submittedAt: item.startedAt || item.createdAt || workspace.submittedAt,
          startedAt: nextIsRunning ? nextStartedAt : workspace.startedAt,
          durationMs: nextIsRunning ? null : item.durationMs ?? workspace.durationMs,
          historyId: item.id || workspace.historyId,
          clientRequestId: item.clientRequestId || item.id || workspace.clientRequestId,
          rateLimitUntil: 0,
        };
      }),
    );
  }

  function clearDeletedHistoryLocally(deletedItem) {
    const deletedKeys = new Set([deletedItem?.id, deletedItem?.clientRequestId].filter(Boolean));
    if (!deletedKeys.size) return;

    setWorkspaces((current) => {
      const remaining = [];
      current.forEach((workspace) => {
        const workspaceKeys = [workspace.historyId, workspace.clientRequestId].filter(Boolean);
        const matchesDeleted = workspaceKeys.some((key) => deletedKeys.has(key));
        if (!matchesDeleted) {
          remaining.push(workspace);
          return;
        }
        cleanupSourceSnapshot(workspace.sourceSnapshot);
        if (workspace.submittedSnapshot?.source !== workspace.sourceSnapshot) {
          cleanupSourceSnapshot(workspace.submittedSnapshot?.source);
        }
        if (workspace.previewOnly) return;
        remaining.push({
          ...workspace,
          images: [],
          error: "",
          status: "",
          statusKind: "idle",
          loading: false,
          submittedAt: null,
          startedAt: null,
          durationMs: null,
          clientRequestId: null,
          historyId: null,
          previewOnly: false,
          rateLimitUntil: 0,
          sourceSnapshot: null,
          submittedSnapshot: null,
        });
      });

      if (remaining.length) return remaining;
      return [createRefreshWorkspace(config.model)];
    });
  }

  async function loadSavedSettingsFromServer() {
    try {
      const data = await requestJson("/api/settings");
      if (data.settings?.config) {
        updateWorkspace(initialWorkspaceRef.current.id, (workspace) => ({
          ...workspace,
          mode: "generate",
          config: {
            ...initialConfig,
            ...data.settings.config,
          },
        }));
      }
    } catch {
      // Settings persistence is a convenience; the app should still run without it.
    } finally {
      setSettingsReady(true);
    }
  }

  async function saveSettingsToServer(settings) {
    try {
      await requestJson("/api/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(settings),
      });
    } catch {
      // Ignore persistence failures while the user is editing controls.
    }
  }

  function applyProviderPayload(data, { resetDraft = true } = {}) {
    if (data.provider) {
      setProvider(data.provider);
      if (resetDraft) {
        setProviderDraft(createProviderDraft(data.provider));
      }
    }
    if (Array.isArray(data.profiles)) {
      setProviderProfiles(data.profiles);
    } else {
      const fallbackProfile = providerProfileFromProvider(data.provider);
      if (fallbackProfile) {
        setProviderProfiles([fallbackProfile]);
      }
    }
  }

  async function loadProviderSettings() {
    try {
      const data = await requestJson("/api/provider-settings");
      if (!data.provider) return;
      applyProviderPayload(data);
    } catch {
      // Provider settings can still be entered manually if loading fails.
    }
  }

  function providerDraftHasSavedKey() {
    return Boolean(providerDraft.id && providerProfiles.some((profile) => profile.id === providerDraft.id && profile.hasApiKey));
  }

  async function verifyProviderSettings() {
    if (!providerDraft.baseUrl.trim() || (!providerDraft.apiKey.trim() && !providerDraftHasSavedKey())) {
      setProviderResult({ tone: "error", message: "请先填写 Base URL 和 Key。" });
      return;
    }
    setProviderBusy("verify");
    setProviderResult(null);
    try {
      await requestJson("/api/provider-settings/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(providerDraft),
      });
      setProviderResult({ tone: "success", message: "验证通过：已找到 gpt-image-2。" });
      showToast("验证通过：已找到 gpt-image-2。", "success");
    } catch (error) {
      const message = error.message || "验证失败。";
      setProviderResult({ tone: "error", message });
      showToast(message, "error", 2600);
    } finally {
      setProviderBusy("");
    }
  }

  async function saveProviderSettings() {
    if (!providerDraft.baseUrl.trim() || (!providerDraft.apiKey.trim() && !providerDraftHasSavedKey())) {
      setProviderResult({ tone: "error", message: "请先填写 Base URL 和 Key。" });
      return;
    }
    setProviderBusy("save");
    setProviderResult(null);
    try {
      const data = await requestJson("/api/provider-settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(providerDraft),
      });
      if (data.provider) {
        applyProviderPayload(data);
      }
      setProviderResult({ tone: "success", message: "已保存。后续生成会使用这组配置。" });
      setProviderEditorOpen(false);
      showToast("模型设置已保存。", "success");
    } catch (error) {
      const message = error.message || "保存失败。";
      setProviderResult({ tone: "error", message });
      showToast(message, "error", 2600);
    } finally {
      setProviderBusy("");
    }
  }

  async function useProviderProfile(id) {
    setProviderResult(null);
    const profile = providerProfiles.find((item) => item.id === id);
    if (!profile) return;
    setProviderBusy("select");
    try {
      const data = await requestJson("/api/provider-settings/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });
      applyProviderPayload(data);
      showToast("已切换模型 Key。", "success");
    } catch (error) {
      const message = error.message || "切换失败。";
      setProviderResult({ tone: "error", message });
      showToast(message, "error", 2600);
    } finally {
      setProviderBusy("");
    }
  }

  function createNewProviderProfile() {
    setProviderResult(null);
    setProviderDraft(createProviderDraft());
    setProviderEditorOpen(true);
  }

  function editProviderProfile(profile) {
    setProviderResult(null);
    setProviderDraft(createProviderDraft(profile));
    setProviderEditorOpen(true);
  }

  async function deleteProviderProfile(id) {
    if (!id) return;
    setProviderBusy("delete");
    setProviderResult(null);
    try {
      const data = await requestJson(`/api/provider-settings/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      applyProviderPayload(data);
      if (providerDraft.id === id) {
        setProviderEditorOpen(false);
      }
      setProviderResult({ tone: "success", message: "已删除。" });
      showToast("模型 Key 已删除。", "success");
    } catch (error) {
      const message = error.message || "删除失败。";
      setProviderResult({ tone: "error", message });
      showToast(message, "error", 2600);
    } finally {
      setProviderBusy("");
    }
  }

  async function submitGenerate(workspaceConfig, clientRequestId, signal) {
    const response = await fetch("/api/generate", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...workspaceConfig,
        clientRequestId,
      }),
    });
    return readApiJson(response);
  }

  async function submitEdit(workspaceConfig, imageFiles, clientRequestId, signal) {
    if (!imageFiles.length) {
      throw new Error("请先上传至少一张原图或参考图。");
    }

    const formData = new FormData();
    Object.entries(workspaceConfig).forEach(([key, value]) => {
      formData.set(key, value);
    });
    formData.set("clientRequestId", clientRequestId);
    imageFiles.forEach((file) => {
      formData.append("image[]", file);
    });
    const response = await fetch("/api/edit", {
      method: "POST",
      signal,
      body: formData,
    });
    return readApiJson(response);
  }

  async function cancelHistoryJob(historyId) {
    if (!historyId) return null;
    const response = await fetch(`/api/history/${historyId}/cancel`, { method: "POST" });
    return readApiJson(response);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitLockedUntil > Date.now()) return;
    const workspace = workspacesRef.current.find((item) => item.id === activeWorkspaceId);
    if (!workspace) return;
    const lockedAt = Date.now();
    setClockNow(lockedAt);
    setSubmitLockedUntil(lockedAt + 1000);
    ensureBrowserNotificationPermission();

    const imageFiles = getSelectedImageFiles(workspace);
    const submissionMode = imageFiles.length ? "edit" : "generate";

    if (workspace.rateLimitUntil && workspace.rateLimitUntil > Date.now()) {
      showToast(`限流等待 ${Math.max(1, Math.ceil((workspace.rateLimitUntil - Date.now()) / 1000))}s`, "warning");
      return;
    }

    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = window.setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, CLIENT_TIMEOUT_MS);
    const requestId = createLocalId("request");
    const startedAt = Date.now();
    const workspaceDimensions = await Promise.all(workspace.imageSlots.map((file) => readImageDimensions(file).catch(() => null)));
    const baseConfig = {
      ...workspace.config,
      outputFormat: "png",
      background: "auto",
    };
    const workspaceConfig = resolveConfigForSubmission(baseConfig, submissionMode, workspaceDimensions);
    const sourceSnapshot = submissionMode === "edit" ? createLocalSourceSnapshot(imageFiles, null) : null;
    const submittedConfig = {
      ...baseConfig,
      resolvedSize: getResolvedSize(workspaceConfig, submissionMode),
    };
    const submittedSnapshot = {
      mode: submissionMode,
      config: submittedConfig,
      imageSlots: [...workspace.imageSlots],
      maskFile: null,
      maskOpen: false,
      source: sourceSnapshot,
    };
    const submissionWorkspace = createSubmissionWorkspace(
      workspace,
      submissionMode,
      submittedConfig,
      submittedSnapshot,
      sourceSnapshot,
      requestId,
      startedAt,
    );

    activeRequestsRef.current.set(submissionWorkspace.id, { controller, timeoutId, requestId });
    setWorkspaces((current) => [submissionWorkspace, ...current]);
    setClockNow(startedAt);
    setPreviewWorkspaceId(submissionWorkspace.id);
    showToast("请求进行中。", "info", 2200);

    try {
      const apiSubmissionConfig = createApiSubmissionConfig(baseConfig);
      const data =
        submissionMode === "generate"
          ? await submitGenerate(apiSubmissionConfig, requestId, controller.signal)
          : await submitEdit(apiSubmissionConfig, imageFiles, requestId, controller.signal);
      let shouldCleanupSourceSnapshot = true;
      const completedAt = new Date().toISOString();
      updateWorkspace(submissionWorkspace.id, (current) => {
        if (current.statusKind === "canceled") {
          shouldCleanupSourceSnapshot = false;
          return current;
        }
        return {
          ...current,
          loading: false,
          statusKind: "success",
          images: data.images || [],
          error: "",
          status: `完成：收到 ${data.images?.length || 0} 张图片。`,
          durationMs: Date.now() - startedAt,
          completedAt,
          historyId: data.historyId || null,
          sourceSnapshot: null,
        };
      });
      if (shouldCleanupSourceSnapshot) {
        cleanupSourceSnapshot(sourceSnapshot);
      }
      showToast(`完成：收到 ${data.images?.length || 0} 张图片。`, "success");
      await loadHistory();
    } catch (submitError) {
      const latestWorkspace = workspacesRef.current.find((item) => item.id === submissionWorkspace.id);
      if (
        submitError.name === "AbortError" &&
        (canceledRequestsRef.current.has(requestId) || latestWorkspace?.statusKind === "canceled")
      ) {
        return;
      }

      if (submitError.name === "AbortError") {
        cleanupSourceSnapshot(sourceSnapshot);
        showToast(didTimeout ? "请求超过 60 分钟，已自动停止。可以降低尺寸/质量后重试。" : "已取消", didTimeout ? "error" : "warning", didTimeout ? 2600 : 1800);
        updateWorkspace(submissionWorkspace.id, {
          loading: false,
          statusKind: didTimeout ? "failed" : "canceled",
          error: didTimeout ? "请求超过 60 分钟，已自动停止。可以降低尺寸/质量后重试。" : "",
          status: didTimeout ? "" : "已取消",
          images: [],
          durationMs: Date.now() - startedAt,
          historyId: requestId,
          sourceSnapshot: didTimeout ? null : sourceSnapshot,
        });
      } else if (submitError.status === 429 || submitError.code === "rate_limit_exceeded") {
        const retryAfter = Number.isFinite(submitError.retryAfter) && submitError.retryAfter > 0 ? submitError.retryAfter : 60;
        cleanupSourceSnapshot(sourceSnapshot);
        showToast(`触发上游限流，请等待 ${retryAfter}s 后再试。`, "warning", 2600);
        updateWorkspace(submissionWorkspace.id, {
          loading: false,
          statusKind: "failed",
          error: `触发上游限流，请等待 ${retryAfter}s 后再试。可以先降低数量、尺寸或质量。`,
          status: "",
          images: [],
          durationMs: Date.now() - startedAt,
          rateLimitUntil: Date.now() + retryAfter * 1000,
          historyId: requestId,
          sourceSnapshot: null,
        });
        await loadHistory().catch(() => {});
      } else {
        cleanupSourceSnapshot(sourceSnapshot);
        showToast(formatSubmitError(submitError), "error", 2600);
        updateWorkspace(submissionWorkspace.id, {
          loading: false,
          statusKind: "failed",
          error: formatSubmitError(submitError),
          status: "",
          images: [],
          durationMs: Date.now() - startedAt,
          historyId: requestId,
          sourceSnapshot: null,
        });
        await loadHistory().catch(() => {});
      }
    } finally {
      window.clearTimeout(timeoutId);
      activeRequestsRef.current.delete(submissionWorkspace.id);
      canceledRequestsRef.current.delete(requestId);
      await loadHistory().catch(() => {});
    }
  }

  async function cancelRequest(itemOrWorkspaceId = activeWorkspaceId) {
    const workspaceId = typeof itemOrWorkspaceId === "object" ? itemOrWorkspaceId.workspaceId || itemOrWorkspaceId.id : itemOrWorkspaceId;
    const historyId = typeof itemOrWorkspaceId === "object" ? itemOrWorkspaceId.id : null;
    const request = activeRequestsRef.current.get(workspaceId);
    if (request) {
      window.clearTimeout(request.timeoutId);
      canceledRequestsRef.current.add(request.requestId);
      request.controller.abort();
      activeRequestsRef.current.delete(workspaceId);
    }

    const workspace = workspacesRef.current.find((current) => current.id === workspaceId);
    const targetHistoryId = historyId || workspace?.historyId;
    if (targetHistoryId) {
      await cancelHistoryJob(targetHistoryId).catch(() => {});
    }

    const canceledAt = Date.now();
    updateWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      loading: false,
      statusKind: "canceled",
      status: "已取消",
      error: "",
      durationMs: workspace.startedAt ? canceledAt - workspace.startedAt : workspace.durationMs,
    }));
    showToast("已取消", "warning");
    await loadHistory().catch(() => {});
  }

  function createNewWorkspace() {
    const workspace = createRefreshWorkspace(config.model);
    setWorkspaces((current) => [workspace, ...current]);
    setActiveWorkspaceId(workspace.id);
  }

  function createPreviewWorkspaceFromHistory(item) {
    return createWorkspace({
      mode: item.mode || "generate",
      config: {
        ...initialConfig,
        ...(item.config || {}),
      },
      statusKind: item.status || "failed",
    });
  }

  function upsertHistoryPreviewWorkspace(item) {
    const existingWorkspace = workspacesRef.current.find(
      (workspace) => workspace.previewOnly && workspaceMatchesHistoryItem(workspace, item),
    );
    const isRunning = item.status === "running";
    const startedAt = getHistoryStartedMs(item) || Date.now();

    if (existingWorkspace) {
      updateWorkspace(existingWorkspace.id, {
        mode: item.mode || "generate",
        config: {
          ...initialConfig,
          ...(item.config || {}),
        },
        images: item.status === "success" ? item.images || [] : [],
        error: item.error?.message ? formatSubmitError(item.error) : "",
        status: item.status === "success" ? `完成：收到 ${item.images?.length || 0} 张图片。` : "",
        statusKind: item.status || "failed",
        loading: isRunning,
        submittedAt: item.startedAt || item.createdAt || null,
        completedAt: item.completedAt || item.createdAt || null,
        startedAt: isRunning ? startedAt : null,
        durationMs: isRunning ? null : item.durationMs ?? null,
        clientRequestId: item.clientRequestId || item.id,
        historyId: item.id,
        previewOnly: true,
        rateLimitUntil: 0,
      });
      setPreviewWorkspaceId(existingWorkspace.id);
      return existingWorkspace.id;
    }

    const workspace = createPreviewWorkspaceFromHistory(item);
    const nextWorkspace = {
      ...workspace,
      images: item.status === "success" ? item.images || [] : [],
      error: item.error?.message ? formatSubmitError(item.error) : "",
      status: item.status === "success" ? `完成：收到 ${item.images?.length || 0} 张图片。` : "",
      statusKind: item.status || "failed",
      loading: isRunning,
      submittedAt: item.startedAt || item.createdAt || null,
      completedAt: item.completedAt || item.createdAt || null,
      startedAt: isRunning ? startedAt : null,
      durationMs: isRunning ? null : item.durationMs ?? null,
      clientRequestId: item.clientRequestId || item.id,
      historyId: item.id,
      previewOnly: true,
    };
    setWorkspaces((current) => [nextWorkspace, ...current]);
    setPreviewWorkspaceId(nextWorkspace.id);
    return nextWorkspace.id;
  }

  function previewHistoryItem(item) {
    if (item.local) {
      const workspaceId = item.workspaceId || item.id;
      if (workspacesRef.current.some((workspace) => workspace.id === workspaceId)) {
        setPreviewWorkspaceId(workspaceId);
      }
      return;
    }
    upsertHistoryPreviewWorkspace(item);
  }

  function findViewerEntryIndex(item, kind, imageIndex = 0) {
    const entries = kind === "source" ? getHistorySourceEntries(item) : resultViewerEntries;
    const fallbackIndex = entries.findIndex((entry) => entry.itemId === item.id);
    const exactIndex = entries.findIndex((entry) => entry.itemId === item.id && entry.imageIndex === imageIndex);
    return exactIndex >= 0 ? exactIndex : fallbackIndex;
  }

  async function openHistoryImage(item, kind, imageIndex = 0) {
    const nextIndex = findViewerEntryIndex(item, kind, imageIndex);
    if (nextIndex < 0) return;
    setAdHocViewerEntries(null);
    setViewerMode(kind);
    setViewerItemId(kind === "source" ? item.id : null);
    setViewerNotice("");
    setViewerIndex(nextIndex);
    previewHistoryItem(item);
  }

  async function openActiveResultImage(image) {
    const historyId = previewWorkspace?.historyId || previewWorkspace?.clientRequestId;
    const item = visibleHistory.find((entry) => entry.id === historyId || entry.clientRequestId === historyId);
    if (!item) {
      const fallbackItem = {
        id: previewWorkspace?.id || "preview-workspace",
        mode: previewWorkspace?.mode || mode,
        config: previewWorkspace?.config || config,
        completedAt: previewWorkspace?.completedAt || previewWorkspace?.createdAt,
        createdAt: previewWorkspace?.createdAt,
        images: previewImages,
        source: previewWorkspace?.sourceSnapshot || null,
      };
      const fallbackEntries = getHistoryResultEntries(fallbackItem);
      const fallbackIndex = fallbackEntries.findIndex((entry) => entry.imageIndex === image.index);
      if (fallbackIndex >= 0) {
        setAdHocViewerEntries(fallbackEntries);
        setViewerMode("result");
        setViewerItemId(null);
        setViewerNotice("");
        setViewerIndex(fallbackIndex);
      }
      return;
    }
    await openHistoryImage(item, "result", image.index);
  }

  async function copyResultImage(image, imageOutputFormat = config.outputFormat) {
    try {
      await copyImageToClipboard(image, imageOutputFormat);
      showToast("已复制图片到剪贴板。", "success");
    } catch (copyError) {
      showToast(copyError.message || "复制失败。", "error");
    }
  }

  async function importResultImage(image, imageOutputFormat = config.outputFormat) {
    try {
      const file = await fileFromResultImage(image, imageOutputFormat);
      const importedCount = importImageFilesToEmptySlots([file]);
      showToast(importedCount ? "已导入到参考图空位。" : "参考图坑位已满，未覆盖已有图片。", importedCount ? "success" : "warning");
    } catch (importError) {
      showToast(importError.message || "导入失败。", "error");
    }
  }

  async function importSourceAsset(asset, index = 0) {
    try {
      const file = await fileFromAsset(asset, `reference-${index + 1}.png`);
      const importedCount = importImageFilesToEmptySlots([file]);
      showToast(importedCount ? "已导入到参考图空位。" : "参考图坑位已满，未覆盖已有图片。", importedCount ? "success" : "warning");
    } catch (importError) {
      showToast(importError.message || "导入失败。", "error");
    }
  }

  async function navigateViewer(direction) {
    if (!activeViewerEntries.length || viewerIndex === null) return;
    const nextIndex = viewerIndex + direction;
    if (nextIndex < 0) {
      setViewerNotice("已是第一张");
      return;
    }
    if (nextIndex >= activeViewerEntries.length) {
      setViewerNotice("已是最后一张");
      return;
    }
    const nextEntry = activeViewerEntries[nextIndex];
    const currentEntry = activeViewerEntries[viewerIndex];
    setViewerNotice("");
    setViewerIndex(nextIndex);
    if (viewerMode === "result" && !adHocViewerEntries && nextEntry?.item && nextEntry.itemId !== currentEntry?.itemId) {
      previewHistoryItem(nextEntry.item);
    }
  }

  async function loadHistoryItem(item) {
    const active = workspacesRef.current.find((workspace) => workspace.id === activeWorkspaceId);
    const reusableActive = active && !active.loading && !active.previewOnly;
    let targetId = reusableActive ? active.id : null;
    const targetBeforeLoad = reusableActive ? active : null;

    if (!targetId) {
      const workspace = createWorkspace({
        mode: item.mode || "generate",
        config: {
          ...initialConfig,
          ...(item.config || {}),
        },
      });
      targetId = workspace.id;
      setWorkspaces((current) => [workspace, ...current]);
    }

    cleanupSourceSnapshot(targetBeforeLoad?.sourceSnapshot);

    if (item.local) {
      const workspaceId = item.workspaceId || item.id;
      const localWorkspace = workspacesRef.current.find((workspace) => workspace.id === workspaceId);
      if (!localWorkspace) return;
      const snapshot = localWorkspace.submittedSnapshot;
      const nextSlots = snapshot?.imageSlots ? [...snapshot.imageSlots] : [...localWorkspace.imageSlots];
      updateWorkspace(targetId, (workspace) => ({
        ...workspace,
        mode: nextSlots.some(Boolean) ? "edit" : "generate",
        config: {
          ...initialConfig,
          ...(snapshot?.config || item.config || localWorkspace.config),
        },
        imageSlots: nextSlots,
        maskFile: snapshot?.maskFile || null,
        maskOpen: Boolean(snapshot?.maskFile || snapshot?.maskOpen),
        images: [],
        error: "",
        status: "",
        statusKind: "idle",
        loading: false,
        submittedAt: null,
        startedAt: null,
        durationMs: null,
        clientRequestId: null,
        historyId: null,
        previewOnly: false,
        rateLimitUntil: 0,
        sourceSnapshot: null,
        submittedSnapshot: null,
      }));
      setActiveWorkspaceId(targetId);
      setPreviewWorkspaceId(targetId);
      return;
    }

    updateWorkspace(targetId, {
      mode: item.mode || "generate",
      config: {
        ...initialConfig,
        ...(item.config || {}),
      },
      images: item.status === "success" ? item.images || [] : [],
      error: "",
      status: "",
      statusKind: "idle",
      loading: false,
      submittedAt: null,
      startedAt: null,
      durationMs: null,
      clientRequestId: null,
      historyId: null,
      previewOnly: false,
      rateLimitUntil: 0,
      sourceSnapshot: null,
      submittedSnapshot: null,
    });

    if ((item.source?.images || []).length) {
      try {
        const sourceFiles = await Promise.all(
          (item.source?.images || []).slice(0, MAX_EDIT_IMAGES).map((asset, index) => fileFromAsset(asset, `reference-${index + 1}.png`)),
        );
        const nextSlots = createEmptyImageSlots();
        sourceFiles.filter(Boolean).forEach((file, index) => {
          nextSlots[index] = file;
        });

        const referenceDimensions = await readImageDimensions(sourceFiles.find(Boolean)).catch(() => null);
        const restoredConfig = restoreSmartConfigFromReference(item.config || {}, "edit", referenceDimensions);
        const nextMask = await fileFromAsset(item.source?.mask, "mask.png");
        updateWorkspace(targetId, {
          mode: "edit",
          config: {
            ...initialConfig,
            ...restoredConfig,
          },
          imageSlots: nextSlots,
          maskFile: nextMask,
          maskOpen: Boolean(nextMask),
          error: "",
        });
      } catch (historyAssetError) {
        updateWorkspace(targetId, {
          imageSlots: createEmptyImageSlots(),
          maskFile: null,
          maskOpen: false,
          error: historyAssetError.message,
        });
      }
    } else {
      updateWorkspace(targetId, {
        mode: "generate",
        imageSlots: createEmptyImageSlots(),
        maskFile: null,
        maskOpen: false,
      });
    }

    updateWorkspace(targetId, (workspace) => {
      return {
        ...workspace,
        error: isRateLimitError(item.error)
          ? `历史记录：上游限流，建议等待 ${getRetryAfter(item.error) || 60}s 后重试。`
          : item.error?.message
            ? formatSubmitError(item.error)
            : "",
        status: "",
      };
    });
    setActiveWorkspaceId(targetId);
    setPreviewWorkspaceId(targetId);
  }

  async function deleteHistoryItem(item) {
    if (item.local) {
      const workspaceId = item.workspaceId || item.id;
      const workspace = workspacesRef.current.find((current) => current.id === workspaceId);
      if (workspace?.loading) {
        cancelRequest(item);
        return;
      }
      cleanupSourceSnapshot(workspace?.sourceSnapshot);
      const remaining = workspacesRef.current.filter((workspaceItem) => workspaceItem.id !== workspaceId);
      if (!remaining.length) {
        const replacement = createRefreshWorkspace(config.model);
        setWorkspaces([replacement]);
        setActiveWorkspaceId(replacement.id);
        setPreviewWorkspaceId(replacement.id);
      } else {
        setWorkspaces(remaining);
        if (activeWorkspaceId === workspaceId) {
          setActiveWorkspaceId(remaining[0].id);
        }
        if (previewWorkspaceId === workspaceId) {
          setPreviewWorkspaceId(remaining[0].id);
        }
      }
      return;
    }

    const response = await fetch(`/api/history/${item.id}`, { method: "DELETE" });
    await readApiJson(response);
    const deletedKeys = new Set([item.id, item.clientRequestId].filter(Boolean));
    setHistory((current) =>
      current.filter((historyItem) => ![historyItem.id, historyItem.clientRequestId].filter(Boolean).some((key) => deletedKeys.has(key))),
    );
    setHistoryTotal((current) => Math.max(0, current - 1));
    clearDeletedHistoryLocally(item);
    if ([previewWorkspace?.historyId, previewWorkspace?.clientRequestId].filter(Boolean).some((key) => deletedKeys.has(key))) {
      setPreviewWorkspaceId(activeWorkspaceId);
    }
    if (viewerItemId && deletedKeys.has(viewerItemId)) {
      setViewerIndex(null);
      setAdHocViewerEntries(null);
      setViewerMode(null);
      setViewerItemId(null);
      setViewerNotice("");
    }
    await loadHistory().catch(() => {});
  }

  const resolvedSize = getResolvedSize(config, mode, imageDimensions);

  return (
    <TooltipProvider>
      <Toaster position="top-center" />
      <main className="app-shell dark">
      <Button
        className="provider-settings-button"
        variant="outline"
        size="icon"
        type="button"
        aria-label="模型设置"
        onClick={() => {
          setProviderResult(null);
          setProviderDraft((current) => ({
            ...current,
            baseUrl: current.baseUrl || provider.baseUrl || "",
          }));
          setProviderOpen(true);
        }}
      >
        <SettingsIcon />
      </Button>
      <form className="workspace" style={workspaceStyle} onSubmit={handleSubmit}>
        <section className="control-panel resizable-panel">
          <div className="control-scroll">
            <div className="field prompt-field">
              <div className="prompt-heading">
                <span className="field-label">Prompt</span>
                <Button variant="outline" size="sm" type="button" onClick={createNewWorkspace}>
                  新建
                </Button>
              </div>
              <Textarea
                value={config.prompt}
                onChange={(event) => updateConfig("prompt", event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent?.isComposing) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
                rows={2}
              />
            </div>

            <div className="upload-grid">
              <div className="upload-header">
                <div>
                  <strong>原图 / 参考图</strong>
                  <span>可选；有参考图自动改图，没有参考图自动生图。最多 {MAX_EDIT_IMAGES} 张。</span>
                </div>
              </div>
              <div className="image-slot-grid">
                {imageSlots.map((file, index) => (
                  <ImageSlot
                    file={file}
                    index={index}
                    key={index}
                    onMove={moveImageSlot}
                    onPick={setImageSlot}
                    onRemove={removeImageSlot}
                    preview={imagePreviews[index]}
                  />
                ))}
              </div>
            </div>

            <Field label="尺寸控制">
              <ToggleGroup
                className="segmented-control"
                type="single"
                value={config.sizeMode}
                onValueChange={(value) => {
                  if (value) updateConfig("sizeMode", value);
                }}
                variant="outline"
                spacing={0}
              >
                {sizeModeOptions.map((option) => (
                  <ToggleGroupItem className="segmented-item" key={option.value} value={option.value}>
                    {option.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>

            {config.sizeMode === "preset" ? (
              <SelectField label="尺寸" value={config.size} onChange={(value) => updateConfig("size", value)} options={sizeOptions} />
            ) : (
              <div className="field-grid two">
                <SelectField
                  label={
                    <>
                      宽高比
                      <HelpTip text={`实际发送 size：${resolvedSize}。尺寸会自动贴合 API 要求的 16 倍数，宽高比和分辨率不会作为独立字段发送。`} />
                    </>
                  }
                  value={config.aspectRatio}
                  onChange={(value) => updateConfig("aspectRatio", value)}
                  options={aspectRatioOptions}
                />
                <SelectField label="分辨率" value={config.resolution} onChange={(value) => updateConfig("resolution", value)} options={resolutionOptions} />
              </div>
            )}

            <div className="field-grid two">
              <SelectField label="质量" value={config.quality} onChange={(value) => updateConfig("quality", value)} options={qualityOptions} />
              <SelectField label="数量" value={String(config.count)} onChange={(value) => updateConfig("count", Number(value))} options={countOptions.map(String)} />
            </div>

          </div>

          <div className="submit-row sticky-submit">
            <div className="submit-meta">
              <strong>{mode === "generate" ? "生图" : "改图"}</strong>
              <span>{resolvedSize} · {config.quality}</span>
            </div>
            <Button className="submit-button" size="lg" type="submit" disabled={rateLimitRemaining > 0 || submitLockRemaining > 0}>
              {rateLimitRemaining > 0 ? `限流等待 ${rateLimitRemaining}s` : "生成图片"}
            </Button>
          </div>
          <PanelResizeHandle label="参数区" onResizeStart={(event) => startPanelResize("control", event)} />
        </section>

        <section className="preview-panel resizable-panel">
          <ImageResults
            images={previewImages}
            outputFormat={previewOutputFormat}
            generatedAt={previewWorkspace?.completedAt || previewWorkspace?.createdAt}
            loading={previewLoading}
            elapsedSeconds={previewElapsedSeconds}
            onPreview={openActiveResultImage}
            onCopy={copyResultImage}
            onImport={importResultImage}
          />
          <PanelResizeHandle label="预览区" onResizeStart={(event) => startPanelResize("preview", event)} />
        </section>

        <div className="history-panel-shell resizable-panel">
          <HistoryPanel
            history={visibleHistory}
            error={historyError}
            hasMore={historyHasMore}
            loadingMore={historyLoadingMore}
            total={historyTotal + localProcessHistory.length}
            onLoadMore={loadMoreHistory}
            onView={previewHistoryItem}
            onEdit={loadHistoryItem}
            onDelete={deleteHistoryItem}
            onCancel={cancelRequest}
            onPreview={openHistoryImage}
            onImportResult={importResultImage}
            onImportSource={importSourceAsset}
          />
          <PanelResizeHandle label="历史记录" onResizeStart={(event) => startPanelResize("history", event)} />
        </div>
      </form>
      {viewerEntry && (
        <ImageViewer
          entry={viewerEntry}
          notice={viewerNotice}
          positionLabel={viewerPositionLabel}
          onCopy={copyResultImage}
          onImport={importResultImage}
          onClose={() => {
            setViewerIndex(null);
            setAdHocViewerEntries(null);
            setViewerMode(null);
            setViewerItemId(null);
            setViewerNotice("");
          }}
          onNavigate={navigateViewer}
        />
      )}
      <ProviderSettingsDialog
        open={providerOpen}
        editorOpen={providerEditorOpen}
        provider={provider}
        profiles={providerProfiles}
        draft={providerDraft}
        busy={providerBusy}
        result={providerResult}
        onOpenChange={setProviderOpen}
        onEditorOpenChange={setProviderEditorOpen}
        onDraftChange={setProviderDraft}
        onUseProfile={useProviderProfile}
        onEdit={editProviderProfile}
        onNew={createNewProviderProfile}
        onDelete={deleteProviderProfile}
        onVerify={verifyProviderSettings}
        onSave={saveProviderSettings}
      />
      </main>
    </TooltipProvider>
  );
}

async function bootstrap() {
  let initialSettings = loadSavedSettings();
  if (initialSettings.source === "default") {
    try {
      const data = await requestJson("/api/settings");
      if (data.settings?.config) {
        initialSettings = {
          mode: "generate",
          config: {
            ...initialConfig,
            ...data.settings.config,
          },
          provider: data.settings.provider,
          providerProfiles: data.settings.profiles || data.settings.providerProfiles || [],
          source: "server",
        };
      }
    } catch {
      // Fall back to defaults when saved settings are unavailable.
    }
  }

  try {
    const data = await requestJson("/api/provider-settings");
    if (data.provider) {
      initialSettings = {
        ...initialSettings,
        provider: data.provider,
        providerProfiles: data.profiles || [],
      };
    }
  } catch {
    // Provider settings can be loaded after render.
  }

  const rootContainer = document.getElementById("root");
  window.__image2ReactRoot ||= createRoot(rootContainer);
  window.__image2ReactRoot.render(<App initialSettings={initialSettings} />);
}

bootstrap();
