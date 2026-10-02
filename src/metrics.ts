import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry } from './lib/metrics.ts';
import type { IncidentRepository } from './repositories/incidents.ts';
import type { MonitorRepository } from './repositories/monitors.ts';

export type AppMetrics = ReturnType<typeof createMetrics>;

export function createMetrics(sources: {
  monitors: MonitorRepository;
  incidents: IncidentRepository;
}) {
  const registry = new Registry();

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();

  const metrics = {
    registry,
    eventLoopDelay,

    checksTotal: registry.register(
      new Counter({
        name: 'pulsewatch_checks_total',
        help: 'Checks performed, by monitor and result.',
      }),
    ),
    checkDuration: registry.register(
      new Histogram({
        name: 'pulsewatch_check_duration_seconds',
        help: 'Time to response headers for successful requests.',
        buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      }),
    ),
    webhooksTotal: registry.register(
      new Counter({ name: 'pulsewatch_webhooks_total', help: 'Webhook deliveries, by result.' }),
    ),
    httpRequestsTotal: registry.register(
      new Counter({ name: 'pulsewatch_http_requests_total', help: 'HTTP requests served.' }),
    ),
    httpRequestDuration: registry.register(
      new Histogram({
        name: 'pulsewatch_http_request_duration_seconds',
        help: 'HTTP request latency.',
        buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      }),
    ),
    sseClients: { value: 0 },
  };

  registry.register(
    new Gauge({
      name: 'pulsewatch_monitors',
      help: 'Configured monitors, by state.',
      collect: () => {
        const all = sources.monitors.list();
        const paused = all.filter((m) => m.paused).length;
        return [
          { labels: { state: 'active' }, value: all.length - paused },
          { labels: { state: 'paused' }, value: paused },
        ];
      },
    }),
  );
  registry.register(
    new Gauge({
      name: 'pulsewatch_open_incidents',
      help: 'Currently open incidents.',
      collect: () => sources.incidents.countOpen(),
    }),
  );
  registry.register(
    new Gauge({
      name: 'pulsewatch_sse_clients',
      help: 'Connected live-update (SSE) clients.',
      collect: () => metrics.sseClients.value,
    }),
  );
  registry.register(
    new Gauge({
      name: 'nodejs_eventloop_delay_p99_seconds',
      help: 'p99 event loop delay — a high value means the main thread is blocked.',
      collect: () => eventLoopDelay.percentile(99) / 1e9,
    }),
  );
  registry.register(
    new Gauge({
      name: 'process_resident_memory_bytes',
      help: 'Resident memory size in bytes.',
      collect: () => process.memoryUsage.rss(),
    }),
  );
  registry.register(
    new Gauge({
      name: 'process_uptime_seconds',
      help: 'Process uptime in seconds.',
      collect: () => Math.round(process.uptime()),
    }),
  );

  return metrics;
}
