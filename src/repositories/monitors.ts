import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { MonitorCreateInput, MonitorUpdateInput } from '../schemas.ts';
import type { HttpMethod, Monitor } from '../types.ts';

type MonitorRow = {
  id: string;
  name: string;
  url: string;
  method: string;
  interval_seconds: number;
  timeout_ms: number;
  expected_status: number | null;
  failure_threshold: number;
  webhook_url: string | null;
  paused: number;
  created_at: number;
  updated_at: number;
};

const toMonitor = (row: MonitorRow): Monitor => ({
  id: row.id,
  name: row.name,
  url: row.url,
  method: row.method as HttpMethod,
  intervalSeconds: row.interval_seconds,
  timeoutMs: row.timeout_ms,
  expectedStatus: row.expected_status,
  failureThreshold: row.failure_threshold,
  webhookUrl: row.webhook_url,
  paused: row.paused === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toParams = (monitor: Omit<Monitor, 'createdAt'>) => ({
  id: monitor.id,
  name: monitor.name,
  url: monitor.url,
  method: monitor.method,
  interval_seconds: monitor.intervalSeconds,
  timeout_ms: monitor.timeoutMs,
  expected_status: monitor.expectedStatus,
  failure_threshold: monitor.failureThreshold,
  webhook_url: monitor.webhookUrl,
  paused: monitor.paused ? 1 : 0,
  updated_at: monitor.updatedAt,
});

export class MonitorRepository {
  readonly #statements: Record<
    'list' | 'listActive' | 'findById' | 'insert' | 'update' | 'delete',
    StatementSync
  >;

  constructor(db: DatabaseSync) {
    this.#statements = {
      list: db.prepare('SELECT * FROM monitors ORDER BY created_at, id'),
      listActive: db.prepare('SELECT * FROM monitors WHERE paused = 0 ORDER BY created_at, id'),
      findById: db.prepare('SELECT * FROM monitors WHERE id = $id'),
      insert: db.prepare(`
        INSERT INTO monitors (id, name, url, method, interval_seconds, timeout_ms, expected_status,
                              failure_threshold, webhook_url, paused, created_at, updated_at)
        VALUES ($id, $name, $url, $method, $interval_seconds, $timeout_ms, $expected_status,
                $failure_threshold, $webhook_url, $paused, $created_at, $updated_at)
        RETURNING *`),
      update: db.prepare(`
        UPDATE monitors SET name = $name, url = $url, method = $method,
          interval_seconds = $interval_seconds, timeout_ms = $timeout_ms,
          expected_status = $expected_status, failure_threshold = $failure_threshold,
          webhook_url = $webhook_url, paused = $paused, updated_at = $updated_at
        WHERE id = $id
        RETURNING *`),
      delete: db.prepare('DELETE FROM monitors WHERE id = $id'),
    };
  }

  list(): Monitor[] {
    return (this.#statements.list.all() as MonitorRow[]).map(toMonitor);
  }

  listActive(): Monitor[] {
    return (this.#statements.listActive.all() as MonitorRow[]).map(toMonitor);
  }

  findById(id: string): Monitor | undefined {
    const row = this.#statements.findById.get({ id }) as MonitorRow | undefined;
    return row && toMonitor(row);
  }

  create(input: MonitorCreateInput, now = Date.now()): Monitor {
    const params = toParams({ id: randomUUID(), ...input, updatedAt: now });
    const row = this.#statements.insert.get({ ...params, created_at: now }) as MonitorRow;
    return toMonitor(row);
  }

  update(id: string, patch: MonitorUpdateInput, now = Date.now()): Monitor | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const row = this.#statements.update.get(
      toParams({ ...existing, ...patch, updatedAt: now }),
    ) as MonitorRow;
    return toMonitor(row);
  }

  delete(id: string): boolean {
    return this.#statements.delete.run({ id }).changes > 0;
  }
}
