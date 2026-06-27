const SMART_VALUE = "smart";
const MAX_ASPECT_RATIO = 3;
const MIN_PIXELS = 655360;
const MAX_PIXELS = 8294400;

function roundTo16(value) {
  return Math.round(value / 16) * 16;
}

function floorTo16(value) {
  return Math.floor(value / 16) * 16;
}

function ceilTo16(value) {
  return Math.ceil(value / 16) * 16;
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
  if (!dimensions?.width || !dimensions?.height) return "";
  const divisor = greatestCommonDivisor(dimensions.width, dimensions.height);
  return `${Math.round(dimensions.width / divisor)}:${Math.round(dimensions.height / divisor)}`;
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

function adaptedSizeFromDimensions(dimensions) {
  if (!dimensions?.width || !dimensions?.height) return "";
  const width = Math.max(16, roundTo16(dimensions.width));
  const height = Math.max(16, roundTo16(dimensions.height));
  const fitted = fitPixelRange(width, height);
  return `${fitted.width}x${fitted.height}`;
}

function rawSizeFromDimensions(dimensions) {
  if (!dimensions?.width || !dimensions?.height) return "";
  return `${dimensions.width}x${dimensions.height}`;
}

export function createApiSubmissionConfig(config = {}) {
  const { resolvedSize, ...submissionConfig } = config;
  return submissionConfig;
}

export function restoreSmartConfigFromReference(config = {}, mode = "generate", referenceDimensions = null) {
  const nextConfig = { ...config };
  if (mode !== "edit" || !referenceDimensions?.width || !referenceDimensions?.height) return nextConfig;

  if (
    nextConfig.sizeMode === "ratio" &&
    nextConfig.size === SMART_VALUE &&
    nextConfig.aspectRatio &&
    nextConfig.aspectRatio !== SMART_VALUE &&
    nextConfig.aspectRatio === aspectRatioFromDimensions(referenceDimensions)
  ) {
    nextConfig.aspectRatio = SMART_VALUE;
  }

  if (
    nextConfig.sizeMode === "preset" &&
    nextConfig.size &&
    nextConfig.size !== SMART_VALUE &&
    [rawSizeFromDimensions(referenceDimensions), adaptedSizeFromDimensions(referenceDimensions)].includes(nextConfig.size)
  ) {
    nextConfig.size = SMART_VALUE;
  }

  return nextConfig;
}
