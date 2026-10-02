import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../context.ts';
import type { SseHub } from '../http/sse.ts';
import { Registry } from '../lib/metrics.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_PATH = join(import.meta.dirname, '..', '..', 'public', 'index.html');

type MonitorState = 'up' | 'degraded' | 'down' | 'paused' | 'pending';

/** Unauthenticated endpoints: status page, live events, health probes and metrics. */
export function publicRoutes(ctx: AppContext, sse: SseHub): FastifyPluginAsync {
  return async (app) => {
    const dashboard = await readFile(DASHBOARD_PATH);

    app.get('/', async (_request, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        )
        .send(dashboard),
    );

    // Public status summary. Deliberately omits target URLs and webhook config.
    app.get('/api/status', async () => {
      const since = Date.now() - DAY_MS;
      const monitors = ctx.monitors.list().map((monitor) => {
        const recent = ctx.checks.list(monitor.id, { limit: 30 });
        const last = recent[0];
        const openIncident = ctx.incidents.findOpen(monitor.id);

        let state: MonitorState = 'up';
        if (monitor.paused) state = 'paused';
        else if (openIncident) state = 'down';
        else if (!last) state = 'pending';
        else if (!last.ok) state = 'degraded';

        return {
          id: monitor.id,
          name: monitor.name,
          state,
          intervalSeconds: monitor.intervalSeconds,
          uptime24h: ctx.checks.stats(monitor.id, since).uptimePercent,
          latencyMs: last?.latencyMs ?? null,
          lastCheckedAt: last ? new Date(last.checkedAt).toISOString() : null,
          openIncident: openIncident
            ? {
                cause: openIncident.cause,
                startedAt: new Date(openIncident.startedAt).toISOString(),
              }
            : null,
          recent: recent.reverse().map((c) => ({
            ok: c.ok,
            latencyMs: c.latencyMs,
            checkedAt: new Date(c.checkedAt).toISOString(),
          })),
        };
      });

      const states = new Set(monitors.map((m) => m.state));
      const overall = states.has('down')
        ? 'outage'
        : states.has('degraded')
          ? 'degraded'
          : 'operational';

      return { overall, generatedAt: new Date().toISOString(), monitors };
    });

    app.get('/api/events', (request, reply) => {
      reply.hijack(); // we take over the raw socket for a long-lived stream
      sse.add(reply.raw);
      ctx.metrics.sseClients.value = sse.size;
      request.raw.on('close', () => {
        ctx.metrics.sseClients.value = sse.size;
      });
    });

    app.get('/health/live', async () => ({ status: 'ok' }));

    app.get('/health/ready', async (_request, reply) => {
      try {
        ctx.db.prepare('SELECT 1').get();
      } catch (error) {
        ctx.log.error({ err: error }, 'Readiness check failed');
        return reply.status(503).send({ status: 'unavailable', checks: { database: 'down' } });
      }
      const scheduler = ctx.scheduler.running ? 'running' : 'stopped';
      return { status: 'ok', checks: { database: 'up', scheduler } };
    });

    app.get('/metrics', async (_request, reply) =>
      reply.type(Registry.contentType).send(ctx.metrics.registry.render()),
    );
  };
}
