# Runtime validation — Operation Alpha-0

> The single operational document for this operation. It records the environment,
> tests run and failures found along the path Launcher→Auth→Game API→Master
> API→SkyMP→CEF→Spawn→Gameplay→Persistence→Logout→Reconnection. See
> [PROJECT_STATE.md](../../PROJECT_STATE.md) for the overall state of the repository.

## Environment

| Item | Value |
|---|---|
| Machine | The project owner's Windows desktop (the same one that runs Claude Code) |
| OS | Windows 11 Pro 10.0.26200 |
| Skyrim SE | Two local Steam installs (`D:\SteamLibrary\...`, `E:\SteamLibrary\...`) — see note below |
| MariaDB/Docker | **Absent on this machine** — `docker`/`mysqld`/`mariadbd` are not on the PATH (confirmed 08-27) |
| gamemode commit | `4075eac` at the time of this record |
| launcher build | NSIS build from 2026-08-26 (~105 MB), handshake with a real client not yet exercised |

**Note on the local Steam installs:** neither is infrastructure of this
repository — they are incidental findings during the investigation of the
login blocker (see below), useful as evidence but not as staging.
- `D:\...\Skyrim Special Edition` — the client of **Skyland Roleplay**, a
  competing product already cited as a design reference in
  [`LAUNCHER_UI_GUIDE.md`](../technical/LAUNCHER_UI_GUIDE.md). Its own fork;
  it does not prove the behavior of vanilla `skymp5-client`.
- `E:\...\Skyrim Special Edition` — a bundle with no branding of its own
  (generic `Data/Platform/UI/index.html`, only `<script src="build.js">`),
  with class naming (`AuthService`, `SkympClient`,
  `SettingsService`, `NetworkingService`, `RemoteServer`) matching what is
  already cited in `docs/technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md` —
  treated here as the genuine `skymp5-client`. It contains 15 real session logs
  in `Data/Platform/skymp-logs/`, dated 07-07 to 07-08-2026, and points
  to an external IP (not this project's) — probably from the same "external
  fork" already cited in the CHANGELOG as the source of the AUTH-01 discovery.

## Tests performed

| Time | Client | Steps | Result | Evidence |
|---|---|---|---|---|
| 08-27 | N/A (static) | Full gamemode `npm test` after the auth-boundary fix below | 1262/1262 PASS | `node --test` output, no real client involved |
| 08-27 | N/A (static) | `node --test skymp/ui/index.test.js` (new, characterizes the bootstrap) | 2/2 PASS | same |
| 08-27 | N/A | `npm run typecheck` (gamemode) | clean | same |
| — | 2 real clients | Milestone A (login→spawn→chat→`[E]`→`/painel`→reconnection) | **BLOCKED** | needs MariaDB + staging + 2 installs of OUR client, none available on this machine |

**Honest G-level for this round: G1.** The fix below has code proof
(official bundle) and real-log proof (but from another operator's session,
not this machine, and in `offlineMode: true`, not the `false` mode that
production uses). **It is not G2** — nobody has run this against the real SkyMP
of this stack yet.

## Failures

### AUTH-05 — the RP UI never sent the bootstrap signal that AuthService expects

- **Symptom:** even with a correct `gameData.session` (AUTH-01 already fixed) and
  the Master API resolving the session correctly, the server recorded
  `connections.total: 0` minutes after the player sat at the menu — the
  client never actually opened a connection.
- **Previous attempt (08-24, unconfirmed):** `skymp/ui/index.html`
  sent `window.skyrimPlatform.sendMessage('authAttemptEvent')`
  automatically on detecting the bridge — a name captured from a real crash,
  but never confirmed as the right signal, and the symptom did not go away.
- **Root cause (08-27, confirmed by double proof):**
  1. **Code proof** — the official `skymp5-client` bundle
     (`E:\...\Data\Platform\UI\build.js`) sends, unconditionally, as the
     FIRST thing after rendering the React root (before any
     click):
     ```js
     if (window.skyrimPlatform?.sendMessage) window.skyrimPlatform.sendMessage('front-loaded');
     ```
  2. **Real-log proof** — `E:\...\Data\Platform\skymp5-client.log`
     (session of 2026-07-08) shows the complete chain:
     `AuthService: onBrowserMessage: ["front-loaded"]` → `Received
     browserWindowLoaded event` → `Received authNeeded event` → (from there
     on the native AuthService decides on its own).

     Our UI never sent `front-loaded` — it is plausible that the native
     `AuthService` got stuck before even considering
     `authNeeded`, regardless of whether `gameData.session` was correct.
- **Fix applied:** `skymp/ui/index.html` now sends `'front-loaded'`
  before `'authAttemptEvent'` (which was kept, without confirmation that
  production's `offlineMode: false` mode needs it, but at no cost to
  send). See the comment in the file itself for the full source.
- **Regression test:** [`skymp/ui/index.test.js`](../../skymp/ui/index.test.js)
  (new), running in CI via `.github/workflows/ci.yml` (job `higiene`).
- **Commit:** pending (will be recorded after commit).
- **Retest in real runtime:** **BLOCKED** — needs two clients of
  OUR build running against OUR server, no staging available
  on this machine right now. The log proof used here is from a vanilla bundle in
  `offlineMode: true`, not the `offlineMode: false` flow that production uses
  — `authNeeded` → online resolution still has no direct log proof.

### AUTH-06 — staging backup/restore could "succeed" without doing anything

A static review (no Docker available on this machine — not validated at
runtime, only by reading + lint) of `deploy/staging/Backup-Staging.ps1` and
`Restore-Staging.ps1` found the same class of bug in both:

- **Backup:** `mariadb-dump | gzip > file` inside `sh -c`. `/bin/sh`
  in the official images (dash/ash) has no `pipefail` — the exit code of `sh -c`
  is that of the LAST command in the pipe (`gzip`), not of `mariadb-dump`. If the dump
  fails midway (lock timeout, dropped connection), `gzip` compresses what it
  received up to EOF and exits `0`. The resulting backup is non-empty, has a valid
  SHA-256, passes every check in the script — and is truncated. You only
  find out by actually trying to restore.
- **Restore:** same pattern, inverted: `gzip -dc file | mariadb -uroot`.
  If the `/backups` volume is mounted wrong and the file does not exist
  inside the container (even though it exists on the host, already validated by
  checksum), `gzip` fails and writes nothing — but `mariadb -uroot` receives
  empty stdin, executes no statement and exits `0`. "Restore complete"
  without having restored anything.
- **Fix:** both now write to an intermediate file and
  chain with `;`/`&&` so that the propagated exit code is that of the command
  that can actually fail, not the last one in the pipe. Syntax validated with
  `[System.Management.Automation.Language.Parser]::ParseFile` (no errors) and
  the final resolved string checked manually — **not exercised against
  real Docker**, because there is no Docker on this machine.
- **Retest needed:** run a backup, deliberately corrupt/truncate the dump
  (e.g. kill the container in the middle of `mariadb-dump`), and
  confirm that `Backup-Staging.ps1` now throws an error instead of reporting
  success. Same for the restore with a badly mounted volume.

### Documented finding, not fixed — the queue can "promote" accounts without ever persisting the session

`apps/game-api/queue.js` + `server.js`: `_promoteFromWaiting` runs as a
side effect of ANY `join()`/`status()` — including another account's, and
including inside the `catch` of `persistAdmission` (via
`queue.release(..., makeSessionTicket)`). If `persistGameSession` fails
(database down), the account that caused the failure is released, but that
promotes the NEXT one in the queue into `_admitted` — with a new ticket
that nobody has tried to persist yet. If that second account never
queries `/api/queue/status` on its own again (e.g. gave up, closed the launcher),
it occupies a real slot with no persisted session until the reservation TTL (3 min)
expires. During database instability, this can drain `_waiting`
faster than it should, without any of these admissions having
materialized. It is not a security bug and does not create inconsistent data
(idempotency protects against double writes), but it wastes real
capacity at the worst possible moment. It needs a design decision
(should promotion be a side effect of a third party's request?) before
touching it — it is not a one-line fix.

### Found and fixed — migration v28 without a characterization test

`check-write-guards.js --all` already blocked this, but nobody had run it
after v28 landed: `migration-v28-crafting-stations.sql` was not
referenced by any test — the only migration in that situation (v29 already
had `public-work-migration.test.js`). Added
`skymp/gamemode/migration-v28-crafting-stations.test.js` following the same pattern as
v29 (reads the `.sql` as text, checks `CREATE TABLE`, the index and the cleanup of the
seed with a placeholder FormID). The guard passes cleanly again, suite 1265/1265.

### Review of `skymp/ui` (client-side, inside CEF) — nothing survived

Review of `player-panel.js`, `depot-panel.js` and `interaction-prompt.js`
(logic/flow, no infra). None of the findings from the initial sweep held
up when reading the real code:
- `player-panel.js`: the guard `if (!alias || !targetCharacterId) return;`
  already blocks a null/empty/zero `characterId` correctly (`Number('')` is
  `0`, `!0` is `true`) — the three scenarios raised (null, NaN, zero) all
  fall into the same guard.
- `depot-panel.js:106` (`data.holdId != null ? data.holdId : state.holdId`):
  technically it would accept a stale `holdId` if the server sent
  `null`, but `depot-service.js` never does — `holdId` is a mandatory, non-empty
  `string` along the whole server-side path (`typeof holdId
  !== 'string' || !holdId` rejects before that). Defensive code for a path
  that the server-side counterpart itself does not allow to exist.
- `interaction-prompt.js`: uses `=== null || === undefined` (not `!data.
  targetId`), so FormID `0` is already treated as a valid target — no
  current trap.

### Migrations v1→v29 — organization

`check:schema:list` (80 tables) and the `check-schema-drift.js` parser
(`listarArquivosSql`) do not require contiguous numbering — they sort by the version
extracted from the name, not by presence of every number. `v1`, `v16` and `v17`
do not exist as files (history of branches abandoned before the
unification of 08-22 — see
[BRANCH_LEGACY_2026-08-27.md](../technical/BRANCH_LEGACY_2026-08-27.md)),
but this is not a bug: I confirmed there are no duplicate numbers in the current
sequence (`v2`...`v29`, 27 files), which would be the truly dangerous scenario
(ambiguous application order). Cosmetically inconsistent organization,
functionally sound.

### Important finding, NOT fixed — `connection-monitor.js` can drop someone who never disconnected

`core/connection-monitor.js:tick()` decides disconnection from a single poll of
`mp.isConnected(userId)` every 2s (default), with no debounce or confirmation
across consecutive ticks. If the engine reports `false` for a single poll — lag,
network jitter, any transient instability — the player is cleaned up
completely (`removeActiveCharacter` + `playerPanel.cleanup`) and, on the
next tick, treated as a new connection: whitelist re-check from
scratch, session/panel reset, even though they never left the game.

**I did not fix this.** I do not know whether `mp.isConnected()` actually flickers in
practice — adding a debounce without evidence that the
problem really happens would be speculation (the same discipline the rest of the project already
follows: do not touch without runtime proof). Instead, I wrote a
characterization test (`core/connection-monitor.test.js`, new, "DOCUMENTS (does not
fix) a risk") that proves the current behavior exactly as it is —
it serves as a trigger in case someone decides to change the design later, and makes the risk
visible to whoever runs the real test.

**I explicitly ask that this be observed during Saturday's Milestone A/B**: during
the test with two real clients, cause a brief network instability
(throttling, Wi-Fi cut for 1-2s) on a connected client and see whether it is
kicked/reset without having actually left the game.

Secondary, minor finding, also not fixed: in the same file, a
whitelist response that arrives after the session has already been swapped (disconnect
+ fast reconnect on the same `userId`) is correctly ignored for *state*
(already tested in `connection-monitor.test.js`, "invalidates an old whitelist
response..."), but the approval it represented never increments
`metrics.approved` — the metric undercounts real approvals in a very
narrow window. Cosmetic, not fixed.

## Real blockers

1. **MariaDB/Docker absent on this machine** — prevents setting up a reproducible
   staging and testing the complete handshake (see section 9 of the master prompt).
2. **No two clients of this project's build running** — the two
   Steam installs found belong to other products/old sessions and do not
   serve as staging.
3. **Proof of `authNeeded` in online mode (`offlineMode: false`) still
   missing** — we only have a real log of the offline branch.

## Next action

Run Milestone A (login → spawn → chat → `[E]` → `/painel` → reconnection)
with two real clients against this stack, on a machine with MariaDB
available — it is the only way to confirm whether AUTH-05 really resolves
`connections.total: 0`, or whether something else is missing in the `authNeeded` chain in
online mode.
