# NPC spawn filter

Owner decision (2026-11-19): **hostiles exist, peaceful people don't.**
Bandits, Forsworn, necromancers, vampires, wolves, bears, draugr, dragons and
every other creature stay in the world. Every non-hostile person (civilians,
merchants, innkeepers, guards, travellers, Thalmor patrols, everywhere) does
not, because players fill those roles. This overrides the "bandits out" line of
[NPC_POLICY_DECISION.md](NPC_POLICY_DECISION.md).

Code: `skymp/gamemode/npc-spawn-filter.js` (service) and
`skymp/gamemode/core/npc-classifier.js` (decision). Tests:
`skymp/gamemode/npc-spawn-filter.test.js`, run on real record bytes recorded
from the five masters (`core/fixtures/npc-records.json`, regenerate with
`node scripts/record-npc-fixtures.js <dataDir>`).

## How to turn it on

Two switches. Both are needed, and they belong together: switching on only the
first brings back every NPC SkyMP allows, peaceful ones included.

1. **`skymp/server/server-settings.json`**: add `"npcEnabled": true`.
   Without it SkyMP loads no NPC at all, not even wolves. The templates
   (`skymp/config/server-settings.local.example.json`, `…staging.example.json`)
   already have it. `scripts/phase0/Install-SkyMPServerArtifact.ps1` copies it
   from `server-settings.local.json`, and warns when it is missing.
   `apps/game-api/scripts/sync-client-mods.js` rewrites only `loadOrder` and
   keeps every other key, so it does not undo this.
   **Do not add `npcSettings`.** See "SkyMP's own NPC settings" below.
2. **`skymp/gamemode/.env`**: `ENABLE_NPC_SPAWN_FILTER=true`.

Restart the server. The log should show:

```
NPCs are enabled
"npcSettings" weren't found in the server configuration file.Allowing all npc by default
[npc-spawn-filter] On: 17 hostile faction(s), safeRadius=5000, every 2000ms, ...
```

If it says fewer than 17 factions, it also prints which descs it could not
resolve (a DLC not in the load order).

Optional tuning: copy `skymp/config/npc-spawn-filter.example.json` to
`npc-spawn-filter.json` (gitignored). Every key is optional.

## What it keeps and what it removes

| Actor | Result |
|---|---|
| Creature: any race **without** the `ActorTypeNPC` keyword (wolf, bear, sabre cat, troll, spider, draugr, falmer, riekling, dragon, horse, cow…) | kept |
| Person in a hostile faction: Bandit, Forsworn, Necromancer, Warlock, Vampire, Silver Hand, Dremora, Daedra, Hagraven, Draugr, Falmer, Dragon Priest, Werewolf, Volkihar (`DLC1VampireFaction`), Miraak's cultists, Morag Tong, Miraak | kept |
| Person in a dungeon copy of those (`dunRobbersGorgeBanditFaction`, `WE20WarlockFaction`, …), matched by faction editorId | kept |
| Every other person (playable races, their vampire/child variants, ElderRace, SnowElf…) | **disabled** |
| Anything the filter cannot read (record missing, broken template chain) | kept, counted as "unreadable" |
| Player characters and anything the server or gamemode created (`0xFF…` ids) | never looked at |

"Person race" = the RACE record has the `ActorTypeNPC` keyword
(`13794:Skyrim.esm`) or the Playable flag. Hostile factions are a list of
`id:Plugin.esm` descs in `npc-spawn-filter.js` (`DEFAULT_HOSTILE_FACTIONS`),
read from the masters' FACT records.

**Leveled NPCs.** Most bandits are placed as an NPC_ that templates a leveled
list. The filter first uses the chain the server already rolled for that actor
(`mp.get(actor, 'templateChain')`), so it judges the NPC that actually spawned.
If that is not available it expands the leveled list. All outcomes hostile
means kept, all peaceful means removed. A mixed list is kept unless
`removeMixedLeveledLists` is true.

**Removing** = `mp.set(actor, 'isDisabled', true)`, SkyMP's reversible
`Disable()`, stored in the reference's change form. **Never `delete`.**
`/npcfilter restore <hex id>` re-enables one actor.

**Safe radius.** A peaceful NPC is disabled only when no online player is
within `safeRadius` (default 5000 units, about 70 m; another cell counts as far
away). Until then it waits, and every sweep checks it again, so it goes away as
soon as everyone has left. Practical effect: the first group to walk into a
tavern after the filter is switched on may still see the innkeeper (if SkyMP
spawns them at all, see below). After they leave, the innkeeper is gone for
good. With `disableOnFirstSight: true` a peaceful NPC is disabled the moment
it first streams in near a player, at the cost of someone possibly seeing it
vanish.

### What SkyMP already removes on its own

Once `npcEnabled` is on, `WorldState::AttachEspmRecord` never loads an NPC that
is **essential, protected or unique**, or that is in a faction listed in
`CrimeFactionsList` (`26953:Skyrim.esm`, the hold crime factions). So named
townsfolk, jarls, guards and most quest NPCs never spawn at all, and the filter
never sees them. The side effect: unique hostiles (named bandit chiefs, some
named necromancers and vampires) do not spawn either. Bringing them back would
take a SkyMP patch, which is outside this change.

## SkyMP's own NPC settings: why the project uses `npcEnabled` alone

Read from `skymp5-server/cpp/addon/ScampServer.cpp` (~L235-282) and
`server_guest_lib/WorldState.cpp` (`IsNpcAllowed`, ~L1157) at pin d85f18d8:

- `npcSettings` keys **are plugin file names** (`"Skyrim.esm"`), each with
  `spawnInInterior` / `spawnInExterior`. The plugin checked is the one that
  owns the **reference** (ACHR), not its base record.
- **The `default` entry is broken.** The parser checks for a top-level
  `"default"` key (not `npcSettings.default`), then reads top-level
  `spawnInInterior` / `spawnInExterior`. Inside `npcSettings`, `"default"` is
  treated as a plugin called "default". `IsNpcAllowed` returns *false* as soon
  as it meets a key that is not a loaded plugin, and the keys come from an
  unordered map. So a `"default"` entry, or any plugin not in `loadOrder`, can
  silently block NPCs from every plugin.
- With `npcEnabled: true` and **no** `npcSettings`, every plugin's NPCs are
  allowed (subject to the built-in skips above). That is what the project uses.
  The fine-grained filtering happens in the gamemode, where record data is
  readable. No SkyMP patch was needed.

`npm run check:server-config -- <file>` (`scripts/check-server-config.js`)
now refuses `npcSettings.default` (`NPC_SETTINGS_DEFAULT`) and plugin keys
outside `loadOrder` (`NPC_SETTINGS_UNKNOWN_PLUGIN`).

## Staff command

`/npcfilter` (permission `run_world_probe`):

- `/npcfilter`: counters (examined, kept, disabled, waiting, unreadable).
- `/npcfilter why <npc hex id>`: base record, verdict and reason, current state.
- `/npcfilter restore <npc hex id>`: enable that actor again. The filter leaves
  it alone until the next restart.

## What must be verified in game

None of this has run against a live server yet. Check, in this order:

1. **NPCs load at all.** With `npcEnabled: true` and the filter **off**, walk to
   a known wolf or bandit area (e.g. Embershard Mine near Riverwood, the
   bandit camp at Valtheim Towers). Creatures and bandits should be there.
2. **The filter finds them.** Turn the filter on, restart, go to the same spot,
   run `/npcfilter`. "examined" must go up. If it stays at 0, `onlinePlayers`
   or `actorNeighbors` is not returning what the code expects. Report it; do
   not raise `safeRadius` to "fix" it.
3. **Bandits stay, travellers go.** `/npcfilter why <id>` on a bandit should
   say `hostile (hostile faction 0x1bcc0)`. Find a road traveller, hunter or
   Thalmor patrol, walk more than 70 m away or change cell, come back: gone.
4. **Leveled bandits.** Check several bandits in one camp, not just one. The
   reason should name a faction, not "unreadable".
5. **Restart persistence.** Restart the server and revisit a cleared spot. The
   disabled NPCs must still be gone (`isDisabled` lives in the change form).
6. **Respawn.** Kill a bandit, wait out SkyMP's respawn, and check that it comes
   back. Then check that a disabled civilian does **not** come back enabled
   after its respawn timer.
7. **Towns.** Walk through Whiterun and Riverwood. Expected: no guards, no
   merchants (SkyMP's crime-faction skip). Any generic NPC still standing there
   after you leave and come back: run `/npcfilter why` and report the output.
8. **Server load.** With a few players spread out, watch the tick time. Each
   sweep reads each player's `actorNeighbors` every 2 s. If it shows up, raise
   `sweepIntervalMs`.

## Known gap found on the way

`mp.getActorsByProfileId(0)` **always returns an empty list**:
`MpObjectReference::RegisterProfileId` only indexes profileIds > 0. The
older `npc-cleaner.js` (`ENABLE_NPC_CLEANER`) and the read-only
`fauna-census.js` (`/faunacensus`) both enumerate NPCs that way, so neither has
ever seen an NPC. The spawn filter does not use that call. Those two modules
are untouched by this change and need the same `onlinePlayers` +
`actorNeighbors` approach if they are to work.
