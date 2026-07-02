import assert from "node:assert/strict";

import { createImageDownloadFilename } from "../src/download-filenames.js";

const fixedDate = new Date("2026-04-05T14:14:30+08:00");
const fallbackDate = new Date("2026-04-06T09:08:10+08:00");

assert.equal(
  createImageDownloadFilename({
    imageIndex: 2,
    outputFormat: "png",
    date: fixedDate,
    timeZone: "Asia/Shanghai",
  }),
  "20260405-14:14-3.png",
);

assert.equal(
  createImageDownloadFilename({
    imageIndex: 0,
    outputFormat: "jpeg",
    date: fixedDate,
    timeZone: "Asia/Shanghai",
  }),
  "20260405-14:14-1.jpg",
);

assert.equal(
  createImageDownloadFilename({
    imageIndex: 1,
    outputFormat: "png",
    generatedAt: "2026-04-05T14:14:30+08:00",
    date: fallbackDate,
    timeZone: "Asia/Shanghai",
  }),
  "20260405-14:14-2.png",
);

console.log("download filename tests passed");
