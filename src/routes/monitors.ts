import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../context.ts';
import { requireApiKey } from '../http/auth.ts';
import { notFound } from '../http/errors.ts';
import {
  serializeCheck,
  serializeIncident,
  serializeMonitor,
  serializeStats,
} from '../http/serializers.ts';
import {
  checksQuerySchema,
  idParamsSchema,
  monitorCreateSchema,
  monitorUpdateSchema,
  statsQuerySchema,
  statsWindows,
} from '../schemas.ts';

/** Authenticated management API. The auth hook is scoped to this plugin only. */
export function monitorRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.addHook('preHandler', requireApiKey(ctx.config.API_KEY));

    const loadMonitor = (params: unknown) => {
      const { id } = idParamsSchema.parse(params);
      const monitor = ctx.monitors.findById(id);
      if (!monitor) throw notFound('Monitor');
      return monitor;
    };

    app.get('/', async () => ({ data: ctx.monitors.list().map(serializeMonitor) }));

    app.post('/', async (request, reply) => {
      const monitor = ctx.monitors.create(monitorCreateSchema.parse(request.body));
      request.log.info({ monitorId: monitor.id, name: monitor.name }, 'Monitor created');
      return reply
        .status(201)
        .header('location', `/api/monitors/${monitor.id}`)
        .send({ data: serializeMonitor(monitor) });
    });

    app.get('/:id', async (request) => ({ data: serializeMonitor(loadMonitor(request.params)) }));

    app.patch('/:id', async (request) => {
      const { id } = loadMonitor(request.params);
      const updated = ctx.monitors.update(id, monitorUpdateSchema.parse(request.body));
      if (!updated) throw notFound('Monitor');
      ctx.scheduler.reschedule(id);
      return { data: serializeMonitor(updated) };
    });

    app.delete('/:id', async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      if (!ctx.monitors.delete(id)) throw notFound('Monitor');
      request.log.info({ monitorId: id }, 'Monitor deleted');
      return reply.status(204).send();
    });

    app.post('/:id/check', async (request) => {
      const { check, incident } = await ctx.runner.run(loadMonitor(request.params));
      return {
        data: {
          check: serializeCheck(check),
          incident: incident && { type: incident.type, ...serializeIncident(incident.incident) },
        },
      };
    });

    app.get('/:id/checks', async (request) => {
      const monitor = loadMonitor(request.params);
      const query = checksQuerySchema.parse(request.query);
      const checks = ctx.checks.list(monitor.id, {
        limit: query.limit,
        ...(query.before !== undefined && { before: query.before }),
      });
      const last = checks.at(-1);
      return {
        data: checks.map(serializeCheck),
        nextCursor: checks.length === query.limit && last ? last.id : null,
      };
    });

    app.get('/:id/stats', async (request) => {
      const monitor = loadMonitor(request.params);
      const { window } = statsQuerySchema.parse(request.query);
      const stats = ctx.checks.stats(monitor.id, Date.now() - statsWindows[window]);
      return { data: { window, ...serializeStats(stats) } };
    });

    app.get('/:id/incidents', async (request) => {
      const monitor = loadMonitor(request.params);
      return { data: ctx.incidents.listForMonitor(monitor.id).map(serializeIncident) };
    });
  };
}
