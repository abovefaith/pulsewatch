export type HttpMethod = 'GET' | 'HEAD' | 'POST';

export interface Monitor {
  id: string;
  name: string;
  url: string;
  method: HttpMethod;
  intervalSeconds: number;
  timeoutMs: number;
  /** Exact status code to expect; `null` accepts any 2xx/3xx response. */
  expectedStatus: number | null;
  /** Consecutive failed checks required before an incident is opened. */
  failureThreshold: number;
  webhookUrl: string | null;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The result of probing a target, before it is persisted. */
export interface CheckOutcome {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface Check extends CheckOutcome {
  id: number;
  monitorId: string;
  checkedAt: number;
}

export interface Incident {
  id: number;
  monitorId: string;
  startedAt: number;
  resolvedAt: number | null;
  cause: string;
}

export interface UptimeStats {
  windowStart: number;
  totalChecks: number;
  successfulChecks: number;
  uptimePercent: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}
