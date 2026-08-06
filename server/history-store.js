import Database from "better-sqlite3";

export const MAX_HISTORY_LIMIT = 100_000_000;

function hasFavorite(item) {
  return Boolean(
    item?.images?.some((image) => image?.favorite === true) ||
    item?.source?.images?.some((image) => image?.favorite === true),
  );
}

function parseRow(row) {
  return row ? JSON.parse(row.data) : null;
}

function rowValues(item) {
  return {
    id: item.id,
    createdAt: item.createdAt || new Date().toISOString(),
    favorite: hasFavorite(item) ? 1 : 0,
    status: item.status || "",
    providerId: item.providerId || "",
    data: JSON.stringify(item),
  };
}

export class HistoryStore {
  constructor(filename, { limit = MAX_HISTORY_LIMIT } = {}) {
    this.limit = Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.floor(Number(limit) || MAX_HISTORY_LIMIT)));
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_items (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        provider_id TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_favorite_sequence
        ON history_items (favorite, sequence DESC);
      CREATE INDEX IF NOT EXISTS history_running_provider
        ON history_items (status, provider_id, sequence DESC);
      CREATE TABLE IF NOT EXISTS history_stats (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);

    this.insertStatement = this.db.prepare(`
      INSERT INTO history_items (id, created_at, favorite, status, provider_id, data)
      VALUES (@id, @createdAt, @favorite, @status, @providerId, @data)
    `);
    this.updateStatement = this.db.prepare(`
      UPDATE history_items
      SET created_at = @createdAt,
          favorite = @favorite,
          status = @status,
          provider_id = @providerId,
          data = @data
      WHERE id = @id
    `);
    this.ensureStats();
  }

  ensureStats() {
    const existingStats = this.db
      .prepare("SELECT key FROM history_stats WHERE key IN ('total', 'favorite')")
      .all();
    if (existingStats.length === 2) return;

    const total = Number(this.db.prepare("SELECT COUNT(*) AS count FROM history_items").get().count);
    const favorite = Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM history_items WHERE favorite = 1").get().count,
    );
    const setStat = this.db.prepare(`
      INSERT INTO history_stats (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const transaction = this.db.transaction(() => {
      setStat.run("total", total);
      setStat.run("favorite", favorite);
    });
    transaction();
  }

  stat(key) {
    return Number(this.db.prepare("SELECT value FROM history_stats WHERE key = ?").get(key)?.value || 0);
  }

  setStat(key, value) {
    this.db.prepare("UPDATE history_stats SET value = ? WHERE key = ?").run(value, key);
  }

  count() {
    return this.stat("total");
  }

  importLegacy(items) {
    if (this.count() > 0 || !Array.isArray(items) || items.length === 0) return 0;

    const seen = new Set();
    const selected = items.filter((item) => {
      if (!item?.id || seen.has(item.id) || seen.size >= this.limit) return false;
      seen.add(item.id);
      return true;
    });
    const transaction = this.db.transaction(() => {
      for (const item of [...selected].reverse()) {
        this.insertStatement.run(rowValues(item));
      }
      this.setStat("total", selected.length);
      this.setStat("favorite", selected.filter(hasFavorite).length);
    });
    transaction();
    return selected.length;
  }

  append(item) {
    const transaction = this.db.transaction(() => {
      let total = this.stat("total");
      let favorite = this.stat("favorite");
      const existing = this.db.prepare("SELECT favorite FROM history_items WHERE id = ?").get(item.id);
      if (existing) {
        this.db.prepare("DELETE FROM history_items WHERE id = ?").run(item.id);
        total -= 1;
        favorite -= Number(existing.favorite);
      }

      const values = rowValues(item);
      this.insertStatement.run(values);
      total += 1;
      favorite += values.favorite;

      const overflow = Math.max(0, total - this.limit);
      let evicted = [];
      if (overflow > 0) {
        const rows = this.db
          .prepare("SELECT data, favorite FROM history_items ORDER BY sequence ASC LIMIT ?")
          .all(overflow);
        evicted = rows.map(parseRow);
        const evictedFavorite = rows.reduce((sum, row) => sum + Number(row.favorite), 0);
        this.db.prepare(`
          DELETE FROM history_items
          WHERE sequence IN (
            SELECT sequence FROM history_items ORDER BY sequence ASC LIMIT ?
          )
        `).run(overflow);
        total -= rows.length;
        favorite -= evictedFavorite;
      }

      this.setStat("total", total);
      this.setStat("favorite", favorite);
      return { item, evicted };
    });
    return transaction();
  }

  get(id) {
    return parseRow(this.db.prepare("SELECT data FROM history_items WHERE id = ?").get(id));
  }

  update(id, updater) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT data, favorite FROM history_items WHERE id = ?").get(id);
      if (!row) return null;
      const current = parseRow(row);
      const updated = typeof updater === "function" ? updater(current) : { ...current, ...updater };
      const values = rowValues(updated);
      this.updateStatement.run(values);
      if (Number(row.favorite) !== values.favorite) {
        this.setStat("favorite", this.stat("favorite") + values.favorite - Number(row.favorite));
      }
      return updated;
    });
    return transaction();
  }

  page({ cursor = "", limit = 30, favoriteOnly = false } = {}) {
    const cursorSequence = cursor
      ? this.db.prepare("SELECT sequence FROM history_items WHERE id = ?").get(cursor)?.sequence
      : null;
    const boundary = Number.isSafeInteger(cursorSequence) ? cursorSequence : Number.MAX_SAFE_INTEGER;
    const rows = favoriteOnly
      ? this.db
          .prepare(`
            SELECT data FROM history_items
            WHERE favorite = 1 AND sequence < ?
            ORDER BY sequence DESC
            LIMIT ?
          `)
          .all(boundary, limit + 1)
      : this.db
          .prepare(`
            SELECT data FROM history_items
            WHERE sequence < ?
            ORDER BY sequence DESC
            LIMIT ?
          `)
          .all(boundary, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(parseRow);
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id || null : null,
      hasMore,
      total: this.stat(favoriteOnly ? "favorite" : "total"),
    };
  }

  listRunning(providerId) {
    return this.db
      .prepare(`
        SELECT data FROM history_items
        WHERE status = 'running' AND provider_id = ?
        ORDER BY sequence DESC
      `)
      .all(providerId)
      .map(parseRow);
  }

  delete(id) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT data, favorite FROM history_items WHERE id = ?").get(id);
      if (!row) return null;
      this.db.prepare("DELETE FROM history_items WHERE id = ?").run(id);
      this.setStat("total", Math.max(0, this.stat("total") - 1));
      this.setStat("favorite", Math.max(0, this.stat("favorite") - Number(row.favorite)));
      return parseRow(row);
    });
    return transaction();
  }

  clear() {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM history_items").run();
      this.setStat("total", 0);
      this.setStat("favorite", 0);
    });
    transaction();
  }

  close() {
    this.db.close();
  }
}
