# Pulsewatch

Self-hosted uptime monitor: scheduled HTTP checks → incident detection → signed webhooks, a live SSE status page and Prometheus metrics. It is a **portfolio project** for showing employers modern Node.js skills, so code quality, readable design and a strong README matter as much as features. Repo: https://github.com/abovefaith/pulsewatch (CI green on Linux and Windows with Node 24 and 25, plus a Docker smoke test).

The owner is learning Node.js. Explain the reasoning behind changes so they can talk about them in interviews.

## Commands

```bash
npm run dev            # node --watch, reads .env (local dev uses PORT=3917)
npm test               # node:test, about 1s, 38 tests
npm run test:coverage  # built-in coverage (about 97% lines)
npm run typecheck      # tsc (TypeScript 7), type checking only, no emit
npm run lint           # Biome; `npm run format` auto-fixes
npm run check          # lint + typecheck + test; run this before declaring work done
npm run seed           # adds demo monitors, including one that always fails
```

## Stack and hard rules

- **Node 24+ runs `.ts` directly through type stripping. There is no build step.** Code must use erasable TypeScript syntax only (`erasableSyntaxOnly` enforces this):
  - no `enum`, `namespace` or constructor parameter properties; declare fields explicitly
  - relative imports include the `.ts` extension (`import { x } from './foo.ts'`)
  - type-only imports use `import type` / inline `type` (`verbatimModuleSyntax`)
- Runtime dependencies are deliberately limited to `fastify`, `pino` and `zod`. Prefer Node built-ins (`node:sqlite`, `node:test`, `fetch`, `node:crypto`, `node:timers/promises`). Ask before adding a dependency.
- Use `#private` class fields, inject dependencies through constructor deps objects, and avoid module-level singletons.
- Formatting: Biome, 2 spaces, single quotes, 100-column lines. **LF line endings are enforced by `.gitattributes`.** Windows CI once failed lint because of CRLF, so don't remove that file.

## Architecture

- `src/server.ts`: entry point. Loads config, creates the context, listens, starts the scheduler, and handles graceful shutdown on SIGINT/SIGTERM.
- `src/context.ts`: **composition root** that wires everything. `createContext(config, overrides)` and `closeContext(ctx)`; tests use the same functions.
- `src/app.ts`: `buildApp(ctx)` Fastify factory with rate limiting, security headers, metrics hooks and the SSE hub. It doesn't listen, so tests can use `app.inject()`.
- `src/config.ts`: Zod-validated environment variables. A new env var goes here, in `.env.example` and in the README config table.
- `src/db/`: `node:sqlite` in WAL mode. `migrations.ts` is an **append-only array** whose versions are tracked through `PRAGMA user_version`. Never edit a shipped migration; add a new one.
- `src/repositories/`: prepared statements that map snake_case rows to camelCase domain types (`src/types.ts`). Timestamps are stored as epoch milliseconds and serialized to ISO strings in `src/http/serializers.ts`.
- `src/services/`:
  - `checker.ts`: one probe; never throws
  - `check-runner.ts`: probe → transaction (insert check + incident state machine) → bus events
  - `scheduler.ts`: 1-second tick loop with a concurrency limiter and retention pruning
  - `notifier.ts`: webhooks with retries and HMAC signing
  - `events.ts`: typed EventEmitter
- `src/http/`: API-key auth (hashed values compared with `timingSafeEqual`), the error envelope `{ error: { code, message, details? } }`, the SSE hub and serializers.
- `src/routes/monitors.ts`: authenticated `/api/monitors` (auth hook scoped to this plugin). `src/routes/public.ts`: the dashboard, `/api/status`, `/api/events`, health probes and `/metrics`. Public endpoints must **never expose target URLs or webhook URLs**.
- `src/lib/`: dependency-free building blocks (concurrency limiter, retry, token bucket, Prometheus registry). Each has unit tests.
- `public/index.html`: a single-file vanilla JS dashboard with no frontend framework.

## Testing conventions

- Use `test/helpers.ts`: `createTestApp(env?, overrides?)` (in-memory DB, silent logger), `startServer(handler)` / `startSwitchableServer(status)` for real local targets and webhook receivers, and the `auth` headers.
- Clean up with `await using` (explicit resource management). Don't mock `fetch`; point checks at a real local server.
- Wait for scheduler work with `ctx.scheduler.idle()` rather than event timing (a race was fixed this way), and for webhooks with `ctx.notifier.flush()`.
- New behaviour needs a test. Keep the suite fast (about 1s total).

## Documentation

`README.md` is written for recruiters and employers. When you add a feature, update the feature list, the API table and, if relevant, the "Design decisions" or "Limits and next steps" sections. Candidate next features: TCP, DNS and TLS-expiry checks; Slack and email channels; an OpenAPI spec; private-IP (SSRF) blocking; a dashboard screenshot in the README.
