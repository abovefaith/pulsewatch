import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Check, CheckOutcome, UptimeStats } from '../types.ts';

type CheckRow = {
  id: number;
  monitor_id: string;
  checked_at: number;
  ok: number;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
};

const toCheck = (row: CheckRow): Check => ({
  id: row.id,
  monitorId: row.monitor_id,
  checkedAt: row.checked_at,
  ok: row.ok === 1,
  statusCode: row.status_code,
  latencyMs: row.latency_ms,
  error: row.error,
});

export class CheckRepository {
  readonly #statements: Record<
    'insert' | 'recent' | 'before' | 'summary' | 'percentile' | 'prune',
    StatementSync
  >;

  constructor(db: DatabaseSync) {
    this.#statements = {
      insert: db.prepare(`
        INSERT INTO checks (monitor_id, checked_at, ok, status_code, latency_ms, error)
        VALUES ($monitor_id, $checked_at, $ok, $status_code, $latency_ms, $error)
        RETURNING *`),
      recent: db.prepare(
        'SELECT * FROM checks WHERE monitor_id = $monitor_id ORDER BY id DESC LIMIT $limit',
      ),
      before: db.prepare(`
        SELECT * FROM checks WHERE monitor_id = $monitor_id AND id < $before
        ORDER BY id DESC LIMIT $limit`),
      summary: db.prepare(`
        SELECT COUNT(*)              AS total,
               COALESCE(SUM(ok), 0)  AS up,
               AVG(latency_ms)       AS avg_latency,
               COUNT(latency_ms)     AS measured
        FROM checks WHERE monitor_id = $monitor_id AND checked_at >= $since`),
      // Nearest-rank percentile computed in SQL so we never load every row into memory.
      percentile: db.prepare(`
        SELECT latency_ms FROM checks
        WHERE monitor_id = $monitor_id AND checked_at >= $since AND latency_ms IS NOT NULL
        ORDER BY latency_ms LIMIT 1 OFFSET $offset`),
      prune: db.prepare('DELETE FROM checks WHERE checked_at < $cutoff'),
    };
  }

  insert(monitorId: string, outcome: CheckOutcome, checkedAt = Date.now()): Check {
    const row = this.#statements.insert.get({
      monitor_id: monitorId,
      checked_at: checkedAt,
      ok: outcome.ok ? 1 : 0,
      status_code: outcome.statusCode,
      latency_ms: outcome.latencyMs,
      error: outcome.error,
    }) as CheckRow;
    return toCheck(row);
  }

  /** Newest first. Pass `before` (a check id) for cursor-based pagination. */
  list(monitorId: string, { limit, before }: { limit: number; before?: number }): Check[] {
    const rows =
      before === undefined
        ? this.#statements.recent.all({ monitor_id: monitorId, limit })
        : this.#statements.before.all({ monitor_id: monitorId, before, limit });
    return (rows as CheckRow[]).map(toCheck);
  }

  stats(monitorId: string, since: number): UptimeStats {
    const summary = this.#statements.summary.get({ monitor_id: monitorId, since }) as {
      total: number;
      up: number;
      avg_latency: number | null;
      measured: number;
    };

    let p95: number | null = null;
    if (summary.measured > 0) {
      const offset = Math.ceil(0.95 * summary.measured) - 1;
      const row = this.#statements.percentile.get({ monitor_id: monitorId, since, offset }) as
        | { latency_ms: number }
        | undefined;
      p95 = row?.latency_ms ?? null;
    }

    return {
      windowStart: since,
      totalChecks: summary.total,
      successfulChecks: summary.up,
      uptimePercent: summary.total > 0 ? round((summary.up / summary.total) * 100, 3) : null,
      avgLatencyMs: summary.avg_latency === null ? null : round(summary.avg_latency, 1),
      p95LatencyMs: p95,
    };
  }

  deleteOlderThan(cutoff: number): number {
    return Number(this.#statements.prune.run({ cutoff }).changes);
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
