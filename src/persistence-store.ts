import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { connect, type Database } from "@tursodatabase/database";
import type { ObserverState } from "./map-types.js";
import type { DashboardAdvertLocation, DashboardQueueItem } from "./dashboard/dashboard-state.js";

type MaybePromise<T> = T | Promise<T>;

export interface ObserverStatusStore {
  ready?: Promise<void>;
  loadAll(): MaybePromise<ObserverState[]>;
  upsert(status: ObserverState): MaybePromise<void>;
  delete(originId: string): MaybePromise<void>;
  deleteOlderThan(updatedAt: number): MaybePromise<void>;
  close?(): MaybePromise<void>;
}

export interface MeshcoreHistoryRecord {
  queueItem: DashboardQueueItem;
  advert?: DashboardAdvertLocation;
}

export interface MeshcoreHistoryStore {
  ready?: Promise<void>;
  loadMeshcoreHistory(): MaybePromise<MeshcoreHistoryRecord[]>;
  upsertMeshcoreHistory(record: MeshcoreHistoryRecord): MaybePromise<void>;
  deleteMeshcoreHistoryOlderThan(updatedAt: number): MaybePromise<void>;
}

export type PersistenceStore = ObserverStatusStore & MeshcoreHistoryStore;

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

export class TursoPersistenceStore implements PersistenceStore {
  private db?: Database;
  readonly ready: Promise<void>;

  constructor(path: string) {
    this.ready = this.open(path);
  }

  private async open(path: string): Promise<void> {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.db = await connect(path);
    await this.db.exec(`
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

  private async database(): Promise<Database> {
    await this.ready;
    if (!this.db) {
      throw new Error("Turso database connection is not open.");
    }
    return this.db;
  }

  async loadAll(): Promise<ObserverState[]> {
    const db = await this.database();
    const rows = await db.all(`
      SELECT origin_id, origin, freq, cr, sf, bw, updated_at
      FROM observer_statuses
      ORDER BY updated_at ASC
    `) as unknown as ObserverStatusRow[];

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

  async upsert(status: ObserverState): Promise<void> {
    if (!status.originId) {
      return;
    }

    const { freq, cr, sf, bw } = status.params;
    if (freq === undefined || cr === undefined || sf === undefined || bw === undefined) {
      return;
    }

    const db = await this.database();
    await db.run(`
      INSERT INTO observer_statuses (origin_id, origin, freq, cr, sf, bw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_id) DO UPDATE SET
        origin = excluded.origin,
        freq = excluded.freq,
        cr = excluded.cr,
        sf = excluded.sf,
        bw = excluded.bw,
        updated_at = excluded.updated_at
    `, status.originId, status.origin ?? null, freq, cr, sf, bw, status.updatedAt);
  }

  async delete(originId: string): Promise<void> {
    const db = await this.database();
    await db.run("DELETE FROM observer_statuses WHERE origin_id = ?", originId);
  }

  async deleteOlderThan(updatedAt: number): Promise<void> {
    const db = await this.database();
    await db.run("DELETE FROM observer_statuses WHERE updated_at < ?", updatedAt);
  }

  async loadMeshcoreHistory(): Promise<MeshcoreHistoryRecord[]> {
    const db = await this.database();
    const rows = await db.all(`
      SELECT queue_item_json, advert_json
      FROM meshcore_history
      ORDER BY updated_at DESC
    `) as unknown as MeshcoreHistoryRow[];

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

  async upsertMeshcoreHistory(record: MeshcoreHistoryRecord): Promise<void> {
    const updatedAt = Date.parse(record.queueItem.updatedAt);
    if (!Number.isFinite(updatedAt)) {
      return;
    }

    const db = await this.database();
    await db.run(`
      INSERT INTO meshcore_history (request_id, updated_at, queue_item_json, advert_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        queue_item_json = excluded.queue_item_json,
        advert_json = excluded.advert_json
    `,
      record.queueItem.job.requestId,
      updatedAt,
      JSON.stringify(record.queueItem),
      record.advert ? JSON.stringify(record.advert) : null
    );
  }

  async deleteMeshcoreHistoryOlderThan(updatedAt: number): Promise<void> {
    const db = await this.database();
    await db.run("DELETE FROM meshcore_history WHERE updated_at < ?", updatedAt);
  }

  async close(): Promise<void> {
    await this.ready;
    if (this.db?.open) {
      await this.db.close();
    }
  }
}
