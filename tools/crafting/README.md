# Crafting tools

`build-armor-recipes.js` writes `dist/OathboundArmorRecipes.esp` (and copies it
into `skymp/client-mods`): one COBJ recipe for every playable armor, clothing,
cloak and bag piece of the hosted mods that has no recipe yet.

- SkyMP crafts from COBJ records on the server (`CraftService`): the client
  sends the inputs, the server finds the matching COBJ in the loaded plugins,
  takes the inputs and gives the output. The same plugin feeds the client's
  crafting menu, so nothing in the gamemode changes.
- Perk conditions (Steel Smithing, Advanced Armors, ...) are copied from the
  recipe each one is based on. The server treats `HasPerk` as true; the client
  hides the recipe until the perk is owned, and those perks are skill tree
  nodes that `skills-service.js` re-applies at login (Outfitting: Elven /
  Advanced Armors / Glass; Metalworking: Steel ... Dragon). Cloth, leather
  goods and cloaks have no perk gate, like vanilla leather armor.
- Light plugin (ESL flag, forms 0x800-0xFFF): room for 2048 recipes.

`armor-recipes-report.md` is generated with it: counts per mod, why pieces were
skipped, and the inputs of every recipe.

Re-run after any change to the hosted armor mods, then:

```
node tools/crafting/build-armor-recipes.js
node apps/game-api/scripts/sync-client-mods.js
node apps/game-api/scripts/build-nexus-sources.js
```

`scan.js` / `esp-read.js` read the load order from
`skymp/server/server-settings.json` and the plugins from `skymp/client-mods`
or the game's Data folder (`SKYRIM_DATA` overrides it).
