/**
 * jobs-service.js
 * Public firewood work. Authoritative mining belongs to the
 * `mining` module (profession + physical node + cooldown + idempotency). Fishing stays
 * out of the alpha while the rod's FormID is not confirmed.
 *
 * Registered in `phase0-basic.js` as the `jobs` module (phase `lab`,
 * `ENABLE_JOBS_SERVICE`, off by default). The migration to
 * `transaction-service` described below — which fixed the defect recorded in
 * docs/technical/PARKED_SERVICES_DECISION.md §7.3 — is what made
 * reactivation possible; until 2026-08-20 the file existed on disk with no chat
 * command at all. See §7.3 for the history of the original defect.
 *
 * ─── Why this file changed ──────────────────────────────────────────────────
 *
 * It delivered resources by calling Papyrus `AddItem` directly on the actor,
 * bypassing `inventory-service` and `core/transaction-service` entirely. The
 * consequence: firewood, ore and fish were born **with no row in
 * `character_inventory` and no row in the ledger** — they did not exist for the server.
 *
 * That is stronger than the `/setgold` finding (gold that appeared with no recorded
 * origin, but at least changed the balance in the DB). Here the item existed only on the
 * client until the next sync, and `syncInventoryToClient` reconciles
 * from the **DB**, which never knew about it. It inverts the rule the rest of the
 * project follows: inventory only exists if MariaDB confirms it.
 *
 * Now every delivery goes through `transactionService.giveItem`, which is atomic,
 * writes to the ledger and only then applies on the client. The public function is the right one
 * here (and not the `tx.*` primitives): the delivery is a single leg, it does not need to
 * commit together with anything else.
 *
 * ─── What is still pending ──────────────────────────────────────────────────
 *
 * `Math.random()` still decides the amount of firewood. It does not fall under §14.3 of
 * Soul Affinity (which governs *hidden soul* rolls, and this is not one), but
 * irreproducible resource production is an economy problem on its own —
 * recorded in §7.3 of PARKED_SERVICES_DECISION, not solved here.
 */

const commands = require('./commands');
const transactionService = require('./core/transaction-service');
const { actorRef, baseRef } = require('./core/papyrus');
const skillActivity = require('./core/skill-activity');

const MODULE = 'jobs';

// Base IDs of Skyrim items
const ITEM_FIREWOOD = 0x00033760; // Lenha
const ITEM_WOODCUTTER_AXE = 0x0002F2F4; // Woodcutter's Axe

const ITEM_PICKAXE = 0x000E3C16; // Picareta
const ITEM_IRON_ORE = 0x00071CF3;
const ITEM_CORUNDUM_ORE = 0x0005ACDB;
const ITEM_EBONY_ORE = 0x0005ACDC;

const ITEM_FISHING_ROD = 0x00044E20; // TODO: Replace with the mod's correct ID
const FISH_SALMON = 0x00065C34;
const FISH_RIVER_BETTY = 0x00106E1A;
const FISH_SPADETAIL = 0x00106E19;

// Prevents spam by keeping track of who is gathering.
//
// Keyed by characterId, not by actorId. The actorId is a slot SkyMP
// reuses across sessions: with the old key, whoever took the slot of
// someone who left in the middle of a gather was blocked until that other
// person's timer expired. Same class as death-service's health cache.
const activeGatherers = new Set();

function notify(text) {
  if (typeof mp === 'undefined') return;
  mp.callPapyrusFunction('global', 'Debug', 'notification', null, [text]);
}

/**
 * Opens a gather: resolves the character, checks the tool and marks them busy.
 *
 * @returns {{characterId: number}|null} null when the gather cannot start
 */
function _beginGather(actorId, toolBaseId, toolName) {
  if (typeof mp === 'undefined') return null;

  // An item only exists if the DB confirms it, and the DB speaks in characterId. With no
  // loaded character there is nowhere to credit — gathering would create an item out of
  // nothing, which is exactly what this migration came to fix.
  const character = commands.getActiveCharacterData(actorId);
  if (!character) {
    notify('Character not loaded.');
    return null;
  }

  if (activeGatherers.has(character.characterId)) {
    notify('You are already busy doing something.');
    return null;
  }

  // The tool is still read from the client, and that is acceptable here: it
  // decides whether the action STARTS, not what the player receives. Whoever cheats gets an
  // animation; the item is only born through transaction-service, at the end.
  if (toolBaseId !== null) {
    const hasTool = mp.callPapyrusFunction('method', 'Actor', 'GetItemCount', actorRef(actorId), [baseRef(toolBaseId)]);
    if (hasTool <= 0) {
      notify(`You need ${toolName}.`);
      return null;
    }
  }

  activeGatherers.add(character.characterId);
  return { characterId: character.characterId };
}

/**
 * Closes a gather and credits the result.
 *
 * Checks that the slot still belongs to the same person before delivering: between the start
 * and the end 10 to 20 seconds pass, plenty of time for someone to drop and another
 * player to take the same actorId. Without this check, the resource went to the
 * wrong character — the DB would record the delivery correctly, to the wrong
 * owner, which is worse than not delivering.
 */
async function _finishGather(actorId, characterId, baseId, count, reason) {
  activeGatherers.delete(characterId);

  const atual = commands.getActiveCharacterData(actorId);
  if (!atual || atual.characterId !== characterId) {
    console.log(`[jobs-service] Gather discarded: actor ${actorId.toString(16)} is no longer char ${characterId}.`);
    return false;
  }

  const ok = await transactionService.giveItem({
    actorId, characterId, baseId, count,
    reason, module: MODULE,
    idempotencyKey: `${MODULE}_${reason}_${characterId}_${Date.now()}`
  });

  if (!ok) {
    notify('The haul was lost before reaching your pack.');
    return false;
  }
  // Skills EXP (skills-service.js); only counts if the character owns the skill.
  const skill = GATHER_SKILL[reason];
  if (skill) skillActivity.report({ characterId, skill, amount: GATHER_EXP * Math.max(1, Number(count) || 1), source: `jobs_${reason}` });
  return true;
}

/** Gathering reason → skill that practises it, and EXP per item gathered. */
const GATHER_SKILL = Object.freeze({ woodcutting: 'carpenter', mining: 'prospector', fishing: 'hunter' });
const GATHER_EXP = 8;

function chopWood(actorId) {
  const sessao = _beginGather(actorId, ITEM_WOODCUTTER_AXE, 'a Woodcutter\'s Axe');
  if (!sessao) return;

  commands.broadcastProximityMessage(actorId, `* Starts chopping wood energetically.`, 1500);

  // Plays the Skyrim animation (if available on the actor).
  // `Debug.SendAnimationEvent` is global: `self` is null and the actor reference
  // goes as an ARGUMENT — and an argument that is a reference must also be an object
  // (see core/papyrus.js and finding 2.13 of the QA_REPORT). The previous version of this
  // line passed the raw `actorId` in the self position, which is invalid on both
  // counts; it would stay that way if someone uncommented it without rereading the contract.
  // mp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [actorRef(actorId), 'WoodChopping']);

  notify('Chopping wood... please wait.');

  setTimeout(() => {
    const woodAmount = Math.floor(Math.random() * 3) + 1; // 1 a 3 madeiras
    _finishGather(actorId, sessao.characterId, ITEM_FIREWOOD, woodAmount, 'woodcutting')
      .then(ok => {
        if (ok) {
          notify(`You gathered ${woodAmount}x Firewood.`);
          console.log(`[jobs-service] Char ${sessao.characterId} chopped ${woodAmount} wood.`);
        }
      })
      .catch(err => console.error('[jobs-service] Failed to deliver firewood:', err.message));
  }, 10000);
}

function mineOre(actorId) {
  const sessao = _beginGather(actorId, ITEM_PICKAXE, 'a Pickaxe');
  if (!sessao) return;

  commands.broadcastProximityMessage(actorId, `* Starts swinging the pickaxe hard against the rock.`, 1500);
  notify('Mining... wait 15 seconds.');

  setTimeout(() => {
    const chance = Math.random();
    let oreItem = ITEM_IRON_ORE;
    let oreName = 'Iron Ore';

    if (chance > 0.9) {
      oreItem = ITEM_EBONY_ORE;
      oreName = 'Ebony Ore';
    } else if (chance > 0.6) {
      oreItem = ITEM_CORUNDUM_ORE;
      oreName = 'Corundum Ore';
    }

    const amount = Math.floor(Math.random() * 2) + 1;

    _finishGather(actorId, sessao.characterId, oreItem, amount, 'mining')
      .then(ok => {
        if (ok) {
          notify(`You extracted ${amount}x ${oreName}.`);
          console.log(`[jobs-service] Char ${sessao.characterId} mined ${amount}x 0x${oreItem.toString(16)}.`);
        }
      })
      .catch(err => console.error('[jobs-service] Failed to deliver ore:', err.message));
  }, 15000);
}

function catchFish(actorId) {
  // TODO: pass ITEM_FISHING_ROD instead of null once the mod's correct FormID
  // is confirmed. While it is null, fishing requires no tool.
  const sessao = _beginGather(actorId, null, 'a Fishing Rod');
  if (!sessao) return;

  commands.broadcastProximityMessage(actorId, `* Casts the line into the water and waits patiently.`, 1500);
  notify('Fishing... wait 20 seconds.');

  setTimeout(() => {
    const chance = Math.random();
    let fishItem = null;
    let fishName = '';

    if (chance > 0.8) {
      fishItem = FISH_RIVER_BETTY;
      fishName = 'River Betty';
    } else if (chance > 0.5) {
      fishItem = FISH_SPADETAIL;
      fishName = 'Cyrodilic Spadetail';
    } else if (chance > 0.2) {
      fishItem = FISH_SALMON;
      fishName = 'Salmon Meat';
    }

    if (!fishItem) {
      // There was no item, so there is nothing to credit — but "busy"
      // has to be cleared anyway, otherwise the player is stuck forever.
      activeGatherers.delete(sessao.characterId);
      notify('The fish got away!');
      commands.broadcastProximityMessage(actorId, `* Pulls up the empty fishing rod in frustration.`, 1000);
      return;
    }

    _finishGather(actorId, sessao.characterId, fishItem, 1, 'fishing')
      .then(ok => {
        if (ok) {
          notify(`You caught: ${fishName}.`);
          console.log(`[jobs-service] Char ${sessao.characterId} caught fish 0x${fishItem.toString(16)}.`);
        }
      })
      .catch(err => console.error('[jobs-service] Failed to deliver fish:', err.message));
  }, 20000);
}

/**
 * The alpha's chat commands. `/garimpar` was removed because it bypassed the
 * Resource Node Framework; `/pescar` stays out of the alpha because the rod uses
 * a provisional FormID. The legacy functions remain exported only for
 * characterization until a dedicated removal.
 */
function commandDefs() {
  return [
    {
      name: ['/chopwood', '/cortarlenha'],
      description: '[Job] Chop wood (needs a Woodcutter\'s Axe)',
      usage: '/chopwood',
      handler: (actorId) => chopWood(actorId)
    }
  ];
}

module.exports = {
  chopWood,
  mineOre,
  catchFish,
  commandDefs,
  // Exposed only for tests: allows exercising the concurrent-gather block and
  // the release without depending on a real timer.
  _activeGatherers: activeGatherers
};
