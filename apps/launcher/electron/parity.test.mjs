/**
 * parity.test.mjs
 *
 * The launcher's first tests. It had **zero**, and it is the program every
 * player runs — and the only place where the FormID contract is checked
 * before someone gets in.
 *
 * What these tests protect, in one sentence: if the parity check approves a
 * client it shouldn't, the player gets in and **sees different items from the
 * ones the server stored**. No error, no log, no crash — just a chest with
 * something else inside. It is the worst kind of bug this project can produce.
 *
 * Run with: node --test electron/parity.test.mjs
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  parsePluginsTxt,
  parsePluginHeader,
  compareMods,
  analyzePlugins,
  parseCccTxt,
  analyzeCreationClub,
  HASH_ALGORITHM
} from './parity.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: a synthetic plugin instead of a 300 MB .esm
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a minimal TES4 with the requested masters.
 * @param {string[]} masters
 * @param {{isMaster?: boolean, isLight?: boolean}} [flags]
 */
function fakePlugin(masters = [], { isMaster = false, isLight = false } = {}) {
  const fields = masters.map(name => {
    const value = Buffer.from(name + String.fromCharCode(0), 'utf8');
    const field = Buffer.alloc(6 + value.length);
    field.write('MAST', 0, 'latin1');
    field.writeUInt16LE(value.length, 4);
    value.copy(field, 6);
    return field;
  });

  const data = Buffer.concat(fields);
  const head = Buffer.alloc(24);
  head.write('TES4', 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  head.writeUInt32LE((isMaster ? 0x1 : 0) | (isLight ? 0x200 : 0), 8);

  return Buffer.concat([head, data]);
}

/** readHeader that always returns a plugin with no masters. */
const noMasters = () => ({ masters: [], isMaster: false, isLight: false });

// ─────────────────────────────────────────────────────────────────────────────

describe('plugins.txt', () => {
  it('tells active from present — only the active one enters the load order', () => {
    const r = parsePluginsTxt('*Skyrim.esm\n*Update.esm\nDisabled.esp\n');
    assert.deepEqual(r, [
      { name: 'Skyrim.esm', enabled: true },
      { name: 'Update.esm', enabled: true },
      { name: 'Disabled.esp', enabled: false }
    ]);
  });

  it('ignores comments, empty lines and whitespace', () => {
    const r = parsePluginsTxt('# comment\n\n  *Skyrim.esm  \n\n');
    assert.deepEqual(r, [{ name: 'Skyrim.esm', enabled: true }]);
  });

  it('accepts CRLF — the file comes from Windows', () => {
    assert.deepEqual(
      parsePluginsTxt('*A.esm\r\n*B.esp\r\n'),
      [{ name: 'A.esm', enabled: true }, { name: 'B.esp', enabled: true }]
    );
  });

  it('invalid input becomes an empty list, not an exception', () => {
    for (const e of [null, undefined, 42, {}]) {
      assert.deepEqual(parsePluginsTxt(e), []);
    }
  });
});

describe('TES4 header', () => {
  it('reads the masters in declared order', () => {
    const h = parsePluginHeader(fakePlugin(['Skyrim.esm', 'Update.esm']));
    assert.deepEqual(h.masters, ['Skyrim.esm', 'Update.esm']);
    assert.equal(h.error, undefined);
  });

  it('trims the NUL at the end of the name', () => {
    // Without this the name carries the null byte and never matches the file
    // on disk — the launcher would report "missing master" with the master present.
    const h = parsePluginHeader(fakePlugin(['Skyrim.esm']));
    assert.equal(h.masters[0], 'Skyrim.esm');
    assert.ok(!h.masters[0].includes(String.fromCharCode(0)));
  });

  it('recognises the master and light flags', () => {
    assert.equal(parsePluginHeader(fakePlugin([], { isMaster: true })).isMaster, true);
    assert.equal(parsePluginHeader(fakePlugin([], { isLight: true })).isLight, true);
    assert.equal(parsePluginHeader(fakePlugin([])).isMaster, false);
  });

  it('a file that is not a plugin returns an error instead of garbage', () => {
    const h = parsePluginHeader(Buffer.from('this is not a skyrim plugin!!!!!'));
    assert.match(h.error, /TES4/);
    assert.deepEqual(h.masters, []);
  });

  it('a truncated file does not blow up', () => {
    assert.match(parsePluginHeader(Buffer.alloc(10)).error, /smaller than the TES4 header/);
    assert.match(parsePluginHeader(Buffer.alloc(0)).error, /smaller than the TES4 header/);
    assert.match(parsePluginHeader(null).error, /smaller than the TES4 header/);
  });

  it('a lying dataSize does not make the launcher read past the file', () => {
    // The size comes from inside a file the player controls. If the parser
    // trusted it, a forged .esp would read arbitrary memory.
    const b = fakePlugin(['Skyrim.esm']);
    b.writeUInt32LE(0xFFFFFFF, 4);
    const h = parsePluginHeader(b);
    assert.ok(Array.isArray(h.masters), 'should return a valid structure');
  });
});

describe('comparison with the server manifest', () => {
  const hashOf = (name) => ({ 'a.esm': 'h1', 'b.esp': 'h2', 'c.esp': 'WRONG' })[name.toLowerCase()];

  it('passes when everything matches', async () => {
    const r = await compareMods({
      hashAlgorithm: HASH_ALGORITHM,
      serverMods: [{ filename: 'A.esm', hash: 'h1' }, { filename: 'B.esp', hash: 'h2' }],
      localFiles: ['A.esm', 'B.esp'],
      hashOf
    });
    assert.equal(r.success, true);
  });

  it('ignores case differences — the manifest comes from another machine', async () => {
    const r = await compareMods({
      hashAlgorithm: HASH_ALGORITHM,
      serverMods: [{ filename: 'a.ESM', hash: 'h1' }],
      localFiles: ['A.esm'],
      hashOf
    });
    assert.equal(r.success, true, 'Windows is case-insensitive; the check must be too');
  });

  it('fails a missing mod, saying which one', async () => {
    const r = await compareMods({
      hashAlgorithm: HASH_ALGORITHM,
      serverMods: [{ filename: 'Missing.esp', hash: 'h9' }],
      localFiles: ['A.esm'],
      hashOf
    });
    assert.equal(r.success, false);
    assert.match(r.error, /Missing\.esp/);
  });

  it('fails a mod with a different hash', async () => {
    const r = await compareMods({
      hashAlgorithm: HASH_ALGORITHM,
      serverMods: [{ filename: 'C.esp', hash: 'h3' }],
      localFiles: ['C.esp'],
      hashOf
    });
    assert.equal(r.success, false);
    assert.match(r.error, /modified or corrupted/);
  });

  it('an async hashOf (e.g. hashing via a stream) works the same as a sync one', async () => {
    const hashOfAsync = async (name) => hashOf(name);
    const r = await compareMods({
      hashAlgorithm: HASH_ALGORITHM,
      serverMods: [{ filename: 'A.esm', hash: 'h1' }],
      localFiles: ['A.esm'],
      hashOf: hashOfAsync
    });
    assert.equal(r.success, true);
  });

  it('hashes more than one file at a time when concurrency > 1', async () => {
    // Real finding: sequential hashing of a big manifest took ~5 minutes with
    // the disk idle between reads. Proves the worker pool really overlaps
    // calls instead of waiting for one to finish before starting the next.
    let inFlight = 0;
    let peakInFlight = 0;
    const slowHashOf = async (name) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight--;
      return { 'a.esm': 'h1', 'b.esp': 'h2', 'c.esp': 'h3', 'd.esp': 'h4' }[name.toLowerCase()];
    };

    const r = await compareMods({
      hashAlgorithm: HASH_ALGORITHM,
      serverMods: [
        { filename: 'A.esm', hash: 'h1' },
        { filename: 'B.esp', hash: 'h2' },
        { filename: 'C.esp', hash: 'h3' },
        { filename: 'D.esp', hash: 'h4' }
      ],
      localFiles: ['A.esm', 'B.esp', 'C.esp', 'D.esp'],
      hashOf: slowHashOf,
      concurrency: 4
    });

    assert.equal(r.success, true);
    assert.ok(peakInFlight > 1, `expected more than 1 concurrent hash, peak was ${peakInFlight}`);
  });

  it('reports the mod with the lowest manifest index when more than one differs', async () => {
    // With parallel hashing, completion order is no longer manifest order --
    // confirms the reported error stays deterministic (always the lowest
    // index), not "whichever finished first".
    const outOfOrderHashOf = async (name) => {
      const delay = { 'a.esp': 30, 'b.esp': 0 }[name.toLowerCase()] ?? 0;
      await new Promise(resolve => setTimeout(resolve, delay));
      return 'WRONG';
    };

    const r = await compareMods({
      hashAlgorithm: HASH_ALGORITHM,
      serverMods: [
        { filename: 'A.esp', hash: 'h1' },
        { filename: 'B.esp', hash: 'h2' }
      ],
      localFiles: ['A.esp', 'B.esp'],
      hashOf: outOfOrderHashOf,
      concurrency: 2
    });

    assert.equal(r.success, false);
    assert.match(r.error, /A\.esp/, 'should report A.esp (lowest index), even with B.esp finishing first');
  });

  it('an invalid manifest fails instead of passing by default', async () => {
    // An empty list would pass any loop. If the server sends garbage, the safe
    // answer is "no", never "yes".
    assert.equal((await compareMods({ hashAlgorithm: HASH_ALGORITHM, serverMods: null, localFiles: [], hashOf })).success, false);
    assert.equal((await compareMods({ hashAlgorithm: HASH_ALGORITHM, serverMods: undefined, localFiles: [], hashOf })).success, false);
  });
});

describe('hash algorithm declared by the manifest', () => {
  const hashOf = () => 'anything';

  it('a manifest with no declared algorithm fails, and says why', () => {
    // A mods.json generated before 2026-08-23 doesn't have the field. Without
    // this gate, EVERY file would differ and the player would read "your mod
    // is corrupted" two hundred times -- a lie about the cause.
    return compareMods({
      serverMods: [{ filename: 'A.esm', hash: 'x' }],
      localFiles: ['A.esm'],
      hashOf,
      hashAlgorithm: undefined
    }).then(r => {
      assert.equal(r.success, false);
      assert.match(r.error, /regenerate mods\.json/, 'the message has to say what to do');
      assert.ok(!/corrupted/.test(r.error), "must not blame the player's mod");
    });
  });

  it('an MD5 manifest fails naming the wrong algorithm', async () => {
    const r = await compareMods({
      serverMods: [{ filename: 'A.esm', hash: 'x' }],
      localFiles: ['A.esm'],
      hashOf,
      hashAlgorithm: 'md5'
    });
    assert.equal(r.success, false);
    assert.match(r.error, /md5/);
    assert.match(r.error, /sha256/);
  });

  it('the gate comes BEFORE the missing-file check', async () => {
    // Old manifest AND a missing mod at the same time: the root cause is the
    // manifest. Reporting "missing mod" would send the player hunting for a
    // file that may well be in the right place.
    const r = await compareMods({
      serverMods: [{ filename: 'DoesNotExist.esp', hash: 'x' }],
      localFiles: [],
      hashOf,
      hashAlgorithm: 'md5'
    });
    assert.match(r.error, /regenerate mods\.json/);
  });

  it('HASH_ALGORITHM is sha256, not md5', () => {
    // MD5 has practical collisions. The threat model here isn't accidental
    // corruption -- it's a player altering a mod on purpose, which is the only
    // case where collisions matter.
    assert.equal(HASH_ALGORITHM, 'sha256');
  });
});

describe('load order', () => {
  it("passes an order identical to the server's", () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'HeavyRP.esm'],
      serverLoadOrder: ['Skyrim.esm', 'HeavyRP.esm'],
      readHeader: (name) => name === 'HeavyRP.esm'
        ? { masters: ['Skyrim.esm'], isMaster: true, isLight: false }
        : noMasters()
    });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });

  it('reports a plugin the server requires that the client is missing', () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm'],
      serverLoadOrder: ['Skyrim.esm', 'HeavyRP.esm'],
      readHeader: noMasters
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /Missing plugin: HeavyRP\.esm/.test(p)));
  });

  it('reports a master that loads after its dependent', () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'HeavyRP.esm'],
      serverLoadOrder: ['HeavyRP.esm', 'Skyrim.esm'],   // reversed
      readHeader: (name) => name === 'HeavyRP.esm'
        ? { masters: ['Skyrim.esm'], isMaster: false, isLight: false }
        : noMasters()
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /loads after the plugin/.test(p)));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The case that slipped through
  // ───────────────────────────────────────────────────────────────────────────

  it('reports an EXTRA PLUGIN — the failure that voided the FormID contract', () => {
    // The player has everything the server asks for, with the right hash. It
    // passes `compareMods` and used to pass `analyzePlugins`. But there is one
    // extra .esp in the middle of the order: HeavyRP.esm is 02 on the server
    // and 03 here, so every base_id stored in the database points at another
    // record on their screen.
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'Update.esm', 'MyMod.esp', 'HeavyRP.esm'],
      serverLoadOrder: ['Skyrim.esm', 'Update.esm', 'HeavyRP.esm'],
      enabledPlugins: ['Skyrim.esm', 'Update.esm', 'MyMod.esp', 'HeavyRP.esm'],
      readHeader: noMasters
    });

    assert.equal(r.ok, false, 'a client with an extra plugin must NOT be approved');
    assert.ok(
      r.problems.some(p => /Extra plugin in the load order: MyMod\.esp/.test(p)),
      `should report the extra plugin. Problems: ${JSON.stringify(r.problems)}`
    );
    assert.ok(
      r.problems.some(p => /FormID/.test(p)),
      'the message has to say WHY this matters, or the player just removes the check'
    );
  });

  it('a plugin present but disabled is not a problem', () => {
    // A file in Data/ outside plugins.txt doesn't enter the load order and
    // shifts no index. Reporting it would be a false positive, and false
    // positives teach the player to ignore the warning.
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'HeavyRP.esm', 'Disabled.esp'],
      serverLoadOrder: ['Skyrim.esm', 'HeavyRP.esm'],
      enabledPlugins: ['Skyrim.esm', 'HeavyRP.esm'],
      readHeader: noMasters
    });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });

  it('active in plugins.txt but missing from Data/ is not a problem — the game skips it', () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'Oathbound_Holdstone.esp'],
      serverLoadOrder: ['Skyrim.esm', 'Oathbound_Holdstone.esp'],
      enabledPlugins: ['Skyrim.esm', 'OathboundHoldstone.esp', 'Oathbound_Holdstone.esp'],
      readHeader: noMasters
    });
    assert.deepEqual(r.problems, []);
  });

  it('a renamed plugin still present in Data/ and active is still reported', () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'OathboundHoldstone.esp', 'Oathbound_Holdstone.esp'],
      serverLoadOrder: ['Skyrim.esm', 'Oathbound_Holdstone.esp'],
      enabledPlugins: ['Skyrim.esm', 'OathboundHoldstone.esp', 'Oathbound_Holdstone.esp'],
      readHeader: noMasters
    });
    assert.ok(r.problems.some(p => /Extra plugin in the load order: OathboundHoldstone\.esp/.test(p)));
  });

  it('after the launcher sync, the renamed plugin leaves the list and the check passes', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { enableServerPlugins } = await import('./server-mods.mjs');
    const game = fs.mkdtempSync(path.join(os.tmpdir(), 'oathbound-rename-'));
    try {
      fs.mkdirSync(path.join(game, 'Data'));
      for (const p of ['Skyrim.esm', 'OathboundHoldstone.esp', 'Oathbound_Holdstone.esp']) {
        fs.writeFileSync(path.join(game, 'Data', p), '');
      }
      fs.writeFileSync(path.join(game, 'OATHBOUND_plugins.txt'), '*Skyrim.esm\r\n*OathboundHoldstone.esp\r\n');
      fs.writeFileSync(path.join(game, 'OATHBOUND_loadorder.txt'), 'Skyrim.esm\r\nOathboundHoldstone.esp\r\n');
      enableServerPlugins({ gamePath: game, plugins: ['Oathbound_Holdstone.esp'] });
      const enabled = parsePluginsTxt(fs.readFileSync(path.join(game, 'OATHBOUND_plugins.txt'), 'utf8'))
        .filter(p => p.enabled).map(p => p.name);
      const r = analyzePlugins({
        localPlugins: fs.readdirSync(path.join(game, 'Data')),
        serverLoadOrder: ['Skyrim.esm', 'Oathbound_Holdstone.esp'],
        enabledPlugins: enabled,
        readHeader: noMasters
      });
      assert.deepEqual(r.problems, []);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(game, { recursive: true, force: true });
    }
  });

  it('without plugins.txt, falls back to the files in Data/ — the safe direction', () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'HeavyRP.esm', 'Intruder.esp'],
      serverLoadOrder: ['Skyrim.esm', 'HeavyRP.esm'],
      readHeader: noMasters
    });
    assert.equal(r.ok, false, 'without knowing what is active, the extra file is suspect');
  });

  it('a server with no load order FAILS — it used to always pass', () => {
    // The old code fell back to the local order, which made the check compare
    // the player with themselves and answer "ok". The worst possible answer,
    // because it looks like approval.
    for (const order of [[], null, undefined]) {
      const r = analyzePlugins({
        localPlugins: ['Skyrim.esm', 'Anything.esp'],
        serverLoadOrder: order,
        readHeader: noMasters
      });
      assert.equal(r.ok, false, `load order ${JSON.stringify(order)} must not be approved`);
      assert.match(r.problems[0], /parity cannot be checked/);
    }
  });

  it('an unreadable header becomes a problem, not silence', () => {
    const r = analyzePlugins({
      localPlugins: ['Corrupted.esp'],
      serverLoadOrder: ['Corrupted.esp'],
      readHeader: () => ({ masters: [], isMaster: false, isLight: false, error: 'Invalid TES4 header' })
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /TES4/.test(p)));
  });

  it('reports a missing master', () => {
    const r = analyzePlugins({
      localPlugins: ['HeavyRP.esm'],
      serverLoadOrder: ['HeavyRP.esm'],
      readHeader: () => ({ masters: ['Skyrim.esm'], isMaster: false, isLight: false })
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /missing master Skyrim\.esm/.test(p)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Creation Club (MOD-005)
//
// The gap these tests close: Creation Club content never appears in
// `plugins.txt`, so `analyzePlugins` is blind to it. The game loads whatever
// is in `Skyrim.ccc` by itself, and each of those plugins shifts a load order
// index — the same effect as an "extra plugin", the same silent failure as QA 2.15.
//
// Found while studying The Divine Comedy, which tripped on this and answered
// by emptying `Skyrim.ccc` — a fix Steam undoes when verifying the files. See
// docs/research/SKYMP_ECOSYSTEM_DEEP_DIVE.md §2.
// ─────────────────────────────────────────────────────────────────────────────

describe('effective load order (master hoisting)', () => {
  // The engine doesn't load in declared order. It hoists all masters first and
  // only then the .esp files. Comparing indexes in declared order produces a
  // false positive on a correct setup -- and a false positive is the worst
  // possible result here, because it teaches the player to ignore the warning.

  /** readHeader from a table: name -> header. */
  const headersFrom = (table) => (name) => table[name] || noMasters();

  it('a master declared AFTER its dependent is not a problem: the engine hoists it', () => {
    // plugins.txt may list the .esm after the .esp; the engine loads the .esm
    // first anyway. Before this fix we reported it.
    const r = analyzePlugins({
      localPlugins: ['Patch.esp', 'Base.esm'],
      serverLoadOrder: ['Patch.esp', 'Base.esm'],
      enabledPlugins: ['Patch.esp', 'Base.esm'],
      readHeader: headersFrom({
        'Patch.esp': { masters: ['Base.esm'], isMaster: false, isLight: false },
        'Base.esm': { masters: [], isMaster: true, isLight: false }
      })
    });
    assert.deepEqual(r.problems, [], 'the engine hoists Base.esm; there is nothing to report');
    assert.equal(r.ok, true);
  });

  it('an .esp with the ESM flag is hoisted too', () => {
    // .esp extension, but the ESM flag set: the engine treats it as a master.
    const r = analyzePlugins({
      localPlugins: ['Dependent.esp', 'DisguisedMaster.esp'],
      serverLoadOrder: ['Dependent.esp', 'DisguisedMaster.esp'],
      enabledPlugins: ['Dependent.esp', 'DisguisedMaster.esp'],
      readHeader: headersFrom({
        'Dependent.esp': { masters: ['DisguisedMaster.esp'], isMaster: false, isLight: false },
        'DisguisedMaster.esp': { masters: [], isMaster: true, isLight: false }
      })
    });
    assert.deepEqual(r.problems, []);
  });

  it('ESPFE: an .esp with the ESL flag is NOT hoisted', () => {
    // The case that makes the difference, and the natural mistake to write
    // (`isMaster || isLight`). The ESL flag on an .esp changes the FORMID
    // SPACE (FE), not the load position. Treating espfe as a master would make
    // the simulation put it before its dependent and HIDE a real order problem.
    const r = analyzePlugins({
      localPlugins: ['Base.esm', 'Consumer.esp', 'LightPatch.esp'],
      // LightPatch is a master of Consumer, but it is declared AFTER it.
      // Since espfe isn't hoisted, the order really stays wrong.
      serverLoadOrder: ['Base.esm', 'Consumer.esp', 'LightPatch.esp'],
      enabledPlugins: ['Base.esm', 'Consumer.esp', 'LightPatch.esp'],
      readHeader: headersFrom({
        'Base.esm': { masters: [], isMaster: true, isLight: false },
        'Consumer.esp': { masters: ['LightPatch.esp'], isMaster: false, isLight: false },
        'LightPatch.esp': { masters: [], isMaster: false, isLight: true }
      })
    });
    assert.equal(r.ok, false, 'espfe is not hoisted, so the wrong order stays wrong');
    assert.ok(
      r.problems.some(p => /LightPatch\.esp loads after the plugin/.test(p)),
      `should report the order. Problems: ${JSON.stringify(r.problems)}`
    );
  });

  it('a really wrong order between two .esp files is still reported', () => {
    // Hoisting can't become an excuse to stop checking: between plugins the
    // engine does NOT hoist, the declared order holds.
    const r = analyzePlugins({
      localPlugins: ['A.esp', 'B.esp'],
      serverLoadOrder: ['A.esp', 'B.esp'],
      enabledPlugins: ['A.esp', 'B.esp'],
      readHeader: headersFrom({
        'A.esp': { masters: ['B.esp'], isMaster: false, isLight: false },
        'B.esp': { masters: [], isMaster: false, isLight: false }
      })
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /B\.esp loads after the plugin/.test(p)));
  });

  it('a missing master is still reported, hoisting or not', () => {
    const r = analyzePlugins({
      localPlugins: ['Patch.esp'],
      serverLoadOrder: ['Patch.esp'],
      enabledPlugins: ['Patch.esp'],
      readHeader: headersFrom({
        'Patch.esp': { masters: ['GoneBase.esm'], isMaster: false, isLight: false }
      })
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /missing master GoneBase\.esm/.test(p)));
  });
});

describe('parseCccTxt', () => {
  it('reads one name per line, with no asterisk', () => {
    const r = parseCccTxt('ccBGSSSE001-Fish.esm\nccQDRSSE001-SurvivalMode.esl');
    assert.deepEqual(r, ['ccBGSSSE001-Fish.esm', 'ccQDRSSE001-SurvivalMode.esl']);
  });

  it('ignores empty lines, whitespace and comments', () => {
    const r = parseCccTxt('  ccA.esm  \n\n# comment\n\r\nccB.esl\n');
    assert.deepEqual(r, ['ccA.esm', 'ccB.esl']);
  });

  it('accepts CRLF', () => {
    assert.deepEqual(parseCccTxt('ccA.esm\r\nccB.esl'), ['ccA.esm', 'ccB.esl']);
  });

  it('non-string input becomes an empty list, not an exception', () => {
    assert.deepEqual(parseCccTxt(undefined), []);
    assert.deepEqual(parseCccTxt(null), []);
  });
});

describe('analyzeCreationClub', () => {
  const FIVE_MASTERS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];

  it('passes when there is no Creation Club at all', () => {
    const r = analyzeCreationClub({
      cccEntries: [],
      localPlugins: FIVE_MASTERS,
      serverLoadOrder: FIVE_MASTERS
    });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.effective, []);
  });

  it("reports CC the game loads and the server doesn't declare", () => {
    const r = analyzeCreationClub({
      cccEntries: ['ccBGSSSE001-Fish.esm'],
      localPlugins: [...FIVE_MASTERS, 'ccBGSSSE001-Fish.esm'],
      serverLoadOrder: FIVE_MASTERS
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /ccBGSSSE001-Fish\.esm/.test(p)));
    assert.ok(r.problems.some(p => /shifts the FormIDs/.test(p)));
  });

  it('a .ccc entry with no file in Data/ is not a problem: it does not load', () => {
    // The player didn't buy that CC. The name is listed, the file doesn't
    // exist, the game loads nothing and no index moves.
    const r = analyzeCreationClub({
      cccEntries: ['ccBGSSSE001-Fish.esm'],
      localPlugins: FIVE_MASTERS,
      serverLoadOrder: FIVE_MASTERS
    });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.effective, []);
  });

  it("reports CC the server requires that this player doesn't load", () => {
    // The risk of requiring Creation Club in the modpack: it only passes if
    // every player has exactly the same licences.
    const r = analyzeCreationClub({
      cccEntries: [],
      localPlugins: FIVE_MASTERS,
      serverLoadOrder: [...FIVE_MASTERS, 'ccBGSSSE001-Fish.esm']
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /required by the server is missing/.test(p)));
  });

  it('passes when both sides load the same CC', () => {
    const r = analyzeCreationClub({
      cccEntries: ['ccBGSSSE001-Fish.esm'],
      localPlugins: [...FIVE_MASTERS, 'ccBGSSSE001-Fish.esm'],
      serverLoadOrder: [...FIVE_MASTERS, 'ccBGSSSE001-Fish.esm']
    });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.effective, ['ccBGSSSE001-Fish.esm']);
  });

  it('a normal plugin outside the order is not reported as missing CC', () => {
    // The reverse direction only applies to `cc*` names; a regular mod is
    // already covered by analyzePlugins, and reporting it twice would confuse the player.
    const r = analyzeCreationClub({
      cccEntries: [],
      localPlugins: FIVE_MASTERS,
      serverLoadOrder: [...FIVE_MASTERS, 'HeavyRP.esp']
    });
    assert.equal(r.ok, true, r.problems.join('; '));
  });

  it('comparison is case-insensitive, like the rest of the module', () => {
    const r = analyzeCreationClub({
      cccEntries: ['CCBGSSSE001-FISH.ESM'],
      localPlugins: [...FIVE_MASTERS, 'ccbgsssE001-fish.esm'],
      serverLoadOrder: [...FIVE_MASTERS, 'ccBGSSSE001-Fish.esm']
    });
    assert.equal(r.ok, true, r.problems.join('; '));
  });

  it('with no server load order, fails instead of passing by default', () => {
    for (const order of [undefined, null, []]) {
      const r = analyzeCreationClub({
        cccEntries: ['ccA.esm'],
        localPlugins: ['ccA.esm'],
        serverLoadOrder: order
      });
      assert.equal(r.ok, false, `load order ${JSON.stringify(order)} must not be approved`);
      assert.match(r.problems[0], /parity cannot be checked/);
    }
  });

  it('reports several CC plugins at once instead of stopping at the first', () => {
    const r = analyzeCreationClub({
      cccEntries: ['ccA.esm', 'ccB.esl'],
      localPlugins: [...FIVE_MASTERS, 'ccA.esm', 'ccB.esl'],
      serverLoadOrder: FIVE_MASTERS
    });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 2);
  });
});

it('analyzeCreationClub: CC enabled in plugins.txt counts as loaded (install without Skyrim.ccc)', () => {
  const r = analyzeCreationClub({
    cccEntries: [],
    localPlugins: ['Skyrim.esm', 'ccBGSSSE001-Fish.esm'],
    serverLoadOrder: ['Skyrim.esm', 'ccBGSSSE001-Fish.esm'],
    enabledPlugins: ['Skyrim.esm', 'ccBGSSSE001-Fish.esm']
  });
  assert.equal(r.ok, true, r.problems.join('; '));
  const missing = analyzeCreationClub({
    cccEntries: [],
    localPlugins: ['Skyrim.esm', 'ccBGSSSE001-Fish.esm'],
    serverLoadOrder: ['Skyrim.esm', 'ccBGSSSE001-Fish.esm'],
    enabledPlugins: ['Skyrim.esm']
  });
  assert.equal(missing.ok, false, 'still required when neither ccc nor plugins.txt loads it');
});
