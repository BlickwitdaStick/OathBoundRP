# Mod distribution policy

Date: **2026-08-13**. Defines what the Heavy RP launcher may download and deliver to the player, what it may only **verify**, and how the manifest encodes the difference.

> **The rule that governs everything below:** no file is distributed without verified authorization. When in doubt, do not distribute — and the manifest has its own category for "not distributed, but required".

Related documents:
- [`docs/legal/ASSET_LICENSE_REGISTRY.md`](../legal/ASSET_LICENSE_REGISTRY.md) — the mandatory registry, asset by asset. **This policy does not replace it**: it says how the launcher behaves; that one says what each author's permission allows.
- [`docs/MODPACK.md`](../MODPACK.md) — the concrete list of mods.
- [`docs/research/PLATFORM_INFRASTRUCTURE_AUDIT.md`](../research/PLATFORM_INFRASTRUCTURE_AUDIT.md) §7 — the v2 manifest format that this policy fills in.
- [`docs/technical/LAUNCHER_DISTRIBUTION.md`](../technical/LAUNCHER_DISTRIBUTION.md) §5 — why we do not use the Nexus Collections format.

---

## 1. The problem, in one sentence

The launcher must guarantee that every player has **the same bytes** the server expects, but it does not have the right to **deliver** most of those bytes.

The two halves are separable, and that is the only reason the problem has a solution:

- **Verifying** parity only requires the hash. Publishing a SHA-256 of a third-party file redistributes nothing — it is a statement about bytes, not a copy of them.
- **Distributing** requires permission.

The whole design below is a consequence of keeping these two halves separate in the manifest format.

This is also what [F02K/SkyMP-Launcher](https://github.com/F02K/SkyMP-Launcher) does — their signed manifest carries the Collection slug, revision, plugin list, load order and hashes, and **excludes the files**. The design conclusion is the same, reached by different paths.

---

## 2. The four categories

Every modpack file falls into exactly one. The category is declared in the manifest and determines the launcher's behavior.

| Category | Means | `downloadUrl` | The launcher |
|---|---|---|---|
| `redistributable` | Our own authorship, or explicit and recorded permission | present | downloads, verifies, installs |
| `manual-install` | Permission absent, denied, or not verified | **absent** | verifies; if missing, instructs and **blocks entry** |
| `nexus-required` | Subset of `manual-install`: it exists on Nexus and requires an account/acceptance of terms | **absent** | same, and opens the mod's page |
| `license-restricted` | Redistribution forbidden by license or ownership (Bethesda, Creation Club) | **absent, always** | verifies presence and version; never downloads, never instructs to obtain it outside the legitimate channel |

### `redistributable`

A file only goes here with **an entry in `ASSET_LICENSE_REGISTRY.md`**. The three accepted origins:

1. **Our own authorship** — `HeavyRP_Equipment.esm`, `HeavyRP_Props.esm`, `HeavyRP_Animations.esm`, plugins we generate.
2. **An open license declared** by the author — "Open Permissions" on Nexus, compatible Creative Commons, MIT/GPL for code.
3. **Direct, written authorization** from the author, obtained through §2 of that registry.

The third requires keeping the evidence. A permission remembered from memory is not a permission; the registry must point to the message, the screenshot or the email.

The SkyMP component itself (client, `SkyrimPlatform`, the fork's SKSE plugins) goes here under its own license — but it remains `redistributable` **by verified license**, not by habit. If the upstream license changes, the category changes.

### `manual-install`

The normal case and the one this policy exists to handle. Most Nexus mods have closed permission by default: *"You are not allowed to upload this file to other sites"*.

None of this prevents the server from **requiring** the mod. It prevents us from **delivering** it.

Required launcher behavior:

1. Check whether the file exists in `Data/` and whether its `sha256` matches.
2. If it is missing or differs, enter `ERROR` with code `MOD_MANUAL_REQUIRED` — not `REPAIRING`, because there is nothing to repair automatically.
3. The screen shows: mod name, author, link to the official page, required version, and the reason it is not downloaded automatically ("the author does not allow redistribution").
4. It does **not** offer "download anyway", does not mirror, does not proxy, does not fetch from a third-party mirror.

Item 4 is not overcaution. A mirror "just for the server's players" is redistribution; a restricted audience does not change the nature of the act.

### `nexus-required`

Same as `manual-install`, with two additions: the launcher opens the page in the system browser (never inside an Electron window, which would make it look like we are the ones delivering it), and the text warns that downloading requires a Nexus account.

**Never automate the Nexus download.** The Nexus API has terms, and using a player's credential to fetch a file on their behalf is a real integration — with consent, token handling, and responsibility for what happens if it fails. It is not a convenience shortcut, and it is not in the scope of this policy.

### `license-restricted`

Bethesda, and Creation Club content.

- **`Skyrim.esm`, `Update.esm`, DLCs**: the player must own the game. This is already a repository rule and is checked in CI (`.github/workflows/ci.yml`, the "Nenhum asset da Bethesda" ("No Bethesda assets") step, which rejects any versioned `.esm` or `.bsa`).
- **Creation Club** (`ccbgssse001-fish.esm` and the other entries 6–10 of `MODPACK.md`): it is not only forbidden to redistribute, it is **impossible to guarantee** that the player has it — the contents of `Skyrim.ccc` vary according to what the Steam account owns. The launcher already detects the divergence in both directions (`analyzeCreationClub` in `apps/launcher/electron/parity.mjs`).

  The decision whether to **require** CC in the modpack is still open (`MOD-005` in the roadmap, and the warning in `MODPACK.md` itself). This policy does not decide it; it only establishes that, whatever is decided, the file never leaves here.

---

## 3. What the manifest carries

Format v2, fields relevant to this policy (the full format is in §7 of the audit):

```jsonc
{
  "path": "Data/AlgumMod.esp",
  "size": 4194304,
  "sha256": "…",
  "required": true,
  "category": "plugin",
  "distribution": {
    "policy": "manual-install",              // the four categories from §2
    "displayName": "Mod name",
    "author": "Author",
    "sourceUrl": "https://www.nexusmods.com/…",
    "requiredVersion": "3.1.4",
    "licenseRef": "AL-014"                   // points to the ASSET_LICENSE_REGISTRY
  },
  "downloadUrl": "https://…"                 // ONLY when policy === "redistributable"
}
```

Two invariants, and they must be checked **at generation time**, not at read time:

1. **`downloadUrl` present ⟺ `policy === "redistributable"`.** A manifest that carries a URL for a `manual-install` file is a publishing error, and the generator must refuse to produce it. Trusting the launcher not to use the URL is trusting the wrong place.
2. **`policy === "redistributable"` requires a `licenseRef` that resolves** in `ASSET_LICENSE_REGISTRY.md`. A distributable file without a license entry is not distributable; it is a file nobody checked.

`sha256` is present in all four categories. **Publishing a hash is not redistributing** — it is what lets us require parity for a file we do not deliver, and it is the reason the whole problem has a solution.

---

## 4. What this costs the player, and why we accept it

A modpack full of `manual-install` means the first entry into the server involves manual work. It is worse than "click play", and it is worth being explicit about the trade-off instead of pretending it does not exist.

Three legitimate mitigations, in order of preference:

1. **Shrink the list.** Every `manual-install` mod is friction. The question "is this mod worth the cost of manual installation for every player?" must be asked during curation, not discovered later.
2. **Ask for permission.** This is §2 of the `ASSET_LICENSE_REGISTRY`, and it works more often than expected — authors tend to authorize servers that ask and give credit.
3. **Replace it with our own work.** This is what §3 of the [Modding Guidelines](../MODDING_GUIDELINES.md) already requires for gameplay objects.

What is **not** a mitigation: mirroring, packaging "for members only", or distributing via Discord. All three are the same thing under different names.

---

## 5. Credits

`ASSET_LICENSE_REGISTRY.md` §4 already requires a "Credits" button in the launcher. **It does not exist today** — there is no credits screen in `apps/launcher/src/`. It is recorded here as pending work, because it is an obligation taken on toward authors whose work we are using, and an obligation taken on and not fulfilled is worse than one never taken on.

Minimum content: for each file with `distribution.author`, the author's name and the source link. The manifest already carries both fields, so the screen is a reading of the manifest, not a hand-maintained list — which is exactly the kind of list that ages and lies.

---

## 6. When this policy is violated

If a file is distributed without authorization:

1. Remove it from the distribution channel immediately (the GitHub release, and the manifest that points to it).
2. Record in `ASSET_LICENSE_REGISTRY.md` what happened and when — the registry serves the history, not just the present.
3. If the author made contact, reply. Do not distribute again until there is written authorization.

There needs to be a contact channel **named for mod authors**. [`SECURITY.md`](../../SECURITY.md) has one ("direct contact with the maintainer through the project's Discord"), but it is declared for vulnerability reports — an author looking to request the removal of a file has no reason to find it there. Closing this gap, in the README or in a dedicated document, is a prerequisite for any public distribution.

---

## 7. What this policy does not do

- **It does not classify the mods in `MODPACK.md`.** The table there lists files and links, without a permission column. Filling in the category one by one is curation work and requires opening the "Permissions and credits" tab of each mod, one at a time.
- **It does not implement anything.** The `distribution` field does not exist in today's `mods.json` (neither does `manifestVersion` — see `PLAT-06` in the audit).
- **It does not replace legal advice.** It is an operational policy written by developers, aligned with what the Nexus terms and author permissions state.
- **It does not decide on Creation Club.** `MOD-005` remains open.
