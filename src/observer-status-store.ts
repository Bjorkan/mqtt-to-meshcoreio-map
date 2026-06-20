import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ObserverState } from "./map-types.js";
import type { DashboardAdvertLocation, DashboardQueueItem } from "./dashboard/dashboard-state.js";

export interface ObserverStatusStore {
  loadAll(): ObserverState[];
  upsert(status: ObserverState): void;
  delete(originId: string): void;
  deleteOlderThan(updatedAt: number): void;
  close?(): void;
}

export interface MeshcoreHistoryRecord {
  queueItem: DashboardQueueItem;
  advert?: DashboardAdvertLocation;
}

export interface MeshcoreHistoryStore {
  loadMeshcoreHistory(): MeshcoreHistoryRecord[];
  upsertMeshcoreHistory(record: MeshcoreHistoryRecord): void;
  deleteMeshcoreHistoryOlderThan(updatedAt: number): void;
}

export type MeshcoreDashboardStore = ObserverStatusStore & MeshcoreHistoryStore;

interface ObserverStatusRow {
  origin_id: string;
  origin: string | null;
  freq: number;
  cr: number;
  sf: number;
  bw: number;
  updated_at: number;
}

interface MeshcoreHistoryRow {
  queue_item_json: string;
  advert_json: string | null;
}

export class SqliteObserverStatusStore implements MeshcoreDashboardStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observer_statuses (
        origin_id TEXT PRIMARY KEY,
        origin TEXT,
        freq REAL NOT NULL,
        cr REAL NOT NULL,
        sf REAL NOT NULL,
        bw REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_observer_statuses_updated_at
        ON observer_statuses(updated_at);

      CREATE TABLE IF NOT EXISTS meshcore_history (
        request_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        queue_item_json TEXT NOT NULL,
        advert_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_meshcore_history_updated_at
        ON meshcore_history(updated_at);
    `);
  }

  loadAll(): ObserverState[] {
    const rows = this.db.prepare(`
      SELECT origin_id, origin, freq, cr, sf, bw, updated_at
      FROM observer_statuses
      ORDER BY updated_at ASC
    `).all() as unknown as ObserverStatusRow[];

    return rows.map((row) => ({
      origin: row.origin ?? undefined,
      originId: row.origin_id,
      params: {
        freq: row.freq,
        cr: row.cr,
        sf: row.sf,
        bw: row.bw,
      },
      updatedAt: row.updated_at,
    }));
  }

  upsert(status: ObserverState): void {
    if (!status.originId) {
      return;
    }

    const { freq, cr, sf, bw } = status.params;
    if (freq === undefined || cr === undefined || sf === undefined || bw === undefined) {
      return;
    }

    this.db.prepare(`
      INSERT INTO observer_statuses (origin_id, origin, freq, cr, sf, bw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_id) DO UPDATE SET
        origin = excluded.origin,
        freq = excluded.freq,
        cr = excluded.cr,
        sf = excluded.sf,
        bw = excluded.bw,
        updated_at = excluded.updated_at
    `).run(status.originId, status.origin ?? null, freq, cr, sf, bw, status.updatedAt);
  }

  delete(originId: string): void {
    this.db.prepare("DELETE FROM observer_statuses WHERE origin_id = ?").run(originId);
  }

  deleteOlderThan(updatedAt: number): void {
    this.db.prepare("DELETE FROM observer_statuses WHERE updated_at < ?").run(updatedAt);
  }

  loadMeshcoreHistory(): MeshcoreHistoryRecord[] {
    const rows = this.db.prepare(`
      SELECT queue_item_json, advert_json
      FROM meshcore_history
      ORDER BY updated_at DESC
    `).all() as unknown as MeshcoreHistoryRow[];

    const records: MeshcoreHistoryRecord[] = [];
    for (const row of rows) {
      try {
        records.push({
          queueItem: JSON.parse(row.queue_item_json) as DashboardQueueItem,
          advert: row.advert_json ? JSON.parse(row.advert_json) as DashboardAdvertLocation : undefined,
        });
      } catch {
        // Ignore malformed persisted rows; the cleanup window will remove stale data.
      }
    }

    return records;
  }

  upsertMeshcoreHistory(record: MeshcoreHistoryRecord): void {
    const updatedAt = Date.parse(record.queueItem.updatedAt);
    if (!Number.isFinite(updatedAt)) {
      return;
    }

    this.db.prepare(`
      INSERT INTO meshcore_history (request_id, updated_at, queue_item_json, advert_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        queue_item_json = excluded.queue_item_json,
        advert_json = excluded.advert_json
    `).run(
      record.queueItem.job.requestId,
      updatedAt,
      JSON.stringify(record.queueItem),
      record.advert ? JSON.stringify(record.advert) : null
    );
  }

  deleteMeshcoreHistoryOlderThan(updatedAt: number): void {
    this.db.prepare("DELETE FROM meshcore_history WHERE updated_at < ?").run(updatedAt);
  }

  close(): void {
    this.db.close();
  }
}
