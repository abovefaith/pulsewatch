import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Incident } from '../types.ts';

type IncidentRow = {
  id: number;
  monitor_id: string;
  started_at: number;
  resolved_at: number | null;
  cause: string;
};

const toIncident = (row: IncidentRow): Incident => ({
  id: row.id,
  monitorId: row.monitor_id,
  startedAt: row.started_at,
  resolvedAt: row.resolved_at,
  cause: row.cause,
});

export class IncidentRepository {
  readonly #statements: Record<
    'findOpen' | 'open' | 'resolve' | 'listForMonitor' | 'countOpen',
    StatementSync
  >;

  constructor(db: DatabaseSync) {
    this.#statements = {
      findOpen: db.prepare(
        'SELECT * FROM incidents WHERE monitor_id = $monitor_id AND resolved_at IS NULL',
      ),
      open: db.prepare(`
        INSERT INTO incidents (monitor_id, started_at, cause)
        VALUES ($monitor_id, $started_at, $cause)
        RETURNING *`),
      resolve: db.prepare(
        'UPDATE incidents SET resolved_at = $resolved_at WHERE id = $id RETURNING *',
      ),
      listForMonitor: db.prepare(
        'SELECT * FROM incidents WHERE monitor_id = $monitor_id ORDER BY started_at DESC LIMIT $limit',
      ),
      countOpen: db.prepare('SELECT COUNT(*) AS count FROM incidents WHERE resolved_at IS NULL'),
    };
  }

  findOpen(monitorId: string): Incident | undefined {
    const row = this.#statements.findOpen.get({ monitor_id: monitorId }) as IncidentRow | undefined;
    return row && toIncident(row);
  }

  open(monitorId: string, startedAt: number, cause: string): Incident {
    const row = this.#statements.open.get({
      monitor_id: monitorId,
      started_at: startedAt,
      cause,
    }) as IncidentRow;
    return toIncident(row);
  }

  resolve(id: number, resolvedAt: number): Incident {
    const row = this.#statements.resolve.get({ id, resolved_at: resolvedAt }) as IncidentRow;
    return toIncident(row);
  }

  listForMonitor(monitorId: string, limit = 50): Incident[] {
    const rows = this.#statements.listForMonitor.all({ monitor_id: monitorId, limit });
    return (rows as IncidentRow[]).map(toIncident);
  }

  countOpen(): number {
    return (this.#statements.countOpen.get() as { count: number }).count;
  }
}
