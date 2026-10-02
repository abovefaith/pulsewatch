import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import type { AppMetrics } from '../metrics.ts';
import type { CheckRepository } from '../repositories/checks.ts';
import type { IncidentRepository } from '../repositories/incidents.ts';
import type { Check, Monitor } from '../types.ts';
import { runCheck } from './checker.ts';
import type { EventBus, IncidentEvent } from './events.ts';

export interface CheckRunnerDeps {
  db: DatabaseSync;
  checks: CheckRepository;
  incidents: IncidentRepository;
  bus: EventBus;
  metrics: AppMetrics;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
}

export interface CheckRunResult {
  check: Check;
  incident: IncidentEvent | null;
}

/**
 * Runs a single check end-to-end: probe → persist → evaluate incident state →
 * publish events. The scheduler and the "check now" endpoint both use this.
 */
export class CheckRunner {
  readonly #deps: CheckRunnerDeps;

  constructor(deps: CheckRunnerDeps) {
    this.#deps = deps;
  }

  async run(monitor: Monitor): Promise<CheckRunResult> {
    const { db, checks, bus, metrics, fetch, signal, now = Date.now } = this.#deps;

    const outcome = await runCheck(monitor, { fetch, signal });

    // Persisting the check and the incident transition atomically keeps them consistent.
    const { check, incident } = transaction(db, () => {
      const check = checks.insert(monitor.id, outcome, now());
      return { check, incident: this.#evaluateIncident(monitor, check) };
    });

    metrics.checksTotal.inc({ monitor: monitor.name, result: check.ok ? 'up' : 'down' });
    if (check.latencyMs !== null) {
      metrics.checkDuration.observe(check.latencyMs / 1000, { monitor: monitor.name });
    }

    bus.emit('check', { monitor, check });
    if (incident) bus.emit('incident', incident);

    return { check, incident };
  }

  /**
   * Opens an incident after `failureThreshold` consecutive failures (avoids
   * alerting on a single blip) and resolves it on the first success.
   */
  #evaluateIncident(monitor: Monitor, check: Check): IncidentEvent | null {
    const { checks, incidents } = this.#deps;
    const open = incidents.findOpen(monitor.id);

    if (check.ok) {
      if (!open) return null;
      return { type: 'resolved', monitor, incident: incidents.resolve(open.id, check.checkedAt) };
    }

    if (open) return null;

    const recent = checks.list(monitor.id, { limit: monitor.failureThreshold });
    const thresholdReached =
      recent.length >= monitor.failureThreshold && recent.every((c) => !c.ok);
    if (!thresholdReached) return null;

    const cause = check.error ?? 'Check failed';
    return {
      type: 'opened',
      monitor,
      incident: incidents.open(monitor.id, check.checkedAt, cause),
    };
  }
}
