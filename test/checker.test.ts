import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { isExpectedStatus, runCheck } from '../src/services/checker.ts';
import { startServer } from './helpers.ts';

const base = { method: 'GET', timeoutMs: 1000, expectedStatus: null } as const;

describe('runCheck', () => {
  it('records status and latency for a healthy target', async () => {
    await using server = await startServer((_req, res) => res.writeHead(200).end('hello'));

    const outcome = await runCheck({ ...base, url: `${server.url}/health` });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.statusCode, 200);
    assert.equal(outcome.error, null);
    assert.ok(outcome.latencyMs !== null && outcome.latencyMs >= 0);
    assert.equal(server.requests[0]?.url, '/health');
    assert.match(String(server.requests[0]?.headers['user-agent']), /Pulsewatch/);
  });

  it('fails on an unexpected status code', async () => {
    await using server = await startServer((_req, res) => res.writeHead(503).end());
    const outcome = await runCheck({ ...base, url: server.url });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.statusCode, 503);
    assert.equal(outcome.error, 'Unexpected status 503');
  });

  it('honours an exact expected status', async () => {
    await using server = await startServer((_req, res) => res.writeHead(204).end());
    assert.equal((await runCheck({ ...base, url: server.url, expectedStatus: 204 })).ok, true);
    assert.equal((await runCheck({ ...base, url: server.url, expectedStatus: 200 })).ok, false);
  });

  it('times out slow targets', async () => {
    await using server = await startServer((_req, res) => {
      setTimeout(() => res.writeHead(200).end(), 500).unref();
    });
    const outcome = await runCheck({ ...base, url: server.url, timeoutMs: 100 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'Timed out after 100ms');
  });

  it('reports connection errors with their code', async () => {
    // Grab a free port, then close it so nothing is listening there.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise((resolve) => probe.close(resolve));

    const outcome = await runCheck({ ...base, url: `http://127.0.0.1:${port}` });
    assert.equal(outcome.ok, false);
    assert.match(String(outcome.error), /ECONNREFUSED/);
  });

  it('can be aborted by an external signal', async () => {
    await using server = await startServer(() => {
      /* never responds */
    });
    const controller = new AbortController();
    const pending = runCheck({ ...base, url: server.url }, { signal: controller.signal });
    controller.abort();
    assert.equal((await pending).error, 'Check aborted');
  });
});

describe('isExpectedStatus', () => {
  it('accepts 2xx/3xx when no exact status is configured', () => {
    assert.equal(isExpectedStatus(200, null), true);
    assert.equal(isExpectedStatus(301, null), true);
    assert.equal(isExpectedStatus(404, null), false);
    assert.equal(isExpectedStatus(500, null), false);
  });
});
