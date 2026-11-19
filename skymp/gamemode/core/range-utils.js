/**
 * core/range-utils.js
 *
 * Distance/range utilities shared between services that need to
 * validate proximity between two actors (governance-service, death-service, ...).
 * Extracted from governance-service.js so the same logic is not duplicated in every
 * new system that needs "the target has to be close".
 */

/**
 * `mp.get(formId, 'locationalData')` **throws** when `formId` does not exist in
 * `WorldState` — confirmed by reading the upstream addon (`ScampServer::Get` calls
 * `GetFormAt<MpObjectReference>`, which throws `std::runtime_error` for a
 * missing form and the addon rethrows it as `Napi::Error`; see
 * `docs/research/MINING_RUNTIME_VALIDATION_REPORT.md` §"SkyMP API
 * Investigation"). This never showed up while only actors (always present
 * in `WorldState` by definition) went through here — `object` as a target
 * type (`core/interaction-targets.js`) is the first path that hands over a
 * FormId the client picked and the server did not validate before asking for
 * its position, which includes a forged FormId or one for an object that was never loaded.
 *
 * Without this `try/catch`, that throw escaped `assertRange` (which has no
 * `try/catch` of its own) into the async `buildContext` of
 * `core/interaction-service.js`, became a rejected promise, and was only caught
 * by the generic `catch` of `core/ui-event-gateway.js` — never by the
 * `DISTANCE` stage of the pipeline, which is where this kind of refusal should show up
 * (specific message, correct audit). `null` here is the same value that
 * `getLoc` already returns for "I could not tell where this is" — the call
 * falls back into `if (!la || !lb) return null;` in `distanceBetween`, which
 * `assertRange` already turned into `{ok:false, reason:'Could not verify
 * proximity.'}`.
 */
function getLoc(actorId) {
  if (typeof mp === 'undefined') return null;
  try {
    return mp.get(actorId, 'locationalData') || mp.get(actorId, 'pos') || null;
  } catch (err) {
    return null;
  }
}

function getCell(loc) {
  if (!loc) return null;
  return loc.cellOrWorldDesc || loc.cellOrWorldSpaceId || loc.cellId || loc.worldOrCell || loc.worldOrCellDesc || null;
}

function getPos(loc) {
  if (!loc) return null;
  return loc.pos || (Array.isArray(loc) ? loc : null);
}

function distanceBetween(a, b) {
  const la = getLoc(a);
  const lb = getLoc(b);
  if (!la || !lb) return null;

  const ca = getCell(la);
  const cb = getCell(lb);
  if (ca && cb && ca !== cb) return Infinity;

  const pa = getPos(la);
  const pb = getPos(lb);
  if (!pa || !pb) return null;

  const dx = pa[0] - pb[0];
  const dy = pa[1] - pb[1];
  const dz = pa[2] - pb[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Without `mp`, this function lets things through — and it has to: that is what makes it possible
 * to exercise `fineTarget`, `arrestTarget` and the interaction pipeline without starting the
 * game, and changing that would break dozens of tests for no reason.
 *
 * What changed on 2026-08-13 was only the honesty of the return value. `{ok: true}` is a
 * **positive claim about the world** — "the target is close" —, and this path
 * measured nothing. The rest of the project fails toward the neutral side when it does not know
 * (`safe-zones.zoneOf` returns `null`, `espm.pareceItem` answers `ok` while marking
 * `indisponivel`); here the marker is `unverified`.
 *
 * Callers remain free to ignore it. `core/interaction-service.js` uses it
 * to avoid writing "distance validated" into an audit where nobody measured
 * distance — see `docs/research/CORE_FRAMEWORK_AUDIT.md` §5.
 *
 * @param {number} sourceActorId
 * @param {number} targetActorId
 * @param {number} maxRange
 * @returns {{ok: boolean, reason?: string, unverified?: boolean}}
 */
function assertRange(sourceActorId, targetActorId, maxRange) {
  if (typeof mp === 'undefined') return { ok: true, unverified: true };
  const distance = distanceBetween(sourceActorId, targetActorId);
  if (distance === null) return { ok: false, reason: 'Could not verify proximity.' };
  if (distance > maxRange) return { ok: false, reason: 'Target out of range.' };
  return { ok: true };
}

/**
 * Lists actors near actorId within maxRange, in the same cell.
 * Used to build evidence context (e.g. who was nearby at the
 * time of a death or a damage spike) — it is not continuous tracking,
 * just a snapshot at the moment of the call.
 * @param {number} actorId
 * @param {number} maxRange
 * @returns {{actorId: number, distance: number}[]}
 */
function nearbyActors(actorId, maxRange) {
  if (typeof mp === 'undefined') return [];
  const results = [];
  try {
    const neighbors = mp.get(actorId, 'neighbors') || [];
    const loc = getLoc(actorId);
    const pos = getPos(loc);
    const cell = getCell(loc);
    if (!pos) return [];

    for (const neighborId of neighbors) {
      if (neighborId === actorId) continue;
      if (mp.get(neighborId, 'type') !== 'MpActor') continue;

      const nLoc = getLoc(neighborId);
      const nPos = getPos(nLoc);
      if (!nPos) continue;
      const nCell = getCell(nLoc);
      if (cell && nCell && cell !== nCell) continue;

      const dx = pos[0] - nPos[0];
      const dy = pos[1] - nPos[1];
      const dz = pos[2] - nPos[2];
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance <= maxRange) results.push({ actorId: neighborId, distance });
    }
  } catch (err) {
    console.error('[range-utils] Failed to compute neighbors:', err.message);
  }
  return results;
}

module.exports = { getLoc, getCell, getPos, distanceBetween, assertRange, nearbyActors };
