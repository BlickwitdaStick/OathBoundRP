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
// Logging a fake character in must not open a database pool (it would keep
// the test process alive): identity's cache loaders are stubbed.
const identity = require('./identity-service');
identity.loadKnownIdentities = () => Promise.resolve();
identity.forgetKnownIdentities = () => {};
const browserModal = require('./core/browser-modal');
browserModal.pushModal = (actorId, kind, payload) => sent.push({ actorId, kind, message: payload && payload.message });

const commands = require('./commands');
const ACTOR = 0xff0000aa;

describe('chat feedback: every command answers', () => {
  beforeEach(() => { sent.length = 0; });

  it('a staff command typed without arguments replies with its usage', () => {
    commands.handleChatInput(ACTOR, '/tp');
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /^Usage: \/tp <player#>/);
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

describe('chat feedback: character numbers in commands', () => {
  const commandRegistry = require('./core/command-registry');
  const OTHER = 0xff0000bb;
  let received = null;

  beforeEach(() => {
    sent.length = 0;
    received = null;
    commands.registerActiveCharacter(OTHER, { id: 902, first_name: 'Aela', last_name: 'Nord', char_number: 12 }, 9, 2);
    commandRegistry.register('/probetarget', (actorId, args) => { received = args; }, {
      module: 'test', usage: '/probetarget <player#> <amount> <reason>'
    });
  });

  it('a number in a player slot reaches the handler as that player\'s actorId', () => {
    commands.handleChatInput(ACTOR, '/probetarget #12 50 stole 3 apples');
    assert.equal(received, '0xff0000bb 50 stole 3 apples');
    assert.equal(sent.length, 0);
  });

  it('an offline number is refused with a clear message, handler not called', () => {
    commands.handleChatInput(ACTOR, '/probetarget 99 50 x');
    assert.equal(received, null);
    assert.match(sent[0].message, /No one with number #99 is online/);
  });

  it('a name instead of a number explains what to type', () => {
    commands.handleChatInput(ACTOR, '/probetarget Aela 50 x');
    assert.equal(received, null);
    assert.match(sent[0].message, /not a character number/);
  });

  it('getActorByCharacterNumber and formatCharacterNumber agree', () => {
    assert.equal(commands.getActorByCharacterNumber(12), OTHER);
    assert.equal(commands.formatCharacterNumber(OTHER), '#12');
  });
});

describe('chat feedback: commands of switched-off modules', () => {
  it('say which feature is off instead of "unknown command"', async () => {
    const moduleRegistry = require('./core/module-registry');
    const before = process.env.ENABLE_TEST_OFF_MODULE;
    delete process.env.ENABLE_TEST_OFF_MODULE;
    moduleRegistry.register({
      id: 'test-off-module', phase: 'lab', version: '1.0.0', enabledBy: 'ENABLE_TEST_OFF_MODULE',
      initialize: async () => {}, shutdown: async () => {},
      commands: [{ name: ['/offthing', '/coisadesligada'], handler: () => {}, usage: '/offthing' }]
    });
    await moduleRegistry.bootAll();
    if (before !== undefined) process.env.ENABLE_TEST_OFF_MODULE = before;
    sent.length = 0;
    commands.handleChatInput(ACTOR, '/coisadesligada');
    assert.match(sent[0].message, /turned off on this server \(ENABLE_TEST_OFF_MODULE\)/);
  });
});
