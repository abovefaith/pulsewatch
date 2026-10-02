import type { DatabaseSync } from 'node:sqlite';
import { type Logger, pino } from 'pino';
import type { Config } from './config.ts';
import { openDatabase } from './db/database.ts';
import { type AppMetrics, createMetrics } from './metrics.ts';
import { CheckRepository } from './repositories/checks.ts';
import { IncidentRepository } from './repositories/incidents.ts';
import { MonitorRepository } from './repositories/monitors.ts';
import { CheckRunner } from './services/check-runner.ts';
import { createEventBus, type EventBus } from './services/events.ts';
import { WebhookNotifier } from './services/notifier.ts';
import { Scheduler } from './services/scheduler.ts';

export interface AppContext {
  config: Config;
  log: Logger;
  db: DatabaseSync;
  monitors: MonitorRepository;
  checks: CheckRepository;
  incidents: IncidentRepository;
  bus: EventBus;
  metrics: AppMetrics;
  runner: CheckRunner;
  scheduler: Scheduler;
  notifier: WebhookNotifier;
  /** Aborted on shutdown so in-flight outbound requests stop promptly. */
  shutdown: AbortController;
}

export interface ContextOverrides {
  log?: Logger;
  fetch?: typeof fetch;
  webhookBaseDelayMs?: number;
}

/**
 * Composition root: wires every dependency explicitly (no DI framework, no
 * module-level singletons), which is what makes each piece easy to test.
 */
export function createContext(config: Config, overrides: ContextOverrides = {}): AppContext {
  const log =
    overrides.log ??
    pino({
      level: config.LOG_LEVEL,
      base: { service: 'pulsewatch' },
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
    });

  const db = openDatabase(config.DATABASE_PATH);
  const monitors = new MonitorRepository(db);
  const checks = new CheckRepository(db);
  const incidents = new IncidentRepository(db);
  const metrics = createMetrics({ monitors, incidents });
  const shutdown = new AbortController();

  const bus = createEventBus();
  bus.on('error', (error) => log.error({ err: error }, 'Event listener failed'));
  bus.on('incident', ({ type, monitor, incident }) => {
    const level = type === 'opened' ? 'warn' : 'info';
    log[level](
      { monitor: monitor.name, incidentId: incident.id, cause: incident.cause },
      `Incident ${type}`,
    );
  });

  const runner = new CheckRunner({
    db,
    checks,
    incidents,
    bus,
    metrics,
    signal: shutdown.signal,
    ...(overrides.fetch && { fetch: overrides.fetch }),
  });

  const scheduler = new Scheduler({
    monitors,
    checks,
    runner,
    log: log.child({ component: 'scheduler' }),
    concurrency: config.CHECK_CONCURRENCY,
    retentionDays: config.RETENTION_DAYS,
  });

  const notifier = new WebhookNotifier({
    log: log.child({ component: 'webhooks' }),
    metrics,
    secret: config.WEBHOOK_SECRET,
    ...(overrides.fetch && { fetch: overrides.fetch }),
    ...(overrides.webhookBaseDelayMs !== undefined && {
      baseDelayMs: overrides.webhookBaseDelayMs,
    }),
  });
  notifier.attach(bus);

  return {
    config,
    log,
    db,
    monitors,
    checks,
    incidents,
    bus,
    metrics,
    runner,
    scheduler,
    notifier,
    shutdown,
  };
}

/** Releases resources in dependency order: stop producing work, drain it, then close storage. */
export async function closeContext(ctx: AppContext): Promise<void> {
  ctx.shutdown.abort();
  await ctx.scheduler.stop();
  await ctx.notifier.flush();
  ctx.notifier.detach(ctx.bus);
  ctx.metrics.eventLoopDelay.disable();
  ctx.db.close();
}
