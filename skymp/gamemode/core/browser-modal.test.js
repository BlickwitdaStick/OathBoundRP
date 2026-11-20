/**
 * core/browser-modal.test.js
 *
 * The server → page message channel is a queue: messages sent in the same
 * tick all reach the page (a SkyMP property only replicates its latest value),
 * and the client snippet forwards each value once (updateOwner runs every frame).
 *
 * Executa com: node --test core/browser-modal.test.js
 */

'use strict';

const assert = require('assert');
const { describe, it, beforeEach, after } = require('node:test');
const browserModal = require('./browser-modal');

const sets = [];
const mpOriginal = global.mp;
global.mp = { set: (actorId, prop, value) => sets.push({ actorId, prop, value }) };
after(() => { if (mpOriginal === undefined) delete global.mp; else global.mp = mpOriginal; });

const A = 0xff000a01;

beforeEach(() => {
  sets.length = 0;
  browserModal._queues.clear();
});

describe('browser-modal queue', () => {
  it('two messages in the same tick both reach the page, in order', () => {
    browserModal.pushModal(A, 'toast', { message: 'one' });
    browserModal.pushModal(A, 'toast', { message: 'two' });
    const last = sets.at(-1).value;
    assert.deepStrictEqual(last.messages.map(m => m.data.message), ['one', 'two']);
    assert.ok(last.messages[1].id > last.messages[0].id);
    // Top-level mirrors the newest message (older callers/tests read it).
    assert.strictEqual(last.type, 'toast');
    assert.deepStrictEqual(last.data, { message: 'two' });
  });

  it('keeps only the last MAX_QUEUE messages', () => {
    for (let i = 0; i < browserModal.MAX_QUEUE + 5; i++) browserModal.pushModal(A, 'toast', { message: `m${i}` });
    const q = sets.at(-1).value.messages;
    assert.strictEqual(q.length, browserModal.MAX_QUEUE);
    assert.strictEqual(q[0].data.message, 'm5');
  });

  it('ids keep increasing across players and after forgetActor (actorIds get reused)', () => {
    browserModal.pushModal(A, 'toast', { message: 'x' });
    const first = sets.at(-1).value.id;
    browserModal.forgetActor(A);
    browserModal.pushModal(A, 'toast', { message: 'y' });
    const v = sets.at(-1).value;
    assert.ok(v.id > first);
    assert.strictEqual(v.messages.length, 1, 'old queue forgotten');
  });

  it('client snippet forwards each value once, even though it runs every frame', () => {
    const calls = [];
    const ctx = { state: {}, value: { sentAt: 1, messages: [] }, sp: { browser: { executeJavaScript: (js) => calls.push(js) } } };
    const run = () => new Function('ctx', browserModal.UPDATE_OWNER_SNIPPET)(ctx); // eslint-disable-line no-new-func
    run(); run(); run();
    assert.strictEqual(calls.length, 1);
    ctx.value = { sentAt: 2, messages: [] };
    run();
    assert.strictEqual(calls.length, 2);
  });
});
