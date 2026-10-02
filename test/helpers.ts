import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { buildApp } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config.ts';
import { type ContextOverrides, closeContext, createContext } from '../src/context.ts';

export const API_KEY = 'test-api-key-0123456789';
export const auth = { authorization: `Bearer ${API_KEY}` };

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    API_KEY,
    DATABASE_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    ...env,
  });
}

/** A fully wired app on an in-memory database. Dispose with `await using`. */
export async function createTestApp(
  env: Record<string, string> = {},
  overrides: ContextOverrides = {},
) {
  const ctx = createContext(testConfig(env), {
    log: pino({ level: 'silent' }),
    webhookBaseDelayMs: 5,
    ...overrides,
  });
  const app = await buildApp(ctx);
  return {
    ctx,
    app,
    async [Symbol.asyncDispose]() {
      await app.close();
      await closeContext(ctx);
    },
  };
}

export interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A real local HTTP server to act as a monitored target or webhook receiver. */
export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    handler(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Replies with whatever status the mutable `state.status` currently holds. */
export async function startSwitchableServer(initialStatus = 200) {
  const state = { status: initialStatus };
  const server = await startServer((_req, res) => {
    res.writeHead(state.status).end('ok');
  });
  return Object.assign(server, { state });
}
