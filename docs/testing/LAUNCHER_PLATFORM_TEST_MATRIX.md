# Test matrix — launcher platform

Original date: **2026-08-13**. Connection bootstrap revised on
**2026-08-26**. Covers `apps/launcher`, `apps/game-api` and the
`apps/web` path that the launcher uses.

Derived from [`PLATFORM_INFRASTRUCTURE_AUDIT.md`](../research/PLATFORM_INFRASTRUCTURE_AUDIT.md). Where a scenario tests a finding, the ID (`PLAT-nn`) is on the row.

> **What a green matrix means here.** The same as in the rest of the repository: *nothing that was already verified broke*. It does not mean it works in the player's hands — see [`QA_REPORT_2026-08.md`](../technical/QA_REPORT_2026-08.md). The **How** column exists precisely to separate what a suite proves from what only a machine with Skyrim installed proves.

---

## 1. Legend

**State**
`✅` covered today · `⚠️` partial · `❌` no coverage · `➖` not applicable until the system exists

**How**
`unit` — `node --test`, no network, no disk, no database
`http` — ephemeral server, like `apps/game-api/server.http.test.js`
`integration` — requires MySQL
`manual` — requires Windows with Skyrim installed; **not automatable**

**The project's rigor convention:** every test marked `✅` must have been verified by mutation — break the implementation on purpose and confirm the test fails. A test that passes in both states tests nothing.

---

## 2. Clean install

| # | Scenario | Expected | How | State |
|---|---|---|---|---|
| 2.1 | First run without `launcher-config.json` | Opens on Login, does not break | manual | ❌ |
| 2.2 | Game folder never configured, click PLAY | Redirects to Settings with a message, not a generic error | manual | ❌ |
| 2.3 | Folder without `SkyrimSE.exe` | `{ ok: false, reason: 'no-skyrim' }` | unit | ❌ (`validateGamePath` is not tested) |
| 2.4 | GOG folder (`Galaxy64.dll` or `goggame-*.info`) | `reason: 'gog'`, entry blocked | unit | ❌ |
| 2.5 | Non-downgraded Skyrim AE (build ≠ 1.6.1170) | **Should** block. Today it **passes** | manual | ❌ `PLAT-26` |
| 2.6 | `Data/` missing | Specific message, not a raw exception | unit | ❌ |
| 2.7 | `SkyrimPrefs.ini` does not exist | `ensure-skyrim-ini` creates it with the detected resolution | manual | ❌ |

2.3, 2.4 and 2.6 are the same work: extract `validateGamePath` from `main.ts` into a pure module, as was already done with `parity.mjs`. It is the pattern the repository has already adopted and the reason is written in that file's header — logic inside `ipcMain.handle` is logic that cannot be tested.

2.5 depends on implementing the check, which does not exist.

---

## 3. Update

| # | Scenario | Expected | How | State |
|---|---|---|---|---|
| 3.1 | Client manifest with a new `clientVersion` | `updateAvailable: true` | unit | ❌ |
| 3.2 | Local stamp equal to the manifest | `updateAvailable: false`, no download | unit | ❌ |
| 3.3 | Manifest **without** `sha256` | Aborts, **does not install** | unit | ❌ (behavior exists, `main.ts:1034`) |
| 3.4 | `sha256` does not match | Aborts, deletes the temp file, does not extract | unit | ❌ |
| 3.5 | Download interrupted midway | Clean failure; the next attempt starts over | integration | ❌ |
| 3.6 | Modpack in parts, one part with an equal `contentSig` | Part skipped, `skipped` increments | unit | ❌ |
| 3.7 | Game open during the update | `gameRunning: true`, refuses before downloading | manual | ❌ |
| 3.8 | Extraction fails midway | The stamp is **not** written; the next attempt redoes it | unit | ❌ |
| 3.9 | Manifest with a `manifestVersion` higher than known | `ERROR: MANIFEST_TOO_NEW`, does not ignore fields | unit | ➖ `PLAT-06` |
| 3.10 | `development` manifest served at the `stable` URL | Refused due to channel mismatch | unit | ➖ `PLAT-21` |
| 3.11 | Player never opens Settings | **Should** update in the play flow. Today it **does not update** | manual | ❌ `PLAT-01` |

3.3 and 3.4 are the most important tests in this section and the cheapest: the correct behavior is already implemented and nothing protects it from a regression. They are exactly the case where a test is worth it because the logic is right **today**.

3.9 and 3.10 are `➖` because they test fields the format does not have yet.

---

## 4. Integrity and parity

Where current coverage is good. `parity.test.mjs` already covers the core.

| # | Scenario | Expected | How | State |
|---|---|---|---|---|
| 4.1 | Manifest file missing in `Data/` | `Mod faltando: X` ("Mod missing: X") | unit | ✅ |
| 4.2 | File present with a different hash | `esta modificado ou corrompido` ("is modified or corrupted") | unit | ✅ |
| 4.3 | Case difference in the name (Windows) | Matches anyway | unit | ✅ |
| 4.4 | Plugin from the server order missing | `Plugin ausente: X` ("Plugin missing: X") | unit | ✅ |
| 4.5 | Master loading after the dependent | Failed | unit | ✅ |
| 4.6 | Extra plugin active in `plugins.txt` | Failed, with the FormID explanation | unit | ✅ |
| 4.7 | Server does not provide a load order | Fails; does **not** fall back to the local order | unit | ✅ |
| 4.8 | Active CC in `Skyrim.ccc` outside the server order | Failed | unit | ✅ |
| 4.9 | CC required by the server and missing on the client | Failed | unit | ✅ |
| 4.10 | Invalid TES4 header / truncated file | Named error, no exception | unit | ✅ |
| 4.11 | **Extra BSA** in `Data/`, outside the manifest | Depends on `extraFilePolicy` | unit | ❌ `PLAT-11` |
| 4.12 | BSA above 2 GB | Hashes by stream, without blowing up memory | integration | ❌ `PLAT-10` |
| 4.13 | `verify-mods` with N divergences | Reports **all of them**, not the first | unit | ❌ `PLAT-05` |
| 4.14 | `/mods.json` responds 503 | The launcher does **not** approve; specific message | http | ⚠️ (503 tested on the server; the launcher's reaction is not) |
| 4.15 | Empty manifest (`mods: []`, `loadOrder: []`) | Refused at the source, never served | unit | ❌ `PLAT-27` — it is **served with 200** |
| 4.16 | Manifest with `mods: []` and a filled `loadOrder` | Content not verified; order is | unit | ⚠️ deliberate behavior (`--only-load-order`) |

4.15 is the finding that writing this matrix produced, and it is worth opening up. `modsManifest.js:20-28` documents in its header that it exists to prevent an empty list from passing the parity check — but `isValidManifest({ mods: [], loadOrder: [] })` returns **`true`** (`[].every()` is `true`), and `modsManifest.test.js:33` records this explicitly: *"accepts an empty manifest in shape, but the loader handles the rest"*. **The loader does not handle the rest.** `load()` does no check beyond `isValidManifest`, and `/mods.json` serves the empty manifest with 200.

What actually stops the player is another module, on the client side: `analyzePlugins` refuses an empty `serverLoadOrder` (`parity.mjs:165-171`). The protection exists and works — but it is in the wrong place, in a process that runs on the player's machine, and the document and the test say it is on the server. See `PLAT-27` in the audit.

---

## 5. Repair

All `➖`: the mode does not exist (`PLAT-02`). The matrix is written down for when it exists.

| # | Scenario | Expected | How |
|---|---|---|---|
| 5.1 | One missing file | Downloads only it | integration |
| 5.2 | One corrupted file | Replaces only it, via staging | integration |
| 5.3 | `manual-install` file missing | **Does not download**; instructs and blocks | unit |
| 5.4 | Unexpected extra file | Quarantine, never delete | unit |
| 5.5 | Repair above the volume threshold | Asks before downloading | manual |
| 5.6 | Failure in the middle of the repair | Previous state preserved (backup) | integration |
| 5.7 | Repair of a file in use by the game | Refuses with `gameRunning` before touching disk | manual |
| 5.8 | Full repair (`--full`) | Equivalent to today's `force` | integration |

---

## 6. Malformed and adversarial manifest

| # | Scenario | Expected | How | State |
|---|---|---|---|---|
| 6.1 | `mods.json` with invalid JSON | 503 with `manifest_invalid_json` | unit | ✅ |
| 6.2 | `mods.json` with the wrong shape | 503 with `manifest_invalid_shape` | unit | ✅ |
| 6.3 | File missing on disk | 503 with `manifest_missing` | unit | ✅ |
| 6.4 | Manifest swapped with a new `mtime` | Cache invalidated, re-reads | unit | ✅ |
| 6.5 | `path` with `..` | **Whole manifest** refused, not just the entry | unit | ➖ `PLAT-07` |
| 6.6 | Absolute `path` or one with a drive (`C:`) | Same | unit | ➖ |
| 6.7 | `path` with a reserved Windows name (`CON`, `NUL`, `COM1`) | Same | unit | ➖ |
| 6.8 | ZIP containing `../../Windows/…` | Extraction refuses | unit | ❌ `PLAT-07` |
| 6.9 | ZIP with a symlink/junction pointing outside | Extraction refuses | manual | ❌ |
| 6.10 | `downloadUrl` to a host outside the allowlist | Download refused | unit | ❌ `PLAT-08` |
| 6.11 | Redirect to an unauthorized host | Refused | unit | ❌ `PLAT-08` |
| 6.12 | Manifest feed served over HTTP | Refused | unit | ❌ `PLAT-08` (`httpGetJson` accepts it today) |
| 6.13 | `downloadUrl` with `manual-install` | The generator **refuses to produce** the manifest | unit | ➖ (policy §3) |

6.8 is the most important row in the whole matrix. It is automatable without Skyrim and without network: build a ZIP with a `../x` entry, call `extractZip` on a temporary directory, and verify nothing was written outside it. **The test can be written before the fix** — it fails, and that failure is what documents the problem.

---

## 7. Backend unavailable

| # | Scenario | Expected | How | State |
|---|---|---|---|---|
| 7.1 | `game-api` down, click PLAY | `connection_failed` with useful text | http | ⚠️ |
| 7.2 | Panel down during login | Named error, not a hanging window | manual | ❌ |
| 7.3 | MySQL down | `/ready` responds **503**; `/health` stays 200 | http | ➖ `PLAT-18` |
| 7.4 | MySQL down, player tries to join | `internal_error` — and `/ready` explains why | integration | ⚠️ |
| 7.5 | Update feed timeout | Fails within 20 s (already implemented), without freezing the UI | unit | ❌ |
| 7.6 | Server in maintenance | `/status` returns `maintenance` + a message; the launcher shows it | http | ➖ `PLAT-20` |
| 7.7 | Server full | `/status` returns `full`; PLAY becomes "join the queue" | http | ➖ |

---

## 8. Queue

Current coverage: `queue.test.js`, 13 tests in 6 suites, all in memory. Verified with `node --test`.

| # | Scenario | Expected | How | State |
|---|---|---|---|---|
| 8.1 | Free slot | Admits directly with a ticket | unit | ✅ |
| 8.2 | Capacity full | Queues, correct position | unit | ✅ |
| 8.3 | Order of arrival | FIFO respected | unit | ✅ |
| 8.4 | Repeated `join` (polling) | Same ticket, not a new slot | unit | ✅ |
| 8.5 | Repeated `join` from someone in the queue | Does not duplicate the position | unit | ✅ |
| 8.6 | `release` | Promotes the next one | unit | ✅ |
| 8.7 | `release` of someone not admitted | Does not promote wrongly | unit | ✅ |
| 8.8 | Reservation expires without connecting | The slot goes back to the queue | unit | ✅ |
| 8.9 | Someone who connected does not lose their slot due to time | Keeps it | unit | ✅ |
| 8.10 | Valid session ticket | Resolves and marks connected | unit | ✅ |
| 8.11 | Unknown ticket | Does not resolve | unit | ✅ |
| 8.12 | Ticket after `release` | Stops resolving | unit | ✅ |
| 8.13 | Account that never joined | `not_queued` | unit | ✅ |
| 8.14 | **Two launchers, same `auth.json`** | One gets in; the other gets an **explainable** error, not a raw `invalid_ticket` | integration | ❌ |
| 8.15 | **`game-api` restart with players inside** | Occupancy must **not** go back to zero | integration | ❌ `PLAT-13` |
| 8.16 | Capacity race | Does not exist inside the queue (synchronous, single-threaded) | — | ➖ |
| 8.17 | `launch_tickets` persistence under long polling | Purging keeps the table bounded | integration | ❌ `PLAT-16` |

8.16 is recorded as `➖` on purpose: briefing §13 asks for the scenario, and the honest answer is that it does not exist where it is expected. The real race is in 8.15, through a restart — not inside the data structure.

8.14 is worth unpacking, because the behavior is correct and the message is the problem: the `launchTicket` is single-use, so the second launcher loses the race by design. What is missing is the error saying so ("another launcher is already using this account") instead of `invalid_ticket`.

---

## 9. Tickets and sessions

| # | Scenario | Expected | How | State |
|---|---|---|---|---|
| 9.1 | Ticket missing / empty / short | 401 before touching the database | http | ✅ |
| 9.2 | Ticket in the query string | Ignored; same response as sending nothing | http | ✅ |
| 9.3 | `GET /api/queue/status` | No longer exists | http | ✅ |
| 9.4 | `/internal/*` without `X-Internal-Secret` | 401 | http | ✅ |
| 9.5 | Valid ticket, eligible account | Admits and persists the session | integration | ❌ (happy path, declared in the footer of `server.http.test.js`) |
| 9.6 | Ticket already consumed | 401 | integration | ❌ |
| 9.7 | Expired ticket (>5 min) | 401 | integration | ❌ |
| 9.8 | Same ticket, two simultaneous requests | Exactly one `affectedRows === 1` | integration | ❌ |
| 9.9 | Account banned between login and queue | `account_not_active` | integration | ❌ |
| 9.10 | Account without an approved whitelist | `not_whitelisted` | integration | ❌ |
| 9.11 | Account without an approved character | `no_approved_character` | integration | ❌ |
| 9.12 | Session resolved in the master | `{ user: { id } }`, `resolve_count` increments | integration | ⚠️ (`apps/web/server.test.js` checks the SQL) |
| 9.13 | Revoked session | Master refuses | integration | ⚠️ (SQL verified; **nothing writes `revoked_at`** — `PLAT-14`) |
| 9.14 | Expired session (>12 h) | Master refuses | integration | ❌ |
| 9.15 | **Same session resolved from two IPs** | Should be detectable | integration | ❌ `PLAT-15` |
| 9.16 | `release` revokes the account's session | `revoked_at` filled in | integration | ❌ `PLAT-14` |
| 9.17 | Empty ticket reaches the bootstrap | Refuses before creating/changing configuration or starting SKSE | unit | ✅ |
| 9.18 | Valid legacy JSON | Keeps unknown options and removes `profileId`/`token`/`launcherTicket` | unit | ✅ |
| 9.19 | Existing corrupted JSON | Fails closed without silently overwriting the other contract | unit | ✅ |
| 9.20 | Read-only configuration files | Updates and restores the previous mode | unit | ✅ |
| 9.21 | Invalid host/port | Refuses with a stable code before the spawn | unit | ✅ |
| 9.22 | Direct destination | Writes IP/port and `server-info-ignore:true` to the settings | unit | ✅ |
| 9.23 | Error creating the process | The UI receives `{ok:false,code,error}`; does not announce success | unit | ✅ |
| 9.24 | Process without a PID or without confirmation | Fails on invalid PID/timeout and does not call `unref()` | unit | ✅ |
| 9.25 | Bootstrap order | Prepare/re-read → terminate old processes → spawn | unit/contract | ✅ |
| 9.26 | Two real clients | Each session resolves the correct `accountId` on the direct server | manual | ❌ |

9.8 is the test that proves the central security property of this system — single use under concurrency — and it is the only one in the section that **cannot** be replaced by reading code. Two connections, same ticket, count how many get through. It requires a database.

The 9.5–9.11 block is a single debt: **there is no MySQL integration harness in this repository.** Until there is one, the whole column stays `❌`, and no per-row work fixes it. Building it (an ephemeral MariaDB container, migrations applied, data seeded) unlocks 12 rows of this matrix at once, and it is the highest-leverage item here.

9.17–9.25 cover the local boundary created by
[`ADR-012`](../technical/ADR_012_LAUNCHER_CONNECTION_BOOTSTRAP.md). They prove
that the launcher prepares a coherent connection and does not produce a false success. They do not
prove the complete handshake: 9.26 remains mandatory because it involves the
real SkyMP client, the Windows process, the Game API and the Master API.

---

## 10. Modpack change

| # | Scenario | Expected | How | State |
|---|---|---|---|---|
| 10.1 | Server publishes a new modpack with players inside | Those playing do not drop; those joining later use the new one | manual | ❌ |
| 10.2 | Load order changes order, same files | Clients with the old order fail | unit | ✅ (4.6 covers the mechanism) |
| 10.3 | Manifest regenerated with `--only-load-order` | Covers fewer files and the document says so | unit | ✅ |
| 10.4 | Manifest generated without `--plugins-txt` | Warns loudly that the order is alphabetical and unreliable | unit | ✅ |
| 10.5 | Load order with a plugin that does not exist in `Data/` | The generator fails, does not publish | unit | ✅ |
| 10.6 | `build` changes; an old client tries to join | The **server** should refuse | integration | ➖ `MOD-006` |

10.6 is the only row in this matrix that tests a **server-side** defense. All the others test the launcher — and a modified launcher skips all of them. That is not a failure of this matrix; it is the reason `MOD-006` exists in the roadmap.

---

## 11. Where to invest first

Ordered by (value × ease), not by severity:

| Order | What | Unlocks | Cost |
|---|---|---|---|
| 1 | Refuse an empty manifest in the loader + test (4.15) | `PLAT-27` — the highest severity for the lowest cost | Trivial — three lines |
| 2 | Zip slip test (6.8) | Documents `PLAT-07` before fixing it | Low — no network, no Skyrim |
| 3 | Extract `validateGamePath` into a pure module | 2.3, 2.4, 2.6 | Low — the `parity.mjs` pattern already exists |
| 4 | Manifest-without-`sha256` tests (3.3, 3.4) | Protects **already correct** behavior from regression | Low |
| 5 | MySQL integration harness | 12 rows of §9 at once | Medium, and it is the biggest leap |
| 6 | `/ready` + test (7.3) | Diagnosis of `PLAT-18` | Low |

The first five require no product decision and do not depend on Phase 0. The sixth is the smallest useful unit of operations work.

---

## 12. What this matrix does not cover

- **Nothing in-game.** Where the launcher hands control over to SKSE, this matrix ends.
- **No case is executable today without writing the test.** The `❌` rows are gaps, not recorded failures — none was observed, all were deduced from the code.
- **SmartScreen and signing** remain in [`LAUNCHER_DISTRIBUTION.md`](../technical/LAUNCHER_DISTRIBUTION.md) §6.3, and remain non-automatable.
- **No real session.** Like the whole repository.
