import type { CheckOutcome, Monitor } from '../types.ts';

export interface CheckerOptions {
  fetch?: typeof fetch;
  /** Aborts in-flight checks, e.g. during graceful shutdown. */
  signal?: AbortSignal;
}

const USER_AGENT = 'Pulsewatch/1.0 (uptime monitor)';

/** Probes a monitor's target once. Never throws: failures become a failed outcome. */
export async function runCheck(
  monitor: Pick<Monitor, 'url' | 'method' | 'timeoutMs' | 'expectedStatus'>,
  { fetch: fetchImpl = fetch, signal }: CheckerOptions = {},
): Promise<CheckOutcome> {
  const timeout = AbortSignal.timeout(monitor.timeoutMs);
  const started = performance.now();

  try {
    const response = await fetchImpl(monitor.url, {
      method: monitor.method,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    // Time-to-headers is the latency we care about; skip downloading the body.
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    await response.body?.cancel();

    const ok = isExpectedStatus(response.status, monitor.expectedStatus);
    return {
      ok,
      statusCode: response.status,
      latencyMs,
      error: ok ? null : `Unexpected status ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      error: describeError(error, monitor.timeoutMs),
    };
  }
}

export function isExpectedStatus(status: number, expected: number | null): boolean {
  return expected === null ? status >= 200 && status < 400 : status === expected;
}

function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException) {
    if (error.name === 'TimeoutError') return `Timed out after ${timeoutMs}ms`;
    if (error.name === 'AbortError') return 'Check aborted';
  }
  if (error instanceof Error) {
    // undici wraps network failures as `TypeError: fetch failed` with the real reason in `cause`.
    const cause = error.cause as { code?: string; message?: string } | undefined;
    if (cause?.code) return `${cause.code}: ${cause.message ?? error.message}`;
    return error.message;
  }
  return String(error);
}
