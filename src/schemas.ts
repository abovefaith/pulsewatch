import { z } from 'zod';

const httpUrl = z.url({ protocol: /^https?$/, error: 'must be a valid http(s) URL' });

// Field rules are shared; defaults only apply on create so PATCH stays a true partial update.
const monitorFields = {
  name: z.string().trim().min(1).max(100),
  url: httpUrl,
  method: z.enum(['GET', 'HEAD', 'POST']),
  intervalSeconds: z.number().int().min(5).max(86_400),
  timeoutMs: z.number().int().min(100).max(30_000),
  expectedStatus: z.number().int().min(100).max(599).nullable(),
  failureThreshold: z.number().int().min(1).max(10),
  webhookUrl: httpUrl.nullable(),
  paused: z.boolean(),
};

export const monitorCreateSchema = z.strictObject({
  name: monitorFields.name,
  url: monitorFields.url,
  method: monitorFields.method.default('GET'),
  intervalSeconds: monitorFields.intervalSeconds.default(60),
  timeoutMs: monitorFields.timeoutMs.default(5000),
  expectedStatus: monitorFields.expectedStatus.default(null),
  failureThreshold: monitorFields.failureThreshold.default(3),
  webhookUrl: monitorFields.webhookUrl.default(null),
  paused: monitorFields.paused.default(false),
});

export const monitorUpdateSchema = z
  .strictObject(monitorFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'at least one field is required');

export const idParamsSchema = z.object({ id: z.uuid() });

export const checksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export const statsWindows = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const;

export const statsQuerySchema = z.object({
  window: z.enum(Object.keys(statsWindows) as [keyof typeof statsWindows]).default('24h'),
});

export type MonitorCreateInput = z.infer<typeof monitorCreateSchema>;
export type MonitorUpdateInput = z.infer<typeof monitorUpdateSchema>;
