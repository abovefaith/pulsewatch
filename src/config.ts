import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_KEY: z.string().min(16, 'must be at least 16 characters'),
  DATABASE_PATH: z.string().default('./data/pulsewatch.db'),
  CHECK_CONCURRENCY: z.coerce.number().int().positive().default(10),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((value) => value || undefined),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Validates environment variables once at startup so misconfiguration fails fast
 * with a readable message instead of surfacing as a runtime bug later.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
