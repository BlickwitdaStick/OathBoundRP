/**
 * disk.test.mjs
 *
 * Disk space before downloading. What these tests protect is less the
 * arithmetic and more the two design decisions: check **both targets** (temp
 * and the game can be on different disks) and **don't block when we can't
 * measure**.
 *
 * Run with: node --test electron/disk.test.mjs
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';

import { checkFreeSpace, isDiskFull, formatBytes, RESERVE_BYTES } from './disk.mjs';

const GB = 1024 * 1024 * 1024;

describe('free space check', () => {
  it('passes when there is headroom', () => {
    const r = checkFreeSpace([
      { label: 'temp', freeBytes: 20 * GB, neededBytes: 2 * GB }
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.error, undefined);
  });

  it('fails when space is short, saying how much to free', () => {
    const r = checkFreeSpace([
      { label: 'C:\Temp', freeBytes: 1 * GB, neededBytes: 5 * GB }
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error, /C:\Temp/, 'must say WHERE space is short');
    assert.match(r.error, /Free up/, 'must say how much to free');
  });

  it('requires the reserve on top of the download', () => {
    // The file fits exactly, but not the extraction headroom. A disk at
    // absolute zero breaks things that have nothing to do with the launcher.
    const r = checkFreeSpace([
      { label: 'game', freeBytes: 2 * GB, neededBytes: 2 * GB }
    ]);
    assert.equal(r.ok, false, `with ${formatBytes(RESERVE_BYTES)} of reserve this does not fit`);
  });

  it('checks ALL targets, not just the first', () => {
    // The .zip goes to temp and its contents are extracted into the game
    // folder. They can be on different disks: checking only one lets half of
    // the cases through.
    const r = checkFreeSpace([
      { label: 'temp', freeBytes: 50 * GB, neededBytes: 2 * GB },
      { label: 'game', freeBytes: 1 * GB, neededBytes: 2 * GB }
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error, /game/, 'the second target has to be checked');
  });

  it('does not block when it cannot measure', () => {
    // statfs may be missing or fail. Stopping the player from playing because
    // we couldn't read the free space would be worse than the original problem.
    const r = checkFreeSpace([
      { label: 'temp', freeBytes: null, neededBytes: 2 * GB }
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.unmeasured, ['temp'], 'but records that it was not measured');
  });

  it('a manifest without sizeBytes does not become a false block', () => {
    for (const n of [undefined, null, 0, -1, NaN]) {
      assert.equal(checkFreeSpace([{ label: 't', freeBytes: 1, neededBytes: n }]).ok, true);
    }
  });

  it('an empty list passes', () => {
    assert.equal(checkFreeSpace([]).ok, true);
    assert.equal(checkFreeSpace(null).ok, true);
  });
});

describe('disk-full detection', () => {
  it('catches it by code, which is the reliable signal', () => {
    const e = new Error('anything'); e.code = 'ENOSPC';
    assert.equal(isDiskFull(e), true);
  });

  it('catches it by text when the code was lost along the way', () => {
    // An error rewrapped in a Promise often loses its .code.
    assert.equal(isDiskFull(new Error('ENOSPC: no space left on device, write')), true);
    assert.equal(isDiskFull('no space left on device'), true);
  });

  it('does not mistake other errors for a full disk', () => {
    const e = new Error('Download timed out'); e.code = 'ETIMEDOUT';
    assert.equal(isDiskFull(e), false);
    assert.equal(isDiskFull(null), false);
    assert.equal(isDiskFull(undefined), false);
  });
});

describe('formatting', () => {
  it('picks a readable unit', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * GB), '5.0 GB');
  });

  it('invalid input does not show up as NaN on the player screen', () => {
    for (const n of [undefined, null, NaN, -5, 'abc']) {
      assert.equal(formatBytes(n), '?');
    }
  });
});
