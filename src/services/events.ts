import { EventEmitter } from 'node:events';
import type { Check, Incident, Monitor } from '../types.ts';

export interface CheckEvent {
  monitor: Monitor;
  check: Check;
}

export interface IncidentEvent {
  type: 'opened' | 'resolved';
  monitor: Monitor;
  incident: Incident;
}

/** Strongly-typed event map: listeners get correct payload types at compile time. */
export type MonitoringEvents = {
  check: [CheckEvent];
  incident: [IncidentEvent];
  error: [unknown];
};

export type EventBus = EventEmitter<MonitoringEvents>;

/**
 * The in-process event bus decouples producers (the scheduler) from consumers
 * (SSE stream, webhooks, metrics). `captureRejections` routes errors thrown by
 * async listeners to the 'error' event instead of crashing the process.
 */
export function createEventBus(): EventBus {
  return new EventEmitter<MonitoringEvents>({ captureRejections: true });
}
