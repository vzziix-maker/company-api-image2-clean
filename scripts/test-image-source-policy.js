import { resolveTrustedImageSource } from "../src/image-source-policy.js";

const origin = "http://127.0.0.1:43288";
const accepted = [
  "/api/history-assets/result-123.png",
  origin + "/api/history-assets/result-456.webp",
  "data:image/png;base64,aW1hZ2U=",
  "data:image/jpeg;base64,aW1hZ2U=",
].map((value) => resolveTrustedImageSource(value, origin));

const rejected = [
  "/api/provider-settings/default/key",
  "/api/history-assets/nested/result.png",
  "https://provider.example/result.png",
  "data:text/plain;base64,c2VjcmV0",
  "javascript:alert(1)",
];

const rejectionResults = rejected.map((value) => {
  try {
    resolveTrustedImageSource(value, origin);
    return false;
  } catch {
    return true;
  }
});

const ok =
  accepted.length === 4 &&
  accepted.every(Boolean) &&
  rejectionResults.every(Boolean);

console.log(JSON.stringify({
  ok,
  accepted: accepted.length,
  rejected: rejectionResults.filter(Boolean).length,
}, null, 2));

if (!ok) process.exitCode = 1;
