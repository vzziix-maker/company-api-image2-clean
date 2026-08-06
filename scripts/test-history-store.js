import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore, MAX_HISTORY_LIMIT } from "../server/history-store.js";

const dataDir = await mkdtemp(join(tmpdir(), "image2-history-store-"));
const databasePath = join(dataDir, "history.sqlite");

function item(id, favorite = false) {
  return {
    id,
    createdAt: new Date().toISOString(),
    status: "success",
    providerId: "test",
    images: [{ id: `${id}.png`, favorite }],
  };
}

let store;
try {
  assert.equal(MAX_HISTORY_LIMIT, 100_000_000);
  store = new HistoryStore(databasePath, { limit: 3 });
  store.append(item("one"));
  store.append(item("two", true));
  store.append(item("three"));
  const evicted = store.append(item("four")).evicted;

  assert.deepEqual(evicted.map((entry) => entry.id), ["one"]);
  assert.equal(store.count(), 3);
  assert.deepEqual(store.page({ limit: 2 }).items.map((entry) => entry.id), ["four", "three"]);
  assert.deepEqual(store.page({ limit: 30, favoriteOnly: true }).items.map((entry) => entry.id), ["two"]);

  store.update("three", (entry) => ({
    ...entry,
    images: entry.images.map((image) => ({ ...image, favorite: true })),
  }));
  assert.equal(store.page({ favoriteOnly: true }).total, 2);
  store.close();

  store = new HistoryStore(databasePath, { limit: MAX_HISTORY_LIMIT });
  assert.deepEqual(store.page({ limit: 30 }).items.map((entry) => entry.id), ["four", "three", "two"]);
  assert.equal(store.page({ favoriteOnly: true }).total, 2);
  console.log("history store tests passed");
} finally {
  store?.close();
  await rm(dataDir, { recursive: true, force: true });
}
