import type { ServerResponse } from 'node:http';
import type { CheckEvent, EventBus, IncidentEvent } from '../services/events.ts';

/** Drop clients that stop reading rather than buffering for them indefinitely. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Fans bus events out to Server-Sent Events clients. The hub subscribes to the
 * bus once (not once per client), so 1,000 dashboards cost one listener.
 * Only public fields are broadcast — never URLs or webhook targets.
 */
export class SseHub {
  readonly #bus: EventBus;
  readonly #clients = new Set<ServerResponse>();
  readonly #heartbeatMs: number;
  #heartbeat: NodeJS.Timeout | undefined;
  #nextId = 0;

  readonly #onCheck = ({ monitor, check }: CheckEvent) =>
    this.broadcast('check', {
      monitorId: monitor.id,
      name: monitor.name,
      ok: check.ok,
      latencyMs: check.latencyMs,
      checkedAt: new Date(check.checkedAt).toISOString(),
    });

  readonly #onIncident = ({ type, monitor, incident }: IncidentEvent) =>
    this.broadcast('incident', {
      type,
      monitorId: monitor.id,
      name: monitor.name,
      cause: incident.cause,
      startedAt: new Date(incident.startedAt).toISOString(),
    });

  constructor(bus: EventBus, { heartbeatMs = 15_000 } = {}) {
    this.#bus = bus;
    this.#heartbeatMs = heartbeatMs;
    bus.on('check', this.#onCheck);
    bus.on('incident', this.#onIncident);
  }

  get size(): number {
    return this.#clients.size;
  }

  add(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // disable proxy buffering (nginx)
    });
    res.write('retry: 3000\n: connected\n\n');

    this.#clients.add(res);
    res.on('close', () => {
      this.#clients.delete(res);
      if (this.#clients.size === 0) this.#stopHeartbeat();
    });

    // Comments keep idle connections alive through proxies and load balancers.
    this.#heartbeat ??= setInterval(() => this.#write(': ping\n\n'), this.#heartbeatMs).unref();
  }

  broadcast(event: string, data: unknown): void {
    this.#write(`id: ${++this.#nextId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  closeAll(): void {
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    this.#stopHeartbeat();
  }

  dispose(): void {
    this.closeAll();
    this.#bus.off('check', this.#onCheck);
    this.#bus.off('incident', this.#onIncident);
  }

  #write(frame: string): void {
    for (const client of this.#clients) {
      if (client.writableLength > MAX_BUFFERED_BYTES) {
        client.destroy();
        continue;
      }
      client.write(frame);
    }
  }

  #stopHeartbeat(): void {
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }
}
