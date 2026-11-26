# Crafting tools

`build-armor-recipes.js` writes `dist/Oathbound_Armor.esp` (copied into
`skymp/client-mods`) and `skymp/gamemode/data/gear-tiers.json`.

The plugin holds:
- fifteen tier perks, `OB_Metalworking_<Tier>`, `OB_Outfitting_<Tier>` and
  `OB_Carpentry_<Tier>`, granted by `skills-service.js` from the crafter's
  skill tier, and the `OB_CraftingCarpentryBench` keyword (the Carpentry Bench
  furniture is in Oathbound_Core.esp);
- an override of every forge, smelter, tanning rack, tempering and spinning
  wheel recipe in the load order, gated by the right profession's tier perk
  (heavy armor, weapons, jewelry and smelting: Metalworking; light armor and
  clothing: Outfitting; arrows, bows, crossbows, shields and all-wood goods:
  Carpentry, made at the carpentry bench and tempered where they were);
- a recipe for every playable armor piece of the hosted mods that had none;
- Eastmarch names for everything named Stormcloak.

Tiers come from `skymp/gamemode/core/gear-tiers.js`: material keyword, then
name, then recipe ingredients, then the closest vanilla piece by armor rating
or damage. `gear-tiers.json` is the same table for the server's equip gate.

Re-run after any change to the hosted mods, then:

```
node tools/crafting/build-armor-recipes.js
node apps/game-api/scripts/sync-client-mods.js
node apps/game-api/scripts/build-nexus-sources.js
```

`scan.js` / `esp-read.js` / `strings.js` read the load order from
`skymp/server/server-settings.json`, the plugins from `skymp/client-mods` or
the game's Data folder (`SKYRIM_DATA` overrides it), and localized names from
the game's string tables.
