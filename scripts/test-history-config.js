import assert from "node:assert/strict";

import {
  createApiSubmissionConfig,
  restoreSmartConfigFromReference,
} from "../src/history-config.js";

const baseSmartRatioConfig = {
  sizeMode: "ratio",
  size: "smart",
  aspectRatio: "smart",
  resolution: "2K",
  resolvedSize: "800x2048",
  quality: "medium",
};
const apiConfig = createApiSubmissionConfig(baseSmartRatioConfig);

assert.equal(apiConfig.size, "smart");
assert.equal(apiConfig.aspectRatio, "smart");
assert.equal("resolvedSize" in apiConfig, false);
assert.equal(baseSmartRatioConfig.resolvedSize, "800x2048");

const restoredRatioConfig = restoreSmartConfigFromReference(
  {
    sizeMode: "ratio",
    size: "smart",
    aspectRatio: "25:64",
    resolution: "2K",
  },
  "edit",
  { width: 800, height: 2048 },
);

assert.equal(restoredRatioConfig.aspectRatio, "smart");

const fixedRatioConfig = restoreSmartConfigFromReference(
  {
    sizeMode: "ratio",
    size: "smart",
    aspectRatio: "9:16",
    resolution: "2K",
  },
  "edit",
  { width: 800, height: 2048 },
);

assert.equal(fixedRatioConfig.aspectRatio, "9:16");

const restoredPresetConfig = restoreSmartConfigFromReference(
  {
    sizeMode: "preset",
    size: "1232x992",
    aspectRatio: "1:1",
  },
  "edit",
  { width: 1234, height: 987 },
);

assert.equal(restoredPresetConfig.size, "smart");

const restoredOriginalPresetConfig = restoreSmartConfigFromReference(
  {
    sizeMode: "preset",
    size: "1234x987",
    aspectRatio: "1:1",
  },
  "edit",
  { width: 1234, height: 987 },
);

assert.equal(restoredOriginalPresetConfig.size, "smart");

console.log("history config tests passed");
