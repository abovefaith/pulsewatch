import type { Check, Incident, Monitor, UptimeStats } from '../types.ts';

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

// Internally timestamps are epoch milliseconds (cheap to index and compare);
// the API speaks ISO 8601.

export const serializeMonitor = (m: Monitor) => ({
  ...m,
  createdAt: iso(m.createdAt),
  updatedAt: iso(m.updatedAt),
});

export const serializeCheck = (c: Check) => ({ ...c, checkedAt: iso(c.checkedAt) });

export const serializeIncident = (i: Incident) => ({
  ...i,
  startedAt: iso(i.startedAt),
  resolvedAt: isoOrNull(i.resolvedAt),
  durationSeconds: i.resolvedAt === null ? null : Math.round((i.resolvedAt - i.startedAt) / 1000),
});

export const serializeStats = (s: UptimeStats) => ({ ...s, windowStart: iso(s.windowStart) });
