# Patches to SkyMP and SkyrimPlatform

**Today this directory holds no patches, and that is the preferred situation.**

It exists because the time to write the policy is before the first patch, not after the fifth. Every project in the SkyMP ecosystem that ended up maintaining a heavy fork started with an unrecorded patch — [`SKYMP_ECOSYSTEM_DEEP_DIVE.md`](../docs/research/SKYMP_ECOSYSTEM_DEEP_DIVE.md) documents the cases.

> **The decision about *whether* a patch should exist lives in [`SKYMP_PATCH_POLICY.md`](../docs/technical/SKYMP_PATCH_POLICY.md).** This file explains *how* to register one, once that decision has been made.

## The decision ladder

Before writing a patch, walk down this ladder and stop at the first rung that solves it. A patch is the second-to-last resort; a fork is the last.

```
1. Plain SkyMP         — does the current API already solve it?
2. Adapter             — can it be solved on our side of the boundary?
3. Client extension    — is it UI, input, animation or local detection?
4. Upstream PR         — is it a bug or gap that serves everyone?
5. Registered patch    — do we need it before upstream accepts it?
6. Fork                — only with an ADR and a written justification
```

**Rungs 1 to 3 need none of this.** The [2026-08-14 audit](../docs/research/SKYMP_INTEGRATION_AUDIT.md) walked this ladder for twelve concrete problems and **eleven stopped there**.

If you reached rung 4, open the PR and register the patch as a temporary bridge, with the PR link in the `upstream_pr` field — and first read [§5 of the policy](../docs/technical/SKYMP_PATCH_POLICY.md), because since 2026-07-18 upstream requires contributors to assign copyright.

A patch meant to become a PR that never does is a fork starting slowly.

## Why "loss condition" is a required field

It is the contribution of [The Divine Comedy](https://github.com/miguelAngeloo/TheDivineComedy), the only project in the ecosystem that documents it, and it is the field almost nobody writes.

They note, in the README of their own patches, that the `spawn.ts` patch disappears on a SkyMP reclone and that the emptied `Skyrim.ccc` comes back if Steam verifies the game files. Without that record, the patch disappears and the symptom comes back months later as a new bug — and nobody connects one to the other.

**A patch whose loss is silent is worse than no patch:** you start relying on behavior that can vanish without warning.

## How to register a patch

1. Save the diff to `<target>/<slug>.patch` — `<target>` is `skymp` or `skyrim-platform`.
2. Check that `upstream.pin` in [`manifest.json`](manifest.json) is the commit the diff was generated against. **Every patch points to the same pin** — if yours needs a different one, the pin is what moves, and then every patch is re-evaluated.
3. Add an entry to `manifest.json`.
4. Run `node validate.js`. CI runs the same, plus `git apply --check` of the diff against upstream at the pinned commit.

### Fields

| Field | Required | What to write |
|---|---|---|
| `id` | yes | Unique slug, kebab-case |
| `target` | yes | `skymp` or `skyrim-platform` |
| `file` | yes | Path of the `.patch` relative to this directory; the file must exist |
| `upstream_commit` | yes | SHA of the upstream commit the diff applies on. Must be the manifest's `upstream.pin`, or a 7+ character prefix of it |
| `reason` | yes | The problem. Not what the patch does — **what breaks without it** |
| `files_touched` | yes | List of modified upstream files |
| `impact` | yes | What changes at runtime, including risk |
| `test` | yes | How it is proven to work. `null` only with a justification in `notes` |
| `loss_condition` | yes | **What makes this patch disappear.** Never `null` |
| `removal_strategy` | yes | What must be true to delete the patch |
| `upstream_pr` | yes | PR URL, or `null` with the reason it does not fit upstream |
| `added` | yes | ISO date |
| `notes` | no | Free-form context |

### Filled-in example

This patch **does not exist**. It is here to show the format — it is Divine Comedy's `onPlayerSpawn`, which would be our most plausible candidate if we ever needed it.

```json
{
  "id": "gamemode-spawn-hook",
  "target": "skymp",
  "file": "skymp/gamemode-spawn-hook.patch",
  "upstream_commit": "d85f18d",
  "reason": "The gamemode cannot decide where the player spawns; the spawn is resolved inside the server before any hook.",
  "files_touched": ["skymp5-server/src/systems/spawn.ts"],
  "impact": "If the gamemode exposes `onPlayerSpawn`, it decides the spawn. Without it, behavior identical to upstream.",
  "test": "skymp/gamemode/spawn.test.js — covers with and without the hook",
  "loss_condition": "Reclone or update of SkyMP. The file is overwritten without warning and the spawn goes back to the default.",
  "removal_strategy": "Delete when the upstream PR is accepted and the version pin moves past it.",
  "upstream_pr": null,
  "added": "2026-08-13",
  "notes": "Designed to be upstreamable: it does not change behavior for anyone who does not expose the hook."
}
```

## What does not go here

**Overwriting upstream source by copying.** Divine Comedy also has a `sync-client.mjs` that copies their directory over `skymp5-client/src`, with an absolute path from the author's machine. It is a silent overwrite, with no diff and no record: nobody can tell afterwards what was swapped. If you need to change an upstream file, it is a patch with a diff.

**Changes to the game environment.** Emptying `Skyrim.ccc`, editing INIs, altering files installed by Steam. That is not a code patch, it reverts on its own, and it belongs to the modpack gate — see `MOD-005` in the [roadmap](../docs/roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md).
