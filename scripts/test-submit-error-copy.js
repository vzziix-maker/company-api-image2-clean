import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  let depth = 0;
  let end = start;
  let started = false;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === "{") {
      depth += 1;
      started = true;
    } else if (char === "}") {
      depth -= 1;
      if (started && depth === 0) {
        end += 1;
        break;
      }
    }
  }
  return source.slice(start, end);
}

const moduleSource = [
  "isLocalTimeoutError",
  "isGatewayTimeoutError",
  "isUpstreamOperationTimeoutError",
  "formatSubmitError",
]
  .map(extractFunction)
  .join("\n")
  .concat("\nreturn { formatSubmitError };");
const { formatSubmitError } = Function(moduleSource)();

const cases = [
  {
    name: "local backend timeout mentions the 60 minute local wait",
    error: { code: "upstream_timeout", message: "Image API request timed out after 3600s." },
    expected: "本地等待图片服务超过 60 分钟，已自动停止。可以降低数量、尺寸或质量后重试。",
  },
  {
    name: "upstream gateway timeout does not mention the 60 minute local wait",
    error: { status: 504, message: "Gateway Time-out" },
    expected: "上游服务网关超时了。通常是图片服务或中转 API 在完成前断开；可以降低数量、尺寸或质量后重试。",
  },
  {
    name: "upstream processing timeout is described as upstream timeout",
    error: { message: "The operation was timeout." },
    expected: "上游图片服务处理超时了。可以稍后重试，或降低数量、尺寸、质量后重试。",
  },
  {
    name: "non-timeout errors keep their original message",
    error: { message: "Invalid API key." },
    expected: "Invalid API key.",
  },
];

const failures = cases
  .map((testCase) => {
    const actual = formatSubmitError(testCase.error);
    return actual === testCase.expected ? null : { ...testCase, actual };
  })
  .filter(Boolean);

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log("submit error copy tests passed");
