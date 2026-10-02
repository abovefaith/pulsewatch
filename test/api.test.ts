import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API_KEY, auth, createTestApp, startServer } from './helpers.ts';

const validMonitor = { name: 'Example', url: 'https://example.com' };

describe('monitors API', () => {
  it('requires an API key', async () => {
    await using t = await createTestApp();

    const missing = await t.app.inject({ method: 'GET', url: '/api/monitors' });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().error.code, 'unauthorized');

    const wrong = await t.app.inject({
      method: 'GET',
      url: '/api/monitors',
      headers: { authorization: 'Bearer nope' },
    });
    assert.equal(wrong.statusCode, 401);

    const viaHeader = await t.app.inject({
      method: 'GET',
      url: '/api/monitors',
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(viaHeader.statusCode, 200);
  });

  it('supports the full CRUD lifecycle', async () => {
    await using t = await createTestApp();

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: auth,
      payload: validMonitor,
    });
    assert.equal(created.statusCode, 201);
    const monitor = created.json().data;
    assert.equal(created.headers.location, `/api/monitors/${monitor.id}`);
    assert.equal(monitor.intervalSeconds, 60, 'defaults are applied');
    assert.equal(monitor.method, 'GET');
    assert.match(monitor.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const list = await t.app.inject({ method: 'GET', url: '/api/monitors', headers: auth });
    assert.equal(list.json().data.length, 1);

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/api/monitors/${monitor.id}`,
      headers: auth,
      payload: { intervalSeconds: 30, paused: true },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().data.intervalSeconds, 30);
    assert.equal(patched.json().data.paused, true);
    assert.equal(patched.json().data.name, 'Example', 'untouched fields are preserved');

    const deleted = await t.app.inject({
      method: 'DELETE',
      url: `/api/monitors/${monitor.id}`,
      headers: auth,
    });
    assert.equal(deleted.statusCode, 204);

    const gone = await t.app.inject({
      method: 'GET',
      url: `/api/monitors/${monitor.id}`,
      headers: auth,
    });
    assert.equal(gone.statusCode, 404);
  });

  it('rejects invalid input with field-level details', async () => {
    await using t = await createTestApp();

    const response = await t.app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: auth,
      payload: { name: '', url: 'ftp://example.com', intervalSeconds: 1, unknownField: true },
    });

    assert.equal(response.statusCode, 400);
    const { error } = response.json();
    assert.equal(error.code, 'validation_failed');
    const paths = error.details.map((d: { path: string }) => d.path);
    for (const field of ['name', 'url', 'intervalSeconds']) assert.ok(paths.includes(field), field);
  });

  it('rejects an empty PATCH and malformed ids', async () => {
    await using t = await createTestApp();
    const { data } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/monitors',
        headers: auth,
        payload: validMonitor,
      })
    ).json();

    const empty = await t.app.inject({
      method: 'PATCH',
      url: `/api/monitors/${data.id}`,
      headers: auth,
      payload: {},
    });
    assert.equal(empty.statusCode, 400);

    const badId = await t.app.inject({ method: 'GET', url: '/api/monitors/123', headers: auth });
    assert.equal(badId.statusCode, 400);
  });

  it('runs an on-demand check and exposes history and stats', async () => {
    await using target = await startServer((_req, res) => res.writeHead(200).end());
    await using t = await createTestApp();

    const { data: monitor } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/monitors',
        headers: auth,
        payload: { name: 'Local', url: target.url },
      })
    ).json();

    for (let i = 0; i < 3; i++) {
      const run = await t.app.inject({
        method: 'POST',
        url: `/api/monitors/${monitor.id}/check`,
        headers: auth,
      });
      assert.equal(run.statusCode, 200);
      assert.equal(run.json().data.check.ok, true);
    }

    const page1 = (
      await t.app.inject({
        method: 'GET',
        url: `/api/monitors/${monitor.id}/checks?limit=2`,
        headers: auth,
      })
    ).json();
    assert.equal(page1.data.length, 2);
    assert.ok(page1.nextCursor);

    const page2 = (
      await t.app.inject({
        method: 'GET',
        url: `/api/monitors/${monitor.id}/checks?limit=2&before=${page1.nextCursor}`,
        headers: auth,
      })
    ).json();
    assert.equal(page2.data.length, 1);
    assert.equal(page2.nextCursor, null);

    const stats = (
      await t.app.inject({
        method: 'GET',
        url: `/api/monitors/${monitor.id}/stats?window=1h`,
        headers: auth,
      })
    ).json().data;
    assert.equal(stats.window, '1h');
    assert.equal(stats.totalChecks, 3);
    assert.equal(stats.uptimePercent, 100);
    assert.equal(typeof stats.p95LatencyMs, 'number');
  });
});

describe('public endpoints', () => {
  it('serves a status summary without leaking target URLs', async () => {
    await using t = await createTestApp();
    await t.app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: auth,
      payload: { name: 'Secret API', url: 'https://internal.example.com/secret-path' },
    });

    const response = await t.app.inject({ method: 'GET', url: '/api/status' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.monitors[0].name, 'Secret API');
    assert.equal(body.monitors[0].state, 'pending');
    assert.equal(body.overall, 'operational');
    assert.ok(!response.body.includes('secret-path'));
  });

  it('serves the dashboard with security headers', async () => {
    await using t = await createTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /text\/html/);
    assert.ok(response.headers['content-security-policy']);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.ok(response.headers['x-request-id']);
  });

  it('exposes health probes', async () => {
    await using t = await createTestApp();
    assert.equal((await t.app.inject('/health/live')).statusCode, 200);
    const ready = await t.app.inject('/health/ready');
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().checks.database, 'up');
  });

  it('exposes Prometheus metrics including HTTP traffic', async () => {
    await using t = await createTestApp();
    await t.app.inject('/health/live');
    const response = await t.app.inject('/metrics');
    assert.match(String(response.headers['content-type']), /text\/plain; version=0.0.4/);
    assert.match(
      response.body,
      /pulsewatch_http_requests_total\{method="GET",route="\/health\/live",status="200"\} 1/,
    );
    assert.match(response.body, /nodejs_eventloop_delay_p99_seconds/);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    await using t = await createTestApp();
    const response = await t.app.inject('/nope');
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'not_found');
  });

  it('rate limits API requests per client', async () => {
    await using t = await createTestApp({ RATE_LIMIT_PER_MINUTE: '3' });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await t.app.inject('/api/status')).statusCode);
    assert.deepEqual(statuses, [200, 200, 200, 429]);

    const limited = await t.app.inject('/api/status');
    assert.equal(limited.json().error.code, 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) > 0);
  });
});
