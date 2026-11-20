# Project Status — SkyMP Heavy RP

> Last consolidation: 2026-08-22. Consolidates PR #34 (Professions), PR #44
> (Economy/Vault), PR #46 (Depot — recovered from snapshot), and PR #45 (UX)
> into `main`, before the start of the Justice module.
>
> **Current local snapshot (26/08/2026):** [PRODUCTION_READINESS_ACTION_PLAN.md](docs/roadmap/PRODUCTION_READINESS_ACTION_PLAN.md)
> remains the operational reference. The gamemode has **1,262 tests,
> all passing**, linear migrations through **v29**, **80 declared tables**,
> and a clean typecheck. MariaDB and real clients were not available for
> acceptance testing. The aggregate product test total and the external
> checks from the 24/08 snapshot were not recalculated in this review. The
> promotion assessment remains **NO-GO**; see
> [PRODUCTION_BLOCKERS_2026-08-24.md](docs/operations/PRODUCTION_BLOCKERS_2026-08-24.md).

## What the Framework Currently Does

- **Identity**: whitelist, character application, opaque credentials
  (AUTH-003), Discord identities, staff identity disclosure.
- **Governance**: roles, permissions, factions, arrests/custody, warrants,
  confiscations, fines — `governance-service` module + tables from
  `migration-v3-governance.sql`.
- **Economy**: 100% virtual gold through `characters.gold`, transaction
  ledger, institutional treasury, regional market, debts,
  contracts, escrow, physical gold anti-cheat
  (`core/economy-physical-sync.js`), large transaction audit threshold
  (`economy.largeTransactionThreshold`).
- **Professions**: grant/revoke/rank/XP core (`profession-service.js`),
  registry of 13 professions — none has its own gameplay yet beyond
  the Miner (consumer of `core/profession-registry.js`).
- **Depot** *(recovered during this consolidation — see note below)*:
  regional item storage by hold (`core/depot-service.js`), UI panel
  (`ui/depot-panel.js`), with no dedicated gold reservation and no
  combat check (the project has no live combat signal).
- **Environment**: authoritative server clock (GameTime/TimeScale),
  drift-correction heartbeat, persistence across restarts
  (`environment-service.js`). No weather.
- **Persistence**: cell state / `/dropitem` (Task 9, cell-persistence
  — already in `main` before this consolidation).
- **UX / Interaction Hub** (Task 11): interaction prompt `[E]`
  (`core/interaction-prompt-service.js`), SELF → `/painel` bridge
  (`character-dashboard-bridge.js`), and exact targeting through
  `Game.getCurrentCrosshairRef()` + `mp.onActivate`; no proximity
  fallback. Still not validated on a real client.
- **Public Work**: generic board→origin→destination domain and flow,
  persistence/idempotency/cooldown/ledger, and migration v29. The module is
  disabled locally, has no routes with real FormDesc values, and has no
  MariaDB validation.
- **Voice**: SkyVoice, WebSocket signaling, cell-based proximity.
- **Launcher / connection bootstrap**: fail-closed configuration for both
  SkyMP contracts, opaque session without a client-declared `profileId`,
  direct destination with `server-info-ignore:true`, and SKSE creation
  through `spawn` confirmed by PID. Covered by tests and NSIS build;
  validation with two real clients is still pending. See
  [ADR-012](docs/technical/ADR_012_LAUNCHER_CONNECTION_BOOTSTRAP.md).
- **Crime & Provenance** *(added after this consolidation — see §
  "What Came After" below)*: `item_instances`, "hot" items,
  institutional searches, restitution through combat logs.
- **Crafting with Profession Gate + Maker's Mark** *(also added later)*:
  `required_profession`/`required_rank` per recipe, XP per craft, and
  the Maker's Mark (`crafted_item_signatures`).

All modules above are **disabled by default** (flags `ENABLE_*`
in `.env.example`) and enter the `lab` phase — none has handled real
player traffic yet.

## Note on the Depot

The Depot Service (Tasks 9+10) did not have an open PR — it existed only as
an unfinished auto-save commit (`8e269dd`, "awaiting manual commit") on the
`feat/depot-service` branch. It was located during this consolidation,
extracted as a reviewable commit, and merged through PR #46. The code is
complete and tested (15 tests), but integration with Professions
**does not exist yet**.

## Known Next Step: Depot ↔ Profession Bridge

The objective "Rank 2 Blacksmith can access the rare ore depot" has not been
implemented. `profession-service.js` and `depot-service.js` do not reference
each other today. This is recorded here as future work — it was not
implemented during this consolidation to avoid expanding the scope without
explicit review.

## Pre-Existing Technical Debt — Resolved on 24/08/2026

During the 22/08 consolidation, `node scripts/check-write-guards.js --all`
reported 14 occurrences: 2 FormDesc values with the `0x` prefix and 12 old
migrations without a test that reads the SQL. This record is historical.
In the current 24/08 snapshot, the 2 FormDesc issues and the coverage for
the 13 priority migrations were fixed, and the checker began reporting
**zero occurrences**.

## Historical Validation for This Consolidation

At the 22/08 milestone, validation consisted of **974 gamemode tests**, 62
registered test files, and 68 tables with linear migrations through v20.
These figures preserve the state of that merge; the current operational
baseline is the one in this document's header: **1,262 gamemode tests, all
passing, 80 tables**, and migrations through **v29**.

- No unexpected untracked/orphaned files (`spikes/` was already
  version-controlled; local `.claude/` configs were outside this merge).

## What Came After This Consolidation (21–22/08/2026)

Two new modules, each following the same pattern described above (`lab`,
its own flag, disabled by default):

- **Crime & Provenance** (commit `fd68762`, Tasks 12-13): `item_instances`
  tracks ownership of stolen items, with a `hot` window and automatic
  restitution through combat logs; an institutional guard search reveals
  the original owner. See [CRIME_SYSTEM_AUDIT.md](docs/technical/CRIME_SYSTEM_AUDIT.md).
- **Profession Gate in Crafting + Maker's Mark** (commits `c7ddcd7`
  and `e777ede`): the `required_profession`/`required_rank` gate per recipe
  already existed, complete and tested, on an orphaned branch
  (`feat/crafting-profession-integration`, 20/08) that had never been merged
  — it was brought in rather than reimplemented. Its migration was
  renumbered from v20 to v23 to avoid conflicts with Depot/Crime. On top
  of that, the Maker's Mark (`crafted_item_signatures`, v24): a crafter
  with a sufficient rank signs the items they craft, and an institutional
  search displays the item's creator. See
  [MAKERS_MARK.md](docs/design/MAKERS_MARK.md) and
  [CRAFTING_SYSTEM.md](docs/gameplay/CRAFTING_SYSTEM.md).

Test suite status at that intermediate milestone: **1,069 tests, 255
suites, 0 failures**; `check-schema-drift.js --list` remained linear through
v24, with no conflicts. At that point, `check-write-guards.js --all` still
found the same 14 pre-existing occurrences; they were resolved on 24/08,
as described in the current snapshot in the header.

- **Keyboard Shortcuts and Action Menus** (22/08/2026, same `lab` pattern):
  replaces part of the "type the command" flow with keys and buttons,
  without removing any text commands (the fallback continues to work).
  - **Proximity Voice**: `Tab` cycles between whisper/normal/shout, `M`
    mutes — activating a backend that already existed but whose client
    was nonfunctional (voice mode and mute had NO path until 22/08,
    neither a key nor a button). Persistent indicator in CEF.
    `/modovoz` and `/mutar` remain as text-command fallbacks. See
    [VOICE_MODE_KEY_AUDIT.md](docs/technical/VOICE_MODE_KEY_AUDIT.md).
  - **`F2`** opens `/painel` (`core/player-shortcuts-service.js`, new
    `lab` module, `ENABLE_PLAYER_SHORTCUTS`).
  - **Trade overlay fixed**: the three buttons (accept/confirm/
    cancel) were calling an event with no server-side listener — they are
    now properly connected through `trade-service.js handleUiEvent`.
  - **`death.rescue`** (`/socorrer`) and **`stall.pack`/`stall.remove`**
    (`/stallpack`/`/stallremove`) are added to the `[E]` interaction menu —
    the latter uses `TARGET_TYPES.SELF` (the owner acting on their own
    stall), with a documented dependency: the `SELF` resolver only
    exists behind `ENABLE_INTERACTION_PROMPT`, so `market-stalls`
    declares this dependency as optional, not required.
  - **`/profissoes` and `/alma` become tabs in `/painel`** —
    `soul-service.js` already had `buildPanelPayload`, but no panel was
    calling it.
  - **Choice modal** (`browserModal` type `'choice'`, new
    `commands.sendChoice`): a search request arrives with Accept/Decline
    buttons, not just text — `/searchaccept`/`/searchdeny` continue
    working, and the modal is a second path to the same
    `approveSearch`.

  None of the items above has been validated in a real game session —
  the same caveat that applies to every `lab` module in this project. What
  exists is automated testing (server-side) and, for the CEF portions that
  the browser tool was able to load during this session, verification in
  a regular browser outside SkyMP. The full plan, decisions, and items
  left out are documented in
  [PLAYER_ACTION_SHORTCUTS_PLAN.md](docs/technical/PLAYER_ACTION_SHORTCUTS_PLAN.md)
  and [PLAYER_SHORTCUTS_AUDIT.md](docs/technical/PLAYER_SHORTCUTS_AUDIT.md).

  Test suite status at that intermediate milestone: **1,107 tests, 264
  suites, 0 failures**; the typecheck still had 4 pre-existing errors. In
  the current 26/08 snapshot, the gamemode has **1,262 tests, all passing**,
  and the gamemode typecheck is clean. The aggregate product total was not
  recalculated in this review.

## Documentation Housekeeping (23/08/2026)

No code changes. An audit of approximately 150 `.md` files in the repository
(local and remote branches) found outdated status banners and checked them
against `phase0-basic.js`, rather than just against another document:

- `docs/gameplay/CONTRACTS.md` and `docs/framework/MODULE_SYSTEM.md` still
  said PARKED for `jobs`, `crafting`, and `trade` — all three have had
  registered descriptors (`moduleRegistry.register`) since before or
  since their reactivation on 20/08. The modules that are genuinely PARKED
  today are: `economy-regional`, `housing-service`,
  `horse-service` (commit `a4cb389`).
- Six fork research documents in `docs/research/` (three rounds covering
  different project sets, not duplicates) received a single index
  ([`SKYMP_FORK_RESEARCH_INDEX.md`](docs/research/SKYMP_FORK_RESEARCH_INDEX.md))
  and two correction notes where a fact dated 14/08 had not propagated
  to the 13/08 documents it corrected (commit `531233c`).

## Native Voice Outside CEF (27/08/2026)

The client CEF refuses `getUserMedia`, so microphone capture was moved to a
separate executable, `voice-helper/` (playback remains in the game browser).
Current state, all in `main`:

- **Capture + relay** (`voice-helper.exe` ↔ `voip-service.js` ↔ `index.html`):
  WASAPI → PCM 20ms → server attaches volume based on proximity → CEF plays it. Measured
  on the test bench (real microphone → instrumented listener), never actually
  heard by a person.
- **Noise suppression**: RNNoise in the send loop (`--no-denoise` disables it).
- **Opus** instead of raw PCM (`codec:"opus"` per frame, compatible with PCM;
  `--pcm` switches back to raw PCM). Decoded in CEF through WebCodecs
  `AudioDecoder`.
- **Packaging**: `voice-helper.exe` is included in the launcher installer as
  `resources/vendor/` (static `x64-windows-static` build, a single file), copied
  to `Data/Platform/` when PLAY is selected. Fail-open — voice is optional.
- **Ticket handoff**: `/voz` → `senderTicket` in the `voipTicket` property → CEF
  sends a POST to `127.0.0.1:19848` → the launcher starts the helper. The
  `VOIP_DEBUG_EXPOSE_TICKET` scaffolding remains as a test-bench fallback.

Full details and verification are documented in
[`VOICE_NATIVE_HELPER.md`](docs/technical/VOICE_NATIVE_HELPER.md) §8.3–8.7.

### TODO — Test with 2–3 Real Players (Blocks Completion of This Track)

Nothing below can be verified without a real Skyrim client; what exists
is automated testing and verification in the app's Chromium browser (the
same CEF 108 foundation, but not the SkyrimPlatform build):

1. **Intelligibility** — one person speaks into a microphone and another
   player hears recognizable speech, not merely "there is a signal"
   (step 6 of stage 8.2 in
   [`FASE_0_ROTEIRO.md`](docs/technical/FASE_0_ROTEIRO.md)).
2. **RNNoise at the receiving end** — keyboard/environmental noise is
   actually reduced.
3. **Opus decoding in real CEF** — the WebCodecs `AudioDecoder` works in
   the client CEF, not just in the app's browser.
4. **CEF `fetch` to loopback** — the POST from `file://` to `127.0.0.1:19848`
   succeeds (PNA/CSP/CEF sandbox). If it **does not** succeed, automatic
   handoff will not work and the `VOIP_DEBUG_EXPOSE_TICKET` fallback
   **cannot be removed**.
5. **Full chain** — `/voz` in-game → launcher starts the helper → player
   in the scene hears the voice.

Once (4) and the full chain pass, remove the `VOIP_DEBUG_EXPOSE_TICKET`
scaffolding (`_exposeDebugTicket`, the flag, §11 of the voice document,
and the tests) — exact list in §11.