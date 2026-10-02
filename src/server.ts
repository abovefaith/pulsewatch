import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { closeContext, createContext } from './context.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const ctx = createContext(config);
const app = await buildApp(ctx);

await app.listen({ host: config.HOST, port: config.PORT });
ctx.scheduler.start();

let shuttingDown = false;

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests and
 * checks finish, flush pending webhooks, then close the database. A hard
 * timeout guarantees the process exits even if something hangs.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ctx.log.info({ signal }, 'Shutting down gracefully');

  const forceExit = setTimeout(() => {
    ctx.log.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await app.close();
    await closeContext(ctx);
    ctx.log.info('Shutdown complete');
  } catch (error) {
    ctx.log.error({ err: error }, 'Error during shutdown');
    process.exitCode = 1;
  } finally {
    clearTimeout(forceExit);
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  ctx.log.fatal({ err: reason }, 'Unhandled promise rejection');
  void shutdown('SIGTERM').finally(() => process.exit(1));
});
