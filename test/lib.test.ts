import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../src/config.ts';
import { ConcurrencyLimiter } from '../src/lib/concurrency.ts';
import { Counter, Gauge, Histogram, Registry } from '../src/lib/metrics.ts';
import { TokenBucketLimiter } from '../src/lib/rate-limit.ts';
import { NonRetryableError, retry } from '../src/lib/retry.ts';

describe('loadConfig', () => {
  it('applies defaults and coerces numbers', () => {
    const config = loadConfig({ API_KEY: 'x'.repeat(16), PORT: '8080' });
    assert.equal(config.PORT, 8080);
    assert.equal(config.CHECK_CONCURRENCY, 10);
    assert.equal(config.WEBHOOK_SECRET, undefined);
  });

  it('reports every invalid variable at once', () => {
    assert.throws(
      () => loadConfig({ API_KEY: 'short', PORT: 'abc' }),
      (error: Error) => error.message.includes('API_KEY') && error.message.includes('PORT'),
    );
  });
});

describe('ConcurrencyLimiter', () => {
  it('never runs more than `max` tasks at once', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let running = 0;
    let peak = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(Math.random() * 5);
          running--;
          return i;
        }),
      ),
    );

    assert.equal(peak, 3);
    assert.deepEqual(
      results,
      Array.from({ length: 20 }, (_, i) => i),
    );
    assert.equal(limiter.active, 0);
  });

  it('frees the slot when a task rejects', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await assert.rejects(
      limiter.run(() => Promise.reject(new Error('boom'))),
      /boom/,
    );
    assert.equal(await limiter.run(async () => 'next'), 'next');
  });

  it('onIdle resolves after queued work drains', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let done = 0;
    for (let i = 0; i < 5; i++) void limiter.run(() => sleep(2).then(() => done++));
    await limiter.onIdle();
    assert.equal(done, 5);
  });
});

describe('retry', () => {
  it('retries until the operation succeeds', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        if (++calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { baseDelayMs: 1 },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('gives up after the configured retries', async () => {
    let calls = 0;
    await assert.rejects(
      retry(
        async () => {
          calls++;
          throw new Error('down');
        },
        { retries: 2, baseDelayMs: 1 },
      ),
      /down/,
    );
    assert.equal(calls, 3);
  });

  it('does not retry NonRetryableError', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        throw new NonRetryableError('bad request');
      }),
      NonRetryableError,
    );
    assert.equal(calls, 1);
  });

  it('uses exponential backoff with jitter', async () => {
    const delays: number[] = [];
    await assert.rejects(
      retry(() => Promise.reject(new Error('x')), {
        retries: 3,
        baseDelayMs: 10,
        random: () => 1,
        onRetry: (_error, _attempt, delay) => delays.push(delay),
      }),
    );
    assert.deepEqual(delays, [10, 20, 40]);
  });
});

describe('TokenBucketLimiter', () => {
  it('allows a burst up to capacity, then refills over time', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerMinute: 60, now: () => now });

    assert.deepEqual(
      [1, 2, 3, 4].map(() => limiter.take('ip').allowed),
      [true, true, true, false],
    );
    const blocked = limiter.take('ip');
    assert.equal(blocked.retryAfterSeconds, 1);

    now += 1000; // one token per second
    assert.equal(limiter.take('ip').allowed, true);
    assert.equal(limiter.take('other-ip').remaining, 2, 'keys are isolated');
  });

  it('prunes fully refilled buckets', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerMinute: 60, now: () => now });
    limiter.take('a');
    limiter.take('b');
    now += 60_000;
    limiter.prune();
    assert.equal(limiter.trackedKeys, 0);
  });
});

describe('metrics registry', () => {
  it('renders the Prometheus text format', () => {
    const registry = new Registry();
    const counter = registry.register(new Counter({ name: 'jobs_total', help: 'Jobs.' }));
    const histogram = registry.register(
      new Histogram({ name: 'latency_seconds', help: 'Latency.', buckets: [0.1, 1] }),
    );
    registry.register(new Gauge({ name: 'queue_depth', help: 'Depth.', collect: () => 7 }));

    counter.inc({ result: 'ok' });
    counter.inc({ result: 'ok' }, 2);
    counter.inc({ result: 'say "hi"\n' });
    histogram.observe(0.05);
    histogram.observe(0.5);

    const output = registry.render();
    assert.match(output, /# TYPE jobs_total counter/);
    assert.match(output, /jobs_total\{result="ok"\} 3/);
    assert.match(output, /jobs_total\{result="say \\"hi\\"\\n"\} 1/);
    assert.match(output, /latency_seconds_bucket\{le="0.1"\} 1/);
    assert.match(output, /latency_seconds_bucket\{le="1"\} 2/);
    assert.match(output, /latency_seconds_bucket\{le="\+Inf"\} 2/);
    assert.match(output, /latency_seconds_count 2/);
    assert.match(output, /queue_depth 7/);
  });

  it('treats label order as irrelevant', () => {
    const counter = new Counter({ name: 'c', help: 'c' });
    counter.inc({ a: 1, b: 2 });
    counter.inc({ b: 2, a: 1 });
    assert.equal(counter.get({ a: 1, b: 2 }), 2);
  });
});
