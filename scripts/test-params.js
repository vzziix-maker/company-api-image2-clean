import "../server/env.js";

const port = Number(process.env.PORT || 8787);
const expected = {
  format: "jpeg",
  width: 1024,
  height: 688,
};

function readPng(buffer) {
  if (buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return {
    format: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readJpeg(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xc3;
    if (isStartOfFrame) {
      return {
        format: "jpeg",
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += 2 + length;
  }

  return null;
}

function readImage(buffer) {
  return readPng(buffer) || readJpeg(buffer) || { format: "unknown", width: 0, height: 0 };
}

const response = await fetch(`http://localhost:${port}/api/generate`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    sizeMode: "ratio",
    model: "gpt-image-2",
    prompt: "A simple centered green triangle on a plain white background",
    size: "1024x1024",
    aspectRatio: "3:2",
    resolution: "1K",
    quality: "low",
    outputFormat: "jpeg",
    background: "auto",
    count: 1,
  }),
});

const data = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}

const first = data.images?.[0];
const buffer = Buffer.from(first?.b64_json || "", "base64");
const actual = readImage(buffer);
const ok = actual.format === expected.format && actual.width === expected.width && actual.height === expected.height;

console.log(JSON.stringify({
  ok,
  expected,
  actual,
  imageCount: data.images?.length || 0,
  resolvedSize: data.raw?.data?.[0] ? `${actual.width}x${actual.height}` : null,
  historyId: data.historyId,
}, null, 2));

if (!ok) process.exit(1);
