# Nemesis output (behavior files)

Some hosted mods change Skyrim's behavior graphs through Nemesis patches
(`skymp/client-mods/Nemesis_Engine/mod/<id>/`). Nemesis turns those patches
into behavior files once, and the server ships the result, so every player has
the exact same files. Players never run Nemesis.

Patches in the pack (2026-11-20):

| id | Mod |
|----|-----|
| `eaas` | Eating Animations and Sounds SE |
| `evfmgo` | Payload Interpreter |
| `tdmh` | True Directional Movement - 360 Horse Archery |
| `tdmlen` | True Directional Movement - Procedural Leaning |
| `tdmv` | True Directional Movement - Headtracking |

Nemesis's own optional patches (GunMod, combat behaviors…) are not used.

## Regenerate

Whenever a hosted mod with a `Nemesis_Engine/mod/…` folder is added, removed
or updated:

1. Nemesis Unlimited Behavior Engine v0.84 is in the owner's game:
   `Skyrim Special Edition\Data\Nemesis_Engine\`. (Archive: `MODS ADDED\Nemesis
   Unlimited Behavior Engine-60033-v0-84-beta-….rar`.)
2. Copy every patch folder from `skymp/client-mods/Nemesis_Engine/mod/` to
   `Data/Nemesis_Engine/mod/`.
3. Run `Nemesis Unlimited Behavior Engine.exe`, tick exactly the patches above,
   click **Update Engine**, then **Launch Nemesis Behavior Engine** and wait
   for 100% ("Behavior generation complete" in `Nemesis_Engine/PatchLog.txt`).
4. Copy the generated files from `Data/` to `skymp/client-mods/` with the same
   paths: everything under `meshes/` and `scripts/` newer than
   `Nemesis_Engine/UpdateLog.txt`, except `meshes/actors/character/behaviors/Nemesis_*.xml`
   (Nemesis's templates). On 2026-11-20 that was 23 files:
   - `meshes/actors/character/behaviors/*.hkx` (17),
     `meshes/actors/character/_1stperson/behaviors/mt_behavior.hkx`,
     `meshes/actors/character/characters/defaultmale.hkx`,
     `meshes/actors/character/characters female/defaultfemale.hkx`;
   - `meshes/animationdatasinglefile.txt`, `meshes/animationsetdatasinglefile.txt`;
   - `scripts/FNIS.pex`.
5. Restart the server (or run `node apps/game-api/scripts/sync-client-mods.js`)
   so the launcher hands the new files out.

Animation replacers that use OAR/DAR folders (Pretty Combat Animations, the
eating animations themselves) need no Nemesis run.
