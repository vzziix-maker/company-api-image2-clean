import "../server/env.js";

const port = Number(process.env.PORT || 43287);

const response = await fetch(`http://127.0.0.1:${port}/api/generate`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-image-2",
    prompt: "A simple red apple on a white background",
    size: "1024x1024",
    quality: "low",
    outputFormat: "png",
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
console.log(JSON.stringify({
  ok: Boolean(first?.b64_json || first?.url),
  imageCount: data.images?.length || 0,
  firstImageType: first?.b64_json ? "b64_json" : first?.url ? "url" : "missing",
  usage: data.usage || null,
}, null, 2));
