/**
 * moderationLog.test.js
 *
 * `discord.js` is mocked in `Module._load`, like the rest of the bot's tests:
 * real interaction with the Discord API (posting to the actual channel) is not
 * covered here and needs a real bot and guild.
 *
 * What these tests lock down:
 *
 *   1. **An unknown event does not become a message.** The endpoint receives a
 *      body from outside; a `kind` nobody anticipated must not become an empty
 *      embed in the staff channel.
 *   2. **`@everyone` in a reason does not become a ping.** Whoever writes the
 *      reason is staff typing in game, and the text crosses three processes
 *      before reaching Discord.
 *   3. **A Discord failure never throws.** The moderation action has already
 *      happened; the channel is a notification, not the record.
 *
 * Run with: node --test moderationLog.test.js
 */

const assert = require('assert');
const { describe, it } = require('node:test');

const moderationLog = require('./moderationLog');

const { parseEvent, buildEmbed, sendModerationLog, sanitize, EVENT_KINDS } = moderationLog;

/** Reads the built embed without depending on EmbedBuilder's internal shape. */
function json(embed) {
  return typeof embed.toJSON === 'function' ? embed.toJSON() : embed.data;
}

describe('parseEvent', () => {
  it('accepts the known events', () => {
    for (const kind of Object.keys(EVENT_KINDS)) {
      const r = parseEvent({ kind, target: 'Someone' });
      assert.strictEqual(r.ok, true, `'${kind}' should be accepted`);
      assert.strictEqual(r.event.kind, kind);
    }
  });

  it('rejects an unknown kind', () => {
    // Mutation this catches: accepting any `kind` and landing on an undefined
    // `EVENT_KINDS[kind]` — `buildEmbed` would blow up inside the endpoint's
    // `.then()`, which is where nobody sees it.
    const r = parseEvent({ kind: 'mute', target: 'Someone' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /unknown/);
  });

  it('rejects a missing body or a missing target', () => {
    assert.strictEqual(parseEvent(null).ok, false);
    assert.strictEqual(parseEvent({ kind: 'kick' }).ok, false);
    assert.strictEqual(parseEvent({ kind: 'kick', target: '   ' }).ok, false);
  });

  it('moderator and reason are optional', () => {
    const r = parseEvent({ kind: 'whitelist_reset', target: 'Someone' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.event.moderator, null);
    assert.strictEqual(r.event.reason, null);
  });

  it('a missing source becomes "unknown", not an empty string', () => {
    // Where the event came from matters in a dispute: an in-game command and a
    // click in the panel are different responsibilities. Empty would hide that.
    assert.strictEqual(parseEvent({ kind: 'kick', target: 'X' }).event.source, 'unknown');
    assert.strictEqual(parseEvent({ kind: 'kick', target: 'X', source: 'gamemode' }).event.source, 'gamemode');
  });
});

describe('sanitize', () => {
  it('breaks mass mentions without deleting the text', () => {
    const clean = sanitize('spam @everyone now');
    assert.strictEqual(clean.includes('@everyone'), false, 'an intact @everyone must not survive');
    assert.ok(clean.includes('everyone'), 'the text stays readable for staff');
    assert.ok(clean.includes('spam') && clean.includes('now'));
  });

  it('breaks @here too, case-insensitively', () => {
    assert.strictEqual(sanitize('@HERE look at this').includes('@HERE'), false);
  });

  it('replaces control characters with spaces', () => {
    // A line break injected into a reason would break the embed apart.
    const clean = sanitize('line one\nline two\u0000end');
    assert.strictEqual(/[\u0000-\u001f]/.test(clean), false);
    assert.ok(clean.includes('line one') && clean.includes('end'));
  });

  it('truncates to the requested length', () => {
    assert.strictEqual(sanitize('x'.repeat(900)).length, 512);
    assert.strictEqual(sanitize('x'.repeat(900), 128).length, 128);
  });

  it('returns null for empty and for non-strings', () => {
    assert.strictEqual(sanitize('   '), null);
    assert.strictEqual(sanitize(42), null);
    assert.strictEqual(sanitize(undefined), null);
  });
});

describe('buildEmbed', () => {
  it('includes title, target, staff and reason', () => {
    const { event } = parseEvent({
      kind: 'permakill', target: 'Bjorn (0xff01)', moderator: 'Vinicius (0xff02)',
      reason: 'Repeat RDM', source: 'gamemode'
    });
    const e = json(buildEmbed(event));

    assert.match(e.title, /Permakill/);
    assert.strictEqual(e.color, EVENT_KINDS.permakill.color);
    assert.match(e.footer.text, /gamemode/);

    const fields = Object.fromEntries(e.fields.map(f => [f.name, f.value]));
    assert.strictEqual(fields.Target, 'Bjorn (0xff01)');
    assert.strictEqual(fields.Staff, 'Vinicius (0xff02)');
    assert.strictEqual(fields.Reason, 'Repeat RDM');
  });

  it('a missing reason is explicit, not a missing field', () => {
    // An embed without the field would look like "blank reason", while one
    // with "_not provided_" says nobody wrote one. Staff need to tell the two
    // apart when someone disputes it weeks later.
    const { event } = parseEvent({ kind: 'kick', target: 'Someone' });
    const e = json(buildEmbed(event));
    const reason = e.fields.find(f => f.name === 'Reason');
    assert.ok(reason);
    assert.match(reason.value, /not provided/);
  });

  it('without a moderator the Staff field is absent', () => {
    const { event } = parseEvent({ kind: 'whitelist_reset', target: 'Someone' });
    const e = json(buildEmbed(event));
    assert.strictEqual(e.fields.some(f => f.name === 'Staff'), false);
  });

  it('every declared kind builds an embed without blowing up', () => {
    // Includes `ban`, which has no producer today: there is no /ban in the
    // gamemode or the panel. The test exists so that, the day that command
    // appears, it doesn't have to invent a new format.
    for (const kind of Object.keys(EVENT_KINDS)) {
      const { event } = parseEvent({ kind, target: 'Someone', reason: 'reason' });
      const e = json(buildEmbed(event));
      assert.ok(e.title, `'${kind}' has no title`);
      assert.strictEqual(typeof e.color, 'number', `'${kind}' has no color`);
    }
  });
});

describe('sendModerationLog', () => {
  function fakeClient({ channel, fetchError } = {}) {
    return {
      channels: {
        fetch: async () => {
          if (fetchError) throw new Error(fetchError);
          return channel;
        }
      }
    };
  }

  it('posts the embed to the configured channel', async () => {
    const sent = [];
    const channel = { send: async (payload) => sent.push(payload) };
    const { event } = parseEvent({ kind: 'kick', target: 'Someone', reason: 'reason' });

    const r = await sendModerationLog(fakeClient({ channel }), event, '123');

    assert.strictEqual(r.sent, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].embeds.length, 1);
    assert.match(json(sent[0].embeds[0]).title, /Kick/);
  });

  it('an unconfigured channel sends nothing and is not an error', async () => {
    // A server that doesn't want the channel must not see `/permakill` complain.
    const channel = { send: async () => assert.fail('should not send') };
    const { event } = parseEvent({ kind: 'kick', target: 'Someone' });

    const r = await sendModerationLog(fakeClient({ channel }), event, undefined);

    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.error, 'channel not configured');
  });

  it('a nonexistent channel does not throw', async () => {
    const { event } = parseEvent({ kind: 'ban', target: 'Someone' });
    const r = await sendModerationLog(fakeClient({ channel: null }), event, '123');
    assert.strictEqual(r.sent, false);
    assert.match(r.error, /does not exist/);
  });

  it('a channel that does not accept messages (category, voice channel) does not throw', async () => {
    const { event } = parseEvent({ kind: 'ban', target: 'Someone' });
    const r = await sendModerationLog(fakeClient({ channel: { id: '123' } }), event, '123');
    assert.strictEqual(r.sent, false);
    assert.match(r.error, /does not accept messages/);
  });

  it('Discord being down does not throw — the moderation already happened', async () => {
    // Mutation this catches: leaving `await client.channels.fetch` without a
    // try/catch. The rejection would bubble up to the endpoint's `.then()` as
    // an unhandled rejection, and on some Node versions that kills the process
    // — the whole bot would go down because Discord was slow during a kick.
    const { event } = parseEvent({ kind: 'permakill', target: 'Someone' });
    const r = await sendModerationLog(fakeClient({ fetchError: 'ECONNRESET' }), event, '123');
    assert.strictEqual(r.sent, false);
    assert.match(r.error, /ECONNRESET/);
  });

  it('a send failure is swallowed too', async () => {
    const channel = { send: async () => { throw new Error('Missing Permissions'); } };
    const { event } = parseEvent({ kind: 'kick', target: 'Someone' });
    const r = await sendModerationLog(fakeClient({ channel }), event, '123');
    assert.strictEqual(r.sent, false);
    assert.match(r.error, /Missing Permissions/);
  });
});

describe('the source holds no invisible characters', () => {
  it('moderationLog.js uses an escape, not the raw character', () => {
    // `core/soul.js` already paid for this: a raw NUL in the source made the
    // file binary to `grep` and `file`, and anyone reading the line would
    // understand the opposite of what it did. The risk here is the same — the
    // mention separator is a zero-width space, and the control class lives in
    // a regex.
    const source = require('fs').readFileSync(require('path').join(__dirname, 'moderationLog.js'), 'utf8');
    for (const ch of source) {
      const o = ch.codePointAt(0);
      const invisible = (o < 32 && !'\n\r\t'.includes(ch)) || o === 127 || o === 0x200b || o === 0xfeff;
      assert.strictEqual(invisible, false, `invisible character U+${o.toString(16)} in the source — write it as \\uXXXX`);
    }
  });
});
