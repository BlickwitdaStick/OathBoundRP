/**
 * core/hit-events.js — client-reported aggression, aggregated into episodes
 *
 * ─── Attribution (LICENSE_AND_AFFILIATION_POLICY.md §4) ─────────────────────
 *
 *   Project : alekcey0211/red-house-public — public build of Red House (SkyMP)
 *   Author  : alekcey0211 and contributors
 *   License : GPL-3.0. Compatible with this project's AGPL-3.0-or-later through
 *             GPLv3 §13; the combined work is still distributed under the AGPL.
 *   Commit  : 65c66bb3e1b9f5765ed5fc036d69d75e3afbb53d (branch `master`,
 *             2021-11-01 — repository inactive, last push on 2021-11-16)
 *   File    : functions-lib/src/events/_onHit.ts
 *   Study   : docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md §4.1
 *
 *   **What was adapted is technique, not code.** No line was copied:
 *   what came from there is (a) knowing that `mp.makeEventSource` is the path to the
 *   hit event, since SkyMP declined to expose the packet to the gamemode
 *   (issue #1338); (b) the shape of the payload the client snippet builds
 *   from `ctx.sp.on('hit', ...)`; and (c) the two details that save the
 *   obvious debugging — `0x14` is the local player, and
 *   `ctx.getFormIdInServerFormat()` is mandatory.
 *
 *   The shape of the snippet is practically dictated by the Skyrim Platform API, so
 *   writing it from scratch was faster than porting. **Aggregating into episodes,
 *   discarding self-damage and refusing to compute damage are this project's own**
 *   and have no equivalent there — see the two sections below.
 *
 *   Also recorded in CHANGELOG.md, section `[Unreleased]`.
 *
 * ─── What this is, and what it is NOT ───────────────────────────────────────
 *
 * It is **evidence**, not enforcement. The event comes from `mp.makeEventSource`, which
 * injects JS into the client — and `CONTRIBUTING.md` §3.6 is explicit: client
 * events are *"a hint, not proof. Acceptable for detecting death;
 * unacceptable for granting items or gold"*.
 *
 * This is where we part ways with Red House, where the technique came from
 * (`REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1). They recompute damage on the
 * server from this event and apply it to the ActorValue. We do not: whoever sends
 * the event is the player's machine, so using it to decide damage would hand
 * combat to whoever controls the client. What we get is what the event is good
 * for — a trail of who attacked whom, for staff to arbitrate RDM reports.
 *
 * ─── What it replaces ───────────────────────────────────────────────────────
 *
 * `checkDamageSpike` in `death-service.js`: a heuristic that called any
 * 25-point health drop within a 2 s tick aggression. It could not
 * tell combat from falling off a cliff, did not know who hit, and only existed
 * because it hung off the polling we want to remove.
 *
 * ─── Why it aggregates into episodes instead of recording hit by hit ────────
 *
 * A thirty-second fight between two people produces dozens of events.
 * Red House could treat each one in isolation because their use was ephemeral
 * (apply damage and forget); ours is persistent. Writing one row per hit to
 * `audit_logs` would make the table useless exactly when staff need it
 * most — and "seven identical rows" answers the question *"what
 * happened there?"* worse than a single one saying "A hit B seven times, two with
 * power attacks, over twelve seconds".
 *
 * The episode closes on silence (`JANELA_MS` with no new hit between that pair).
 *
 * ─── Validation status ──────────────────────────────────────────────────────
 *
 * `mp.makeEventSource` was confirmed on a real server on 2026-08-06 — it exists
 * and accepts the registration. **The client snippet has NOT been exercised**: it only runs
 * when someone connects, which is Phase 0. Until then, this module is code that
 * correctly registers an event nobody has seen arrive.
 *
 * The two details below came from Red House and save the obvious debugging:
 *
 *   - **`0x14` is the local player.** The client reports itself with that FormID; the
 *     server must swap it for the `pcFormId` it receives alongside, otherwise every
 *     hit by the player themselves points at the wrong form.
 *   - **`ctx.getFormIdInServerFormat()` is mandatory.** Client and server FormIDs
 *     are different spaces; sending the raw number would yield another object.
 */

const NOME_DO_EVENTO = '_onHitReported';

/** Silence that closes an episode between a pair. */
const JANELA_MS = 10_000;

/** Cap on hits counted per episode — past it the exact number stops mattering. */
const MAX_GOLPES_POR_EPISODIO = 200;

/**
 * The snippet that runs ON THE CLIENT, inside Skyrim Platform.
 *
 * Written as a string because that is what `makeEventSource` takes: the body is
 * serialized and injected into the client. Nothing here has access to this
 * file's scope — only to the `ctx` that SkyMP provides.
 *
 * Kept short on purpose: every line here runs in the game loop on someone
 * else's machine, and there is no way to debug it remotely. Aggregation,
 * throttling and every decision stay on the server side.
 */
const SNIPPET_DO_CLIENTE = `
  ctx.sp.on('hit', (e) => {
    try {
      // Skyrim Platform names it \`aggressor\`; older builds spelled it \`agressor\`.
      var atacante = e.aggressor || e.agressor;
      var alvo = e.target && ctx.getFormIdInServerFormat(e.target.getFormID());
      var quemBateu = atacante && ctx.getFormIdInServerFormat(atacante.getFormID());
      if (!alvo || !quemBateu) return;
      ctx.sendEvent({
        target: alvo,
        aggressor: quemBateu,
        isPowerAttack: !!e.isPowerAttack,
        isSneakAttack: !!e.isSneakAttack,
        isBashAttack: !!e.isBashAttack,
        isHitBlocked: !!e.isHitBlocked
      });
    } catch (err) {
      // An error here runs on the client and has nowhere to go. Swallowing it is
      // right: crashing the snippet would kill the trail of every following
      // hit from that player.
    }
  });
`;

/** FormID the client uses to refer to itself. */
const JOGADOR_LOCAL = 0x14;

/** `${agressor}:${alvo}` (aggressor:target) → open episode */
const _episodios = new Map();

let _aoFecharEpisodio = null;
let _timerDeVarredura = null;
let _registrado = false;

/**
 * Normalizes the FormID the client reported.
 *
 * The client sends `0x14` for itself — it is the local player's form inside its
 * own process. On the server side that number identifies nobody, so
 * it is swapped for `pcFormId`, which is who actually sent the event.
 */
function _resolverAtor(formId, pcFormId) {
  return formId === JOGADOR_LOCAL ? pcFormId : formId;
}

/**
 * Counts a hit. Exported for tests — it is the aggregation rule, and it
 * must be exercisable without a client, a server or a real clock.
 *
 * @param {number} pcFormId  who sent the event
 * @param {object} evento    the snippet's payload
 * @param {number} [agora]   injectable in tests
 */
function registrarGolpe(pcFormId, evento, agora = Date.now()) {
  if (!evento || typeof evento !== 'object') return null;

  const agressor = _resolverAtor(Number(evento.aggressor), pcFormId);
  const alvo = _resolverAtor(Number(evento.target), pcFormId);

  if (!Number.isFinite(agressor) || !Number.isFinite(alvo)) return null;
  // Self-damage (falling, poison, friendly fire from one's own spell) is not
  // aggression between people and does not matter for RDM arbitration.
  if (agressor === alvo) return null;

  const chave = `${agressor}:${alvo}`;
  let ep = _episodios.get(chave);

  if (!ep) {
    ep = {
      agressor,
      alvo,
      golpes: 0,
      powerAttacks: 0,
      sneakAttacks: 0,
      bashAttacks: 0,
      bloqueados: 0,
      inicio: agora,
      ultimo: agora
    };
    _episodios.set(chave, ep);
  }

  if (ep.golpes < MAX_GOLPES_POR_EPISODIO) ep.golpes++;
  if (evento.isPowerAttack) ep.powerAttacks++;
  if (evento.isSneakAttack) ep.sneakAttacks++;
  if (evento.isBashAttack) ep.bashAttacks++;
  if (evento.isHitBlocked) ep.bloqueados++;
  ep.ultimo = agora;

  return ep;
}

/**
 * Closes the episodes with no new hit for `JANELA_MS` and hands them to the subscriber.
 * Exported for tests for the same reason as `registrarGolpe`.
 */
function fecharEpisodiosVencidos(agora = Date.now()) {
  const fechados = [];
  for (const [chave, ep] of _episodios.entries()) {
    if (agora - ep.ultimo < JANELA_MS) continue;
    _episodios.delete(chave);
    fechados.push({ ...ep, duracaoMs: ep.ultimo - ep.inicio });
  }

  if (_aoFecharEpisodio) {
    for (const ep of fechados) {
      try {
        _aoFecharEpisodio(ep);
      } catch (err) {
        console.error('[hit-events] Subscriber failed while receiving an episode:', err.message);
      }
    }
  }
  return fechados;
}

/**
 * Registers the event source and starts sweeping expired episodes.
 *
 * @param {(episodio: object) => void} aoFecharEpisodio
 * @returns {boolean} whether the registration happened
 */
function start(aoFecharEpisodio) {
  _aoFecharEpisodio = aoFecharEpisodio || null;

  if (!_timerDeVarredura) {
    // The sweep is cheap: it walks a small Map, without touching Papyrus or the
    // DB. It has nothing to do with the 2 s polling we are removing.
    _timerDeVarredura = setInterval(() => {
      try {
        fecharEpisodiosVencidos();
      } catch (err) {
        console.error('[hit-events] Failed to close episodes:', err.message);
      }
    }, JANELA_MS);
    if (typeof _timerDeVarredura.unref === 'function') _timerDeVarredura.unref();
  }

  if (typeof mp === 'undefined' || typeof mp.makeEventSource !== 'function') {
    console.warn('[hit-events] mp.makeEventSource unavailable — no hits will be reported.');
    return false;
  }
  if (_registrado) return true;

  try {
    mp.makeEventSource(NOME_DO_EVENTO, SNIPPET_DO_CLIENTE);
    mp[NOME_DO_EVENTO] = (pcFormId, evento) => {
      try {
        registrarGolpe(pcFormId, evento);
      } catch (err) {
        console.error('[hit-events] Failed to record a hit:', err.message);
      }
    };
    _registrado = true;
    console.log('[hit-events] Aggression event registered (evidence, not enforcement).');
    return true;
  } catch (err) {
    console.error('[hit-events] Failed to register the event source:', err.message);
    return false;
  }
}

function stop() {
  if (_timerDeVarredura) clearInterval(_timerDeVarredura);
  _timerDeVarredura = null;
  _episodios.clear();
  _aoFecharEpisodio = null;
  _registrado = false;
}

module.exports = {
  NOME_DO_EVENTO,
  JANELA_MS,
  MAX_GOLPES_POR_EPISODIO,
  SNIPPET_DO_CLIENTE,
  start,
  stop,
  registrarGolpe,
  fecharEpisodiosVencidos,
  _episodios
};
