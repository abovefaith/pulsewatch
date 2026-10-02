import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { signPayload, verifySignature } from '../src/services/notifier.ts';
import { createTestApp, startServer, startSwitchableServer } from './helpers.ts';

describe('incident detection', () => {
  it('opens after N consecutive failures and resolves on recovery', async () => {
    await using target = await startSwitchableServer(500);
    await using t = await createTestApp();
    const monitor = t.ctx.monitors.create({
      name: 'Flaky',
      url: target.url,
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 1000,
      expectedStatus: null,
      failureThreshold: 3,
      webhookUrl: null,
      paused: false,
    });

    const events: string[] = [];
    t.ctx.bus.on('incident', (e) => events.push(e.type));

    assert.equal((await t.ctx.runner.run(monitor)).incident, null);
    assert.equal((await t.ctx.runner.run(monitor)).incident, null);
    const third = await t.ctx.runner.run(monitor);
    assert.equal(third.incident?.type, 'opened');
    assert.equal(third.incident?.incident.cause, 'Unexpected status 500');

    // Further failures don't open duplicate incidents.
    assert.equal((await t.ctx.runner.run(monitor)).incident, null);

    target.state.status = 200;
    const recovered = await t.ctx.runner.run(monitor);
    assert.equal(recovered.incident?.type, 'resolved');
    assert.ok(recovered.incident?.incident.resolvedAt);

    assert.deepEqual(events, ['opened', 'resolved']);
    assert.equal(t.ctx.incidents.countOpen(), 0);
  });

  it('a single success resets the failure streak', async () => {
    await using target = await startSwitchableServer(500);
    await using t = await createTestApp();
    const monitor = t.ctx.monitors.create({
      name: 'Blip',
      url: target.url,
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 1000,
      expectedStatus: null,
      failureThreshold: 2,
      webhookUrl: null,
      paused: false,
    });

    await t.ctx.runner.run(monitor);
    target.state.status = 200;
    await t.ctx.runner.run(monitor);
    target.state.status = 500;
    assert.equal((await t.ctx.runner.run(monitor)).incident, null);
  });
});

describe('webhooks', () => {
  it('delivers signed incident notifications, retrying on 5xx', async () => {
    let attempts = 0;
    await using receiver = await startServer((_req, res) => {
      attempts++;
      res.writeHead(attempts === 1 ? 503 : 200).end();
    });
    await using target = await startSwitchableServer(500);
    await using t = await createTestApp({ WEBHOOK_SECRET: 'whsec_test' });

    const monitor = t.ctx.monitors.create({
      name: 'Alerting',
      url: target.url,
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 1000,
      expectedStatus: null,
      failureThreshold: 1,
      webhookUrl: `${receiver.url}/hooks`,
      paused: false,
    });

    await t.ctx.runner.run(monitor);
    await t.ctx.notifier.flush();

    assert.equal(receiver.requests.length, 2, 'first attempt failed, second succeeded');
    const delivered = receiver.requests[1];
    assert.ok(delivered);
    const payload = JSON.parse(delivered.body);
    assert.equal(payload.event, 'incident.opened');
    assert.equal(payload.monitor.name, 'Alerting');

    const signature = String(delivered.headers['x-pulsewatch-signature']);
    assert.equal(verifySignature('whsec_test', delivered.body, signature), true);
    assert.equal(verifySignature('wrong-secret', delivered.body, signature), false);
    assert.match(
      t.ctx.metrics.registry.render(),
      /pulsewatch_webhooks_total\{result="delivered"\} 1/,
    );
  });

  it('does not retry permanent 4xx failures', async () => {
    await using receiver = await startServer((_req, res) => res.writeHead(410).end());
    await using target = await startSwitchableServer(500);
    await using t = await createTestApp();
    const monitor = t.ctx.monitors.create({
      name: 'Gone',
      url: target.url,
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 1000,
      expectedStatus: null,
      failureThreshold: 1,
      webhookUrl: receiver.url,
      paused: false,
    });

    await t.ctx.runner.run(monitor);
    await t.ctx.notifier.flush();
    assert.equal(receiver.requests.length, 1);
  });
});

describe('signatures', () => {
  it('rejects tampered bodies and stale timestamps', () => {
    const body = '{"event":"incident.opened"}';
    const now = Date.UTC(2026, 0, 1);
    const header = signPayload('secret', body, now);

    assert.equal(verifySignature('secret', body, header, { now }), true);
    assert.equal(verifySignature('secret', `${body} `, header, { now }), false);
    assert.equal(verifySignature('secret', body, header, { now: now + 10 * 60_000 }), false);
    assert.equal(verifySignature('secret', body, 'garbage', { now }), false);
  });
});

describe('scheduler', () => {
  it('checks due monitors, skips paused ones, and respects intervals', async () => {
    await using target = await startSwitchableServer(200);
    await using t = await createTestApp();
    const make = (name: string, paused: boolean) =>
      t.ctx.monitors.create({
        name,
        url: target.url,
        method: 'GET',
        intervalSeconds: 60,
        timeoutMs: 1000,
        expectedStatus: null,
        failureThreshold: 3,
        webhookUrl: null,
        paused,
      });
    const active = make('Active', false);
    make('Paused', true);

    assert.equal(t.ctx.scheduler.tick(), 1);
    await t.ctx.scheduler.idle();
    assert.equal(t.ctx.scheduler.tick(), 0, 'not due again until the interval elapses');

    t.ctx.scheduler.reschedule(active.id);
    assert.equal(t.ctx.scheduler.tick(), 1, 'reschedule makes it due immediately');
    await t.ctx.scheduler.idle();
    assert.equal(t.ctx.checks.list(active.id, { limit: 10 }).length, 2);
  });
});

describe('live events (SSE)', () => {
  it('streams check results to connected clients', async () => {
    await using target = await startSwitchableServer(200);
    await using t = await createTestApp();
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });

    const controller = new AbortController();
    const response = await fetch(`${address}/api/events`, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const monitor = t.ctx.monitors.create({
      name: 'Streamed',
      url: target.url,
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 1000,
      expectedStatus: null,
      failureThreshold: 3,
      webhookUrl: null,
      paused: false,
    });

    assert.ok(response.body, 'response has a body stream');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    await sleep(20); // let the connection register before emitting
    await t.ctx.runner.run(monitor);

    let received = '';
    while (!received.includes('event: check')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value;
    }
    controller.abort();

    const dataLine = received.split('\n').find((line) => line.startsWith('data: '));
    assert.ok(dataLine, 'received a data frame');
    const data = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(data.name, 'Streamed');
    assert.equal(data.ok, true);
    assert.ok(!received.includes(target.url), 'target URL is never broadcast');
  });
});
