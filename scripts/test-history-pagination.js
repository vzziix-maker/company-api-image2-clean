import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRefreshedHistory } from "../src/history-refresh.js";

const mockPort = Number(process.env.MOCK_IMAGE_API_PORT || 19898);
const appPort = Number(process.env.MOCK_APP_PORT || 19899);
const appDataDir = await mkdtemp(join(tmpdir(), "image2-history-pagination-"));

const loadedHistory = Array.from({ length: 60 }, (_, index) => ({ id: `item-${index + 1}`, version: 1 }));
const refreshedFirstPage = [
  { id: "new-running-item", version: 1 },
  ...loadedHistory.slice(0, 29).map((item) => ({ ...item, version: 2 })),
];
const mergedRefresh = mergeRefreshedHistory(loadedHistory, refreshedFirstPage, 61);
assert.equal(mergedRefresh.length, 61);
assert.equal(mergedRefresh[0].id, "new-running-item");
assert.equal(mergedRefresh.find((item) => item.id === "item-1")?.version, 2);
assert.equal(mergedRefresh.at(-1)?.id, "item-60");
await writeFile(
  join(appDataDir, "settings.json"),
  JSON.stringify({
    activeProviderId: "test-provider",
    providerProfiles: [{
      id: "test-provider",
      name: "测试 Key",
      baseUrl: `http://localhost:${mockPort}/v1`,
      apiKey: "test-key",
    }],
  }),
);

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const mock = createServer(async (request, response) => {
  const body = await readBody(request);
  const parsed = JSON.parse(body.toString("utf8") || "{}");
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: Buffer.from(parsed.prompt || "image").toString("base64") }],
      usage: { total_tokens: 1 },
    }),
  );
});

await new Promise((resolve) => mock.listen(mockPort, resolve));

const child = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(appPort),
    IMAGE_API_BASE_URL: `http://localhost:${mockPort}/v1`,
    IMAGE_API_KEY: "test-key",
    APP_DATA_DIR: appDataDir,
    HISTORY_LIMIT: "50",
    ALLOW_LOCAL_PROVIDER_URLS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`127.0.0.1:${appPort}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", (code) => reject(new Error(`server exited early: ${code}`)));
  });
}

async function createHistory(id) {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientRequestId: id,
      model: "gpt-image-2",
      prompt: id,
      sizeMode: "ratio",
      aspectRatio: "1:1",
      resolution: "1K",
      quality: "low",
      outputFormat: "png",
      background: "auto",
      count: 1,
    }),
  });
  if (!response.ok) throw new Error(`generate failed: ${response.status}`);
  return response.json();
}

async function readHistory(query = "") {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/history${query}`);
  if (!response.ok) throw new Error(`history failed: ${response.status}`);
  return response.json();
}

async function patchFavorite(id, body) {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/history/${id}/favorite`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

try {
  await waitForServer();
  await createHistory("page-oldest");
  await createHistory("page-middle");
  await createHistory("page-newest");

  const firstPage = await readHistory("?limit=2");
  const secondPage = await readHistory(`?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
  const paginationOk =
    firstPage.items.length === 2 &&
    firstPage.items[0].id === "page-newest" &&
    firstPage.items[1].id === "page-middle" &&
    firstPage.hasMore === true &&
    firstPage.nextCursor === "page-middle" &&
    firstPage.total === 3 &&
    secondPage.items.length === 1 &&
    secondPage.items[0].id === "page-oldest" &&
    secondPage.hasMore === false &&
    secondPage.nextCursor === null &&
    secondPage.total === 3;

  const historyPath = join(appDataDir, "history.json");
  const storedHistory = JSON.parse(await readFile(historyPath, "utf8"));
  const pageNewest = storedHistory.find((item) => item.id === "page-newest");
  const pageMiddle = storedHistory.find((item) => item.id === "page-middle");
  const pageOldest = storedHistory.find((item) => item.id === "page-oldest");
  pageMiddle.source = {
    images: [{ id: "source-image-1", url: "/api/history-assets/source-image-1.png" }],
  };
  const fillerItems = Array.from({ length: 32 }, (_, index) => ({
    ...pageNewest,
    id: `filler-${index + 1}`,
    clientRequestId: `filler-${index + 1}`,
    createdAt: new Date(Date.now() + (index + 1) * 1000).toISOString(),
    images: (pageNewest.images || []).map((image) => ({ ...image, favorite: false })),
  })).reverse();
  await writeFile(historyPath, JSON.stringify([...fillerItems, pageNewest, pageMiddle, pageOldest], null, 2));

  const favoriteOldest = await patchFavorite("page-oldest", {
    kind: "result",
    imageIndex: 0,
    favorite: true,
  });
  const firstFavoritePage = await readHistory("?limit=30&favorite=1");
  const favoriteSource = await patchFavorite("page-middle", {
    kind: "source",
    imageId: "source-image-1",
    imageIndex: 0,
    favorite: true,
  });
  const favoritePageOne = await readHistory("?limit=1&favorite=1");
  const favoritePageTwo = await readHistory(`?limit=1&favorite=1&cursor=${encodeURIComponent(favoritePageOne.nextCursor)}`);
  const unfavoriteOldest = await patchFavorite("page-oldest", {
    kind: "result",
    imageIndex: 0,
    favorite: false,
  });
  const afterUnfavorite = await readHistory("?limit=30&favorite=1");
  const invalidKind = await patchFavorite("page-middle", { kind: "other", imageIndex: 0, favorite: true });
  const missingImage = await patchFavorite("page-middle", { kind: "source", imageIndex: 99, favorite: true });
  const persistedHistory = JSON.parse(await readFile(historyPath, "utf8"));
  const persistedMiddle = persistedHistory.find((item) => item.id === "page-middle");
  const persistedOldest = persistedHistory.find((item) => item.id === "page-oldest");

  const favoritesOk =
    favoriteOldest.response.ok &&
    firstFavoritePage.total === 1 &&
    firstFavoritePage.items[0]?.id === "page-oldest" &&
    favoriteSource.response.ok &&
    favoritePageOne.total === 2 &&
    favoritePageOne.items.length === 1 &&
    favoritePageOne.hasMore === true &&
    favoritePageTwo.items.length === 1 &&
    favoritePageTwo.hasMore === false &&
    unfavoriteOldest.response.ok &&
    afterUnfavorite.total === 1 &&
    afterUnfavorite.items[0]?.id === "page-middle" &&
    invalidKind.response.status === 400 &&
    missingImage.response.status === 404 &&
    persistedMiddle.source.images[0].favorite === true &&
    persistedOldest.images[0].favorite === false;
  const ok = paginationOk && favoritesOk;

  console.log(JSON.stringify({ ok, paginationOk, favoritesOk, firstPage, secondPage }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  child.kill();
  mock.close();
  await rm(appDataDir, { recursive: true, force: true });
}
