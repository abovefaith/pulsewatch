/**
 * Adds a few demo monitors so the dashboard has something to show.
 * Usage: npm run seed   (reads DATABASE_PATH from .env, like the server)
 */
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/database.ts';
import { MonitorRepository } from '../src/repositories/monitors.ts';
import type { MonitorCreateInput } from '../src/schemas.ts';

const defaults = {
  method: 'GET',
  intervalSeconds: 30,
  timeoutMs: 5000,
  expectedStatus: null,
  failureThreshold: 2,
  webhookUrl: null,
  paused: false,
} satisfies Partial<MonitorCreateInput>;

const demoMonitors: MonitorCreateInput[] = [
  { ...defaults, name: 'Example.com', url: 'https://example.com' },
  { ...defaults, name: 'GitHub API', url: 'https://api.github.com' },
  { ...defaults, name: 'npm Registry', url: 'https://registry.npmjs.org' },
  { ...defaults, name: 'Node.js Website', url: 'https://nodejs.org', method: 'HEAD' },
  // Always returns 500, so you can watch an incident open.
  { ...defaults, name: 'Always Failing (demo)', url: 'https://httpbin.org/status/500' },
];

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
const monitors = new MonitorRepository(db);

const existing = new Set(monitors.list().map((m) => m.url));
let added = 0;
for (const input of demoMonitors) {
  if (existing.has(input.url)) continue;
  monitors.create(input);
  added++;
}
db.close();

console.log(`Seeded ${added} monitor(s) into ${config.DATABASE_PATH}`);
