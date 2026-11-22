const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createMemoryRateLimiter } = require('./rateLimiter');

describe('memory rate limiter', () => {
  it('allows up to the limit and blocks without extending the window', () => {
    let timestamp = 1_000;
    const limiter = createMemoryRateLimiter({ now: () => timestamp });

    assert.equal(limiter.isRateLimited('ip:1', 2, 100), false);
    assert.equal(limiter.isRateLimited('ip:1', 2, 100), false);
    assert.equal(limiter.isRateLimited('ip:1', 2, 100), true);
    timestamp += 100;
    assert.equal(limiter.isRateLimited('ip:1', 2, 100), false);
  });

  it('keeps the bucket count bounded under adversarial keys', () => {
    const limiter = createMemoryRateLimiter({ maxBuckets: 3, now: () => 1_000 });
    for (let i = 0; i < 100; i++) limiter.isRateLimited(`ip:${i}`, 1, 60_000);
    assert.equal(limiter.size(), 3);
  });

  it('a blocked source does not create extra entries', () => {
    const limiter = createMemoryRateLimiter({ now: () => 1_000 });
    for (let i = 0; i < 100_000; i++) limiter.isRateLimited('ip:1', 1, 60_000);
    assert.equal(limiter.size(), 1);
  });
});
