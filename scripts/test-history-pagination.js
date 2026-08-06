import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRefreshedHistory } from "../src/history-refresh.js";

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

function historyItem(id, extra = {}) {
  return {
    id,
    createdAt: new Date().toISOString(),
    status: "success",
    images: [{ id: `${id}.png`, url: `/api/history-assets/${id}.png`, favorite: false }],
    ...extra,
  };
}

const pageNewest = historyItem("page-newest");
const pageMiddle = historyItem("page-middle", {
  source: { images: [{ id: "source-image-1", url: "/api/history-assets/source-image-1.png" }] },
});
const pageOldest = historyItem("page-oldest");
const fillerItems = Array.from({ length: 32 }, (_, index) => historyItem(`filler-${32 - index}`));
await writeFile(
  join(appDataDir, "history.json"),
  JSON.stringify([...fillerItems, pageNewest, pageMiddle, pageOldest], null, 2),
);

function startApp() {
  return spawn(process.execPath, ["server/index.js"], {
    env: {
      ...process.env,
      PORT: String(appPort),
      APP_DATA_DIR: appDataDir,
      HISTORY_LIMIT: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
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

async function stopApp(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
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

let child = startApp();
try {
  await waitForServer(child);

  const firstPage = await readHistory("?limit=2");
  const secondPage = await readHistory(`?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
  const paginationOk =
    firstPage.items.length === 2 &&
    firstPage.items[0].id === "filler-32" &&
    firstPage.items[1].id === "filler-31" &&
    firstPage.hasMore === true &&
    firstPage.nextCursor === "filler-31" &&
    firstPage.total === 35 &&
    secondPage.items.length === 2 &&
    secondPage.items[0].id === "filler-30" &&
    secondPage.items[1].id === "filler-29" &&
    secondPage.hasMore === true &&
    secondPage.total === 35;

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
  const favoritePageTwo = await readHistory(
    `?limit=1&favorite=1&cursor=${encodeURIComponent(favoritePageOne.nextCursor)}`,
  );
  const unfavoriteOldest = await patchFavorite("page-oldest", {
    kind: "result",
    imageIndex: 0,
    favorite: false,
  });
  const afterUnfavorite = await readHistory("?limit=30&favorite=1");
  const invalidKind = await patchFavorite("page-middle", { kind: "other", imageIndex: 0, favorite: true });
  const missingImage = await patchFavorite("page-middle", { kind: "source", imageIndex: 99, favorite: true });

  await stopApp(child);
  child = startApp();
  await waitForServer(child);
  const afterRestart = await readHistory("?limit=30&favorite=1");
  await stat(join(appDataDir, "history.sqlite"));
  await stat(join(appDataDir, "history-json-migration-v1.complete"));

  const favoritesOk =
    favoriteOldest.response.ok &&
    firstFavoritePage.total === 1 &&
    firstFavoritePage.items[0]?.id === "page-oldest" &&
    favoriteSource.response.ok &&
    favoritePageOne.total === 2 &&
    favoritePageOne.items[0]?.id === "page-middle" &&
    favoritePageOne.hasMore === true &&
    favoritePageTwo.items[0]?.id === "page-oldest" &&
    favoritePageTwo.hasMore === false &&
    unfavoriteOldest.response.ok &&
    afterUnfavorite.total === 1 &&
    afterUnfavorite.items[0]?.id === "page-middle" &&
    afterRestart.total === 1 &&
    afterRestart.items[0]?.id === "page-middle" &&
    invalidKind.response.status === 400 &&
    missingImage.response.status === 404;
  const ok = paginationOk && favoritesOk;

  console.log(JSON.stringify({ ok, paginationOk, favoritesOk, firstPage, secondPage }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  await stopApp(child).catch(() => {});
  await rm(appDataDir, { recursive: true, force: true });
}
