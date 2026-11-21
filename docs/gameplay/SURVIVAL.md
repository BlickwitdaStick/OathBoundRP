# Survival needs

Hunger, exhaustion and cold, tracked by the server for every online
character. **No penalties yet**: players see their needs and get a message
when one changes stage, and nothing else happens.

Turn it on with `ENABLE_SURVIVAL_NEEDS=true` in `skymp/gamemode/.env`, after
applying `skymp/packages/database/migration-v35-survival-needs.sql`.

## For players

- `/needs` shows all three, with their stage and the kind of place you are in.
- A message appears when a need changes stage ("You are getting peckish.").
- Needs only change while you are online, and they are saved, so logging out
  does not reset them.

| Need | Rises | Goes down | Stages (0 → 5) |
|------|-------|-----------|----------------|
| Hunger (0-1000) | 7.5 per game hour (half while resting) | eating | Well Fed, Satisfied, Peckish, Hungry, Ravenous, Starving |
| Exhaustion (0-960) | 9 per game hour | resting: 120 per game hour | Well Rested, Rested, Slightly Tired, Tired, Weary, Debilitated |
| Cold (0-1000) | outdoors in cool or freezing places | indoors, warm places, hot meals | Warm, Comfortable, Chilly, Very Cold, Freezing, Numb |

**Eating.** Vanilla foods restore what Creation Club Survival Mode says they
do (very small 2, small 18, medium 220, large 380). Survival Mode's hot soups
and stews also remove 200 cold and keep you warmer for 2 game hours. Foods it
does not list, including foods from other mods, restore nothing.

**Resting.** Press E on a bed or bedroll and stay next to it. Walking away
(about 3 m) gets you up. A bed rests you fully; a bedroll only down to 200.
Game time does not skip while resting.

**Cold.** Decided by where you are on the vanilla map, with the same regions
and heights Survival Mode uses:

- *freezing*: snow, the coast, mountains, Winterhold, Skuldafn, the Forgotten
  Vale and Solstheim's snow, anywhere above height 19000, the southern forest
  mountains above 2000, and the peaks of Forelhost and Arcwind Point;
- *cool*: tundra, the Reach and the Whiterun, Windhelm, Solitude and Markarth
  areas, Blackreach;
- *warm*: the pine and fall forests, Riften, Fort Dawnguard, Raven Rock, the
  ash wastes;
- *mild*: anywhere outside those regions (e.g. inside city walls);
- *indoors*: warm, except the cold interiors Survival Mode lists.

Clothing slows the cold: per worn piece, warm gear (keyword
`Survival_ArmorWarm`) 0.10, ordinary 0.05, cold gear (`Survival_ArmorCold`)
0.02, doubled for body and head pieces; a torch and a hot meal add 0.12 each;
at most 0.8 of the cold is blocked.

## For staff

`/setneed <player#> <hunger|exhaustion|cold> <value>` sets a need, for
testing or for a scene.

## Where it lives

| File | What |
|------|------|
| `skymp/gamemode/core/survival-needs.js` | rules and numbers (pure, tested) |
| `skymp/gamemode/survival-service.js` | game clock, eating, beds, equipment, saving, commands |
| `skymp/gamemode/data/survival-data.json` | map regions, foods, cold interiors, keywords |
| `tools/survival/build-survival-data.js` | rebuilds that file from the game's plugins |
| `character_needs` table | one row per character (migration v35) |

Numbers come from Survival Mode's own settings where it has them; where it
keeps them in its scripts (exhaustion and cold stages, how fast cold rises),
the values are ours and marked so in `core/survival-needs.js`.

The vanilla Survival Mode plugin stays loaded but is off; nothing turns it on.

## Not verified in game yet

- the shape of SkyMP's `equipment` property (without it, clothing gives no
  warmth, everything else works);
- that `onEatItem` fires for every food eaten.

## Next, when wanted

Penalties per stage (the plugin's own stage spells could be given by the
server), and heat sources (fires) outdoors.
