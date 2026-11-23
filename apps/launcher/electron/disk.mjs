/**
 * disk.mjs — disk space before downloading, with no I/O
 *
 * Downloading a modpack until the disk fills up is routine, and the raw
 * failure mode is unreadable: the player gets `ENOSPC: no space left on device`
 * in the middle of a progress bar and can't tell whether the problem is theirs,
 * the server's or the internet's.
 *
 * Two things this module handles that a naive check gets wrong:
 *
 * **The download and the install can be on different disks.** The `.zip` goes
 * to `temp` and its contents are extracted into the game folder. Checking only
 * one of the two lets exactly half of the cases through.
 *
 * **Not being able to measure is no reason to block.** `statfs` may be missing
 * or fail; in that case we carry on. Stopping the player from playing because
 * we couldn't read the free space would be worse than the original problem.
 */

/**
 * Headroom beyond what is needed. Extraction needs temporary space, and a
 * Windows install with a disk at absolute zero starts misbehaving in ways that
 * have nothing to do with the launcher.
 */
export const RESERVE_BYTES = 512 * 1024 * 1024;

/** @param {number} n */
export function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * `ENOSPC` is the code; the message varies by platform and locale, so checking
 * text would be fragile. The text is only a safety net for errors that lost
 * their code along the way (e.g. rewrapped in a Promise).
 *
 * @param {unknown} err
 */
export function isDiskFull(err) {
  if (!err) return false;
  const code = /** @type {any} */ (err).code;
  if (code === 'ENOSPC') return true;
  const text = String(/** @type {any} */ (err).message || err);
  return /ENOSPC|no space left|not enough space/i.test(text);
}

/**
 * Decides whether it is OK to go ahead.
 *
 * @param {{label: string, freeBytes: number|null, neededBytes: number}[]} targets
 * @param {number} [reserve]
 * @returns {{ok: boolean, error?: string, unmeasured?: string[]}}
 */
export function checkFreeSpace(targets, reserve = RESERVE_BYTES) {
  if (!Array.isArray(targets) || targets.length === 0) return { ok: true };

  const unmeasured = [];

  for (const target of targets) {
    const { label, freeBytes, neededBytes } = target;

    // No reliable measurement: carry on — see the header.
    if (typeof freeBytes !== 'number' || !isFinite(freeBytes)) {
      unmeasured.push(label);
      continue;
    }
    if (typeof neededBytes !== 'number' || !isFinite(neededBytes) || neededBytes <= 0) {
      continue;
    }

    const required = neededBytes + reserve;
    if (freeBytes < required) {
      const missing = required - freeBytes;
      return {
        ok: false,
        error:
          `Not enough space on ${label}: ${formatBytes(freeBytes)} free and ` +
          `${formatBytes(required)} needed ` +
          `(${formatBytes(neededBytes)} for the download plus ${formatBytes(reserve)} of headroom). ` +
          `Free up ${formatBytes(missing)} and try again.`
      };
    }
  }

  return unmeasured.length > 0 ? { ok: true, unmeasured } : { ok: true };
}
