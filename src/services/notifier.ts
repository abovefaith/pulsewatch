import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import { NonRetryableError, retry } from '../lib/retry.ts';
import type { AppMetrics } from '../metrics.ts';
import type { EventBus, IncidentEvent } from './events.ts';

export const SIGNATURE_HEADER = 'x-pulsewatch-signature';

export interface NotifierDeps {
  log: Logger;
  metrics: AppMetrics;
  secret?: string | undefined;
  fetch?: typeof fetch;
  retries?: number;
  baseDelayMs?: number;
}

/**
 * Delivers incident webhooks with retries and Stripe-style HMAC signatures.
 * Deliveries run in the background; `flush()` lets shutdown wait for them.
 */
export class WebhookNotifier {
  readonly #deps: NotifierDeps;
  readonly #pending = new Set<Promise<void>>();
  readonly #listener = (event: IncidentEvent) => this.#track(this.deliver(event));

  constructor(deps: NotifierDeps) {
    this.#deps = deps;
  }

  attach(bus: EventBus): void {
    bus.on('incident', this.#listener);
  }

  detach(bus: EventBus): void {
    bus.off('incident', this.#listener);
  }

  async deliver({ type, monitor, incident }: IncidentEvent): Promise<void> {
    if (!monitor.webhookUrl) return;
    const { log, metrics, secret, fetch: fetchImpl = fetch, retries = 4, baseDelayMs } = this.#deps;
    const url = monitor.webhookUrl;

    const body = JSON.stringify({
      event: `incident.${type}`,
      sentAt: new Date().toISOString(),
      monitor: { id: monitor.id, name: monitor.name, url: monitor.url },
      incident: {
        id: incident.id,
        cause: incident.cause,
        startedAt: new Date(incident.startedAt).toISOString(),
        resolvedAt: incident.resolvedAt ? new Date(incident.resolvedAt).toISOString() : null,
      },
    });

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers[SIGNATURE_HEADER] = signPayload(secret, body);

    try {
      await retry(
        async () => {
          const response = await fetchImpl(url, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(10_000),
          });
          await response.body?.cancel();
          if (response.ok) return;
          const message = `Webhook responded with ${response.status}`;
          // 4xx means the receiver rejected the payload; retrying won't help (except 408/429).
          const permanent =
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429;
          throw permanent ? new NonRetryableError(message) : new Error(message);
        },
        {
          retries,
          ...(baseDelayMs === undefined ? {} : { baseDelayMs }),
          onRetry: (error, attempt, delayMs) =>
            log.warn({ err: error, url, attempt, delayMs }, 'Webhook delivery failed, retrying'),
        },
      );
      metrics.webhooksTotal.inc({ result: 'delivered' });
      log.info({ url, event: type, monitor: monitor.name }, 'Webhook delivered');
    } catch (error) {
      metrics.webhooksTotal.inc({ result: 'failed' });
      log.error({ err: error, url, event: type, monitor: monitor.name }, 'Webhook delivery failed');
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  #track(promise: Promise<void>): void {
    this.#pending.add(promise);
    void promise.finally(() => this.#pending.delete(promise));
  }
}

/** Signature format: `t=<unix seconds>,v1=<hex hmac-sha256 of "t.body">`. */
export function signPayload(secret: string, body: string, timestamp = Date.now()): string {
  const t = Math.floor(timestamp / 1000);
  const digest = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${digest}`;
}

/**
 * Receiver-side verification, exported so consumers can copy it. Uses a
 * constant-time comparison and a timestamp tolerance to block replay attacks.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  { toleranceSeconds = 300, now = Date.now() } = {},
): boolean {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || typeof parts.v1 !== 'string') return false;
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const received = Buffer.from(parts.v1, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
