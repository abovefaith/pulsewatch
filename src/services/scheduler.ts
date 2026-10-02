import type { Logger } from 'pino';
import { ConcurrencyLimiter } from '../lib/concurrency.ts';
import type { CheckRepository } from '../repositories/checks.ts';
import type { MonitorRepository } from '../repositories/monitors.ts';
import type { Monitor } from '../types.ts';
import type { CheckRunner } from './check-runner.ts';

export interface SchedulerDeps {
  monitors: MonitorRepository;
  checks: CheckRepository;
  runner: CheckRunner;
  log: Logger;
  concurrency: number;
  retentionDays: number;
  tickMs?: number;
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * A single lightweight tick loop decides which monitors are due, instead of one
 * timer per monitor. That makes interval changes, pauses and deletes take
 * effect on the next tick with no timer bookkeeping, and the concurrency
 * limiter protects both this process and the targets from bursts.
 */
export class Scheduler {
  readonly #deps: SchedulerDeps;
  readonly #limiter: ConcurrencyLimiter;
  readonly #nextRunAt = new Map<string, number>();
  readonly #inFlight = new Set<string>();
  readonly #dispatches = new Set<Promise<void>>();
  #tickTimer: NodeJS.Timeout | undefined;
  #pruneTimer: NodeJS.Timeout | undefined;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
    this.#limiter = new ConcurrencyLimiter(deps.concurrency);
  }

  get running(): boolean {
    return this.#tickTimer !== undefined;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  start(): void {
    if (this.running) return;
    this.#tickTimer = setInterval(() => this.tick(), this.#deps.tickMs ?? 1000);
    this.#pruneTimer = setInterval(() => this.prune(), HOUR_MS).unref();
    this.tick();
    this.prune();
    this.#deps.log.info({ concurrency: this.#deps.concurrency }, 'Scheduler started');
  }

  /** Dispatches every due monitor. Returns how many checks were started. */
  tick(): number {
    const now = (this.#deps.now ?? Date.now)();
    const active = this.#deps.monitors.listActive();
    let started = 0;

    for (const monitor of active) {
      if (this.#inFlight.has(monitor.id)) continue;
      if ((this.#nextRunAt.get(monitor.id) ?? 0) > now) continue;
      this.#nextRunAt.set(monitor.id, now + monitor.intervalSeconds * 1000);
      const dispatch = this.#dispatch(monitor);
      this.#dispatches.add(dispatch);
      void dispatch.finally(() => this.#dispatches.delete(dispatch));
      started++;
    }

    // Forget monitors that were deleted or paused so the map can't grow forever.
    if (this.#nextRunAt.size > active.length) {
      const activeIds = new Set(active.map((m) => m.id));
      for (const id of this.#nextRunAt.keys()) if (!activeIds.has(id)) this.#nextRunAt.delete(id);
    }
    return started;
  }

  /** Resets a monitor's schedule so changes (e.g. a new interval) apply immediately. */
  reschedule(monitorId: string): void {
    this.#nextRunAt.delete(monitorId);
  }

  prune(): void {
    const cutoff = (this.#deps.now ?? Date.now)() - this.#deps.retentionDays * 24 * HOUR_MS;
    const removed = this.#deps.checks.deleteOlderThan(cutoff);
    if (removed > 0) this.#deps.log.info({ removed }, 'Pruned old check results');
  }

  /** Resolves once every dispatched check (running or queued) has completed. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#dispatches]);
  }

  /** Stops scheduling new checks and waits for in-flight ones to finish. */
  async stop(): Promise<void> {
    const wasRunning = this.running;
    clearInterval(this.#tickTimer);
    clearInterval(this.#pruneTimer);
    this.#tickTimer = undefined;
    await this.idle();
    if (wasRunning) this.#deps.log.info('Scheduler stopped');
  }

  async #dispatch(monitor: Monitor): Promise<void> {
    this.#inFlight.add(monitor.id);
    try {
      const { check } = await this.#limiter.run(() => this.#deps.runner.run(monitor));
      this.#deps.log.debug(
        { monitor: monitor.name, ok: check.ok, latencyMs: check.latencyMs, error: check.error },
        'Check completed',
      );
    } catch (error) {
      this.#deps.log.error({ err: error, monitor: monitor.name }, 'Check failed unexpectedly');
    } finally {
      this.#inFlight.delete(monitor.id);
    }
  }
}
