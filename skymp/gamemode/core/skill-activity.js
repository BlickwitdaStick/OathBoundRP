/**
 * core/skill-activity.js — "a character did something a skill cares about"
 *
 * A tiny named bus, same idea as core/panel-refresh-bus.js. Gameplay code
 * (profession-service XP, jobs, mining, crafting) reports activity here
 * without requiring skills-service, so it works the same whether the skills
 * module is on or off. skills-service.js subscribes while it runs and turns
 * the activity into EXP for the matching skill — only if the character owns
 * that skill.
 *
 * Activity: { characterId, skill?, professionCode?, amount, source }
 *   `skill`          — a core/skills.js code ('prospector', 'carpenter', …)
 *   `professionCode` — a legacy profession-service code ('miner', …); the
 *                      skills service maps it to a skill.
 */

'use strict';

const _listeners = new Set();

function subscribe(fn) {
  if (typeof fn === 'function') _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function report(activity) {
  if (!activity || !Number.isInteger(Number(activity.characterId))) return;
  for (const fn of _listeners) {
    try {
      const result = fn(activity);
      if (result && typeof result.catch === 'function') {
        result.catch(err => console.error('[skill-activity] listener failed:', err.message));
      }
    } catch (err) {
      console.error('[skill-activity] listener failed:', err.message);
    }
  }
}

function _reset() {
  _listeners.clear();
}

module.exports = { subscribe, report, _reset };
