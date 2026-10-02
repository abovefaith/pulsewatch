import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { AppContext } from './context.ts';
import { errorHandler, HttpError } from './http/errors.ts';
import { SseHub } from './http/sse.ts';
import { TokenBucketLimiter } from './lib/rate-limit.ts';
import { monitorRoutes } from './routes/monitors.ts';
import { publicRoutes } from './routes/public.ts';

/**
 * Builds the HTTP application without starting it, so tests can exercise the
 * full request pipeline in-process with `app.inject()`.
 */
export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    loggerInstance: ctx.log,
    bodyLimit: 64 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` },
    }),
  );

  const limiter = new TokenBucketLimiter({
    capacity: ctx.config.RATE_LIMIT_PER_MINUTE,
    refillPerMinute: ctx.config.RATE_LIMIT_PER_MINUTE,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || request.url.startsWith('/api/events')) return;
    const result = limiter.take(request.ip);
    reply.header('ratelimit-limit', result.limit);
    reply.header('ratelimit-remaining', result.remaining);
    if (!result.allowed) {
      reply.header('retry-after', result.retryAfterSeconds);
      throw new HttpError(429, 'rate_limited', 'Too many requests, slow down');
    }
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const labels = { method: request.method, route, status: reply.statusCode };
    ctx.metrics.httpRequestsTotal.inc(labels);
    ctx.metrics.httpRequestDuration.observe(reply.elapsedTime / 1000, {
      method: request.method,
      route,
    });
  });

  // Long-lived SSE streams would otherwise block `app.close()` forever.
  const sse = new SseHub(ctx.bus);
  app.addHook('preClose', async () => sse.dispose());

  await app.register(publicRoutes(ctx, sse));
  await app.register(monitorRoutes(ctx), { prefix: '/api/monitors' });

  return app;
}
