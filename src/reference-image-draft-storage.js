const DB_NAME = "image2-drafts";
const DB_VERSION = 1;
const STORE_NAME = "reference-images";
const DRAFT_KEY = "active-workspace";

function getIndexedDB() {
  return globalThis.indexedDB;
}

function openDraftDb() {
  const indexedDB = getIndexedDB();
  if (!indexedDB) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runStoreOperation(mode, operation) {
  return openDraftDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    });
  });
}

export function serializeReferenceImageSlots(imageSlots = []) {
  return imageSlots.map((file, index) =>
    file
      ? {
          index,
          file,
          name: file.name || `reference-${index + 1}.png`,
          type: file.type || "image/png",
          lastModified: file.lastModified || Date.now(),
        }
      : null,
  );
}

export function deserializeReferenceImageSlots(records = [], slotCount = 5) {
  const slots = Array.from({ length: slotCount }, () => null);
  records.slice(0, slotCount).forEach((record, index) => {
    if (!record?.file) return;
    const file = record.file;
    if (typeof File !== "undefined" && !(file instanceof File)) {
      slots[index] = new File([file], record.name || `reference-${index + 1}.png`, {
        type: record.type || file.type || "image/png",
        lastModified: record.lastModified || Date.now(),
      });
      return;
    }
    slots[index] = file;
  });
  return slots;
}

export async function saveReferenceImageDraft(imageSlots = []) {
  const records = serializeReferenceImageSlots(imageSlots);
  await runStoreOperation("readwrite", (store) => store.put(records, DRAFT_KEY));
  return records;
}

export async function loadReferenceImageDraft(slotCount = 5) {
  const records = await runStoreOperation("readonly", (store) => store.get(DRAFT_KEY));
  if (!Array.isArray(records)) return Array.from({ length: slotCount }, () => null);
  return deserializeReferenceImageSlots(records, slotCount);
}
