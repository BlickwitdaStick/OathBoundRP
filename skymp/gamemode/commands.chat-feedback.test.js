/**
 * Every chat line gets an answer.
 *
 * In game, staff commands typed without arguments (`/tp`, `/kick`, `/setgold`…)
 * did nothing at all — the handlers start with `if (args)` — and there was no
 * /help, so a player could not tell a typo from a broken server.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const sent = [];
global.mp = global.mp || {
  get: () => undefined, set: () => {}, makeProperty: () => {}, makeEventSource: () => {}
};
const browserModal = require('./core/browser-modal');
browserModal.pushModal = (actorId, kind, payload) => sent.push({ actorId, kind, message: payload && payload.message });

const commands = require('./commands');
const ACTOR = 0xff0000aa;

describe('chat feedback: every command answers', () => {
  beforeEach(() => { sent.length = 0; });

  it('a staff command typed without arguments replies with its usage', () => {
    commands.handleChatInput(ACTOR, '/tp');
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /^Usage: \/tp <actorId>/);
  });

  it('an unknown command says so and points to /help', () => {
    commands.handleChatInput(ACTOR, '/definitelynotacommand');
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /Unknown command: \/definitelynotacommand\. Type \/help/);
  });

  it('/help lists the chat commands', () => {
    commands.handleChatInput(ACTOR, '/help');
    assert.ok(sent.length >= 1);
    assert.match(sent[0].message, /\/me <action>/);
  });

  it('/help hides staff commands from non-staff', () => {
    commands.handleChatInput(ACTOR, '/help');
    const all = sent.map((s) => s.message).join('\n');
    assert.doesNotMatch(all, /\/permakill/);
  });
});
