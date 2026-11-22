/**
 * core/character-dashboard-bridge.js
 *
 * Task 11, objective 3 (redesigned). The original brief asked for a new "Character
 * Dashboard" with Identity/Finances/Professions/Gestures tabs — but
 * `player-panel-service.js` + `skymp/ui/player-panel.js`/`.css` ALREADY ARE
 * that: name, real gold (`transactionService.getGold`), social, governance,
 * real tabs, opened with `/panel`. Building a new component would
 * duplicate a system that already works.
 *
 * This file is only the BRIDGE: it registers `TARGET_TYPES.SELF` in the Interaction
 * Framework (the `player` resolver refuses `targetActorId === actorId` on
 * purpose — `interaction-targets.js` line ~102, citing
 * `CORE_FRAMEWORK_AUDIT.md` §6.7a: "interacting with yourself is a panel, not a
 * context menu") and a single interaction (`character.dashboard`) whose `execute`
 * only calls `playerPanelService.openPanel(actorId)` — the SAME code that
 * `/panel` already calls. Zero new UI, zero duplicated data reads.
 *
 * The exact-target adapter does not use SELF as a fallback: E with no physical target does
 * nothing. The panel stays reachable via `/panel` and the F2 shortcut. This
 * bridge remains for consumers that explicitly open a SELF
 * interaction, without mixing it with the world target.
 *
 * TODO: Hook for Profession-Service (PR #34, branch `feat/professions-
 * foundation`, not yet merged into `main`). When it merges, the right place
 * for rank/xp to show up is a new tab in `player-panel-service.js`
 * (`pushProfession`, same pattern as `pushEconomy`), not here — this file
 * reads no data at all, it only opens the panel.
 */

'use strict';

const interactionRegistry = require('./interaction-registry');

const MODULE_ID = 'character-dashboard-bridge';

/**
 * @param {{targets: {registerResolver: Function}, openPanel: (actorId: number) => void}} [dependencies]
 */
function registerInteractions(dependencies) {
  const { targets, openPanel } = dependencies || {};
  if (!targets || typeof targets.registerResolver !== 'function') {
    throw new Error(`[${MODULE_ID}] needs 'targets' (interaction-targets) to register the SELF resolver.`);
  }
  if (typeof openPanel !== 'function') {
    throw new Error(`[${MODULE_ID}] needs 'openPanel' (player-panel-service) injected.`);
  }

  // The target is always whoever asked — `rawTargetId` does not matter, but the field
  // exists in the resolver signature (`interaction-targets.js`) for
  // symmetry with the others, not because it is used.
  targets.registerResolver(interactionRegistry.TARGET_TYPES.SELF, (_rawTargetId, actorId) => ({
    type: interactionRegistry.TARGET_TYPES.SELF,
    id: `self:${actorId}`,
    label: 'You',
    actorId
    // No `assertRange`: `buildContext` (`interaction-service.js`) only checks
    // distance when the resolved target exposes that function — on purpose,
    // so it never refuses someone for "distance to themselves".
  }));

  interactionRegistry.register({
    id: 'character.dashboard',
    module: MODULE_ID,
    target: interactionRegistry.TARGET_TYPES.SELF,
    section: 'self',
    label: 'View character',
    order: 10,
    audit: interactionRegistry.AUDIT_LEVELS.TRACE,
    execute: async (ctx) => {
      openPanel(ctx.actorId);
      return { message: null };
    }
  });
}

module.exports = { MODULE_ID, registerInteractions };
