# Anti-cheat — council analysis

**Proposal:** adopt a trainer detector in the launcher, modeled on what runs today on a Brazilian RP server (scans processes, installed applications and files, matches them against name signatures, reports to the server).

**Status: CLIENT SCANNER REJECTED. ALTERNATIVE APPROVED IN CONCEPT.**

Analysis according to [`CONSTITUICAO.md`](../CONSTITUICAO.md) §15. [`HEAVY_RP_GAP_ANALYSIS.md`](../research/HEAVY_RP_GAP_ANALYSIS.md) already classifies anti-cheat as `PARTIAL` and names the gap as **threat model and telemetry** — not as the absence of a scanner. This analysis agrees with that diagnosis and details it.

---

## Verdict first

The scanner detects **that the tool is installed**. What hurts us is **the manipulation happening**. They are different claims, and confusing them costs privacy without buying security.

Three reasons, in order of weight:

1. **It does not detect the only threat that really hits us.** See §2 — economy and items are already server-authoritative; what remains is ActorValue, and a process name says nothing about ActorValue.
2. **Cost of bypassing: renaming a file.** Cost of a false positive: accusing an innocent player. The asymmetry is inverted.
3. **It is personal data of Brazilians, in a public repository under the AGPL.** See §10 and §13.

What we **do** instead: the server observes the effect, not the tool. §14.

---

## 1. Goal

Prevent someone from obtaining, by manipulating the client, an advantage the server accepts as true — and give staff a way to judge when it happens.

## 2. Problem it solves — and its real size

This is the part that reorganizes the discussion. **Most of what a trainer does does not hit us**, because the architecture already assumes a hostile client (`CONTRIBUTING.md` §3.6):

| What the trainer does | Does it hit us? | Why |
|---|---|---|
| Infinite gold | **No** | Gold lives in `characters.gold`, moved only by `core/transaction-service` |
| Create items | **No** | Items live in `character_inventory`; a local `AddItem` vanishes on relog (`MODS_AND_GAMEMODE_CONTRACT` §2) |
| Teleport, no-clip | **No** | Cosmetic for the server; the world derives no state from it |
| **Godmode, infinite health** | **YES** | `death-service.js:245` reads `getActorValue('Health')`. Health that does not drop = never enters `DOWNED` |
| **Speed, stamina** | **YES** | Same path: an ActorValue the server reads |

**The mods contract already records this boundary:** *a mod cannot create state, but it can touch ActorValue, and the server reads ActorValue.*

So the real problem is narrow and nameable: **ActorValue manipulation**. Not "trainers".

## 3. Problems the proposal creates

### 3.1 It detects the wrong thing

Their detector matches **names** against nine signatures (Cheat Engine, WeMod, PLITCH, ArtMoney, and a generic one for `trainer`). That answers *is there a program with this name on this machine?* — and not *is this character's health being manipulated?*

A player who has had Cheat Engine installed for two years for a single-player game is flagged. A player with godmode active through a homemade mod is not.

### 3.2 A false positive is the cost nobody accounts for

The generic pattern matches anything: a `Combat Trainer.esp` mod, a `Personal Trainer` folder, a certification PDF. They know this — there is an option to turn off the generic pattern in their code, which is an admission that the heuristic is noisy.

A false positive here is not noise: it is **accusing a player of cheating**. In an RP community, that accusation outlives the retraction.

### 3.3 Bypassing it costs five seconds

Rename the executable. That is all. Whoever cheats on purpose gets through; whoever does not cheat gets scanned. **The tool punishes exactly the people it should not reach.**

### 3.4 It creates a false expectation of security

Worse than not having it: staff start trusting that "the system catches it" and stop looking.

## 4. Possible exploits

- **Rename the executable** — nullifies everything.
- **Run from a USB stick or a VM** — outside the scanned roots.
- **Plant a false positive on someone else.** Create a file with a poisoned name in another player's folder (Discord, shared folder, a mod distributed with that file inside) and they get flagged. **An automatic accusation system becomes a weapon.**
- **Poison the reporting channel.** The report comes from the client; a hostile client sends whatever it wants — including a clean report, including a forged accusation against someone else.

This last one is decisive: **it is a hostile-client detector whose output comes from the hostile client.**

## 5. Impact on the economy

None, in both directions. The economy is already server-authoritative — that is why `economy-service` was deleted. The scanner does not protect what is already protected, and does not reach what is exposed (ActorValue is not economic).

## 6. Political impact

Negative and underestimated. Whoever operates the detector decides who gets accused. Without a process, that is power without accountability — exactly what §5 of the Constitution forbids and what the integration with the Chancery exists to solve.

## 7. Military impact

The only place where the real threat bites: godmode in a combat scene destroys the scene and the trust in it. **But the scanner does not detect godmode** — it detects installation. The military impact justifies acting; it does not justify *this* mechanism.

## 8. Religious impact

None directly. Indirectly if there is a soul or corruption mechanic reading ActorValue: manipulation would start falsifying a character's fate, which raises the stakes of §14.

## 9. Social impact

**The biggest risk in the document.** A Heavy RP community works on trust. A system that scans everyone's machine communicates distrust by default, and the first wrong accusation costs more than ten undetected cheats.

There is a better social path that already exists: **the world notices**. Someone who survives what should have killed them is noticed by whoever was in the scene — and that already becomes a report with a witness.

## 10. Technical impact

- **Maximum blast radius.** The launcher runs before the game, with user privilege. It is the worst place in our stack to put something invasive.
- **PowerShell every 30 s** and a scan of thousands of files every 10 min, on the machine of someone who just wants to play.
- **A new reporting channel** = a new authentication and abuse surface.
- **LGPD.** Brazilian players, personal data. A list of installed applications is revealing (medical software, dating apps, job-search tools). It requires a legal basis, a declared purpose, minimization and transparency. *It's for anti-cheat* is not an automatic legal basis.
- **Public repository under the AGPL.** We would be publishing the skeleton of a program that scans the user's machine and reports to a remote server. Any fork points the endpoint wherever it wants. The AGPL requires offering the source — that mitigates, it does not eliminate.

## 11. Narrative impact

Zero. A scanner produces no story. It is invisible police infrastructure.

## 12. How it generates stories

**It does not** — and under §4 of the Constitution that is enough to discard it *in the proposed form*.

The alternative does: health that does not drop becomes a **recorded anomaly**, which becomes **evidence**, which becomes a **case** with witnesses — the same path as `death:killer`. The cheater stops being a silent ban and becomes a judged case that the community sees happen.

## 13. How it can be abused

- **By whoever operates it:** scanning a player's machine is surveillance; without a narrow, audited purpose, it becomes browsing someone else's résumé.
- **By player against player:** planting false positives (§4).
- **By a fork:** our public code, their endpoint, without our safeguards — and with our reputation in the project's name.

## 14. How to balance — what we do instead

### 14.1 The server observes the effect, not the tool

`death-service` **already** reads `getActorValue('Health')` every 2 s. The plausibility check piggybacks on the data we already fetch: **zero extra Papyrus calls** — which matters, because each round trip costs 13–35 ms.

What is implausible and the server sees on its own:

- Health that **does not drop** while polling records damage (`checkDamageSpike` already exists).
- Health that **rises** without a healing, potion or rest event.
- Health **above the character's known maximum**.
- Displacement per tick above the physical limit.

This cannot be bypassed by renaming a file. It detects the effect **regardless of the tool** — trainer, homemade mod, script, it makes no difference.

### 14.2 Never an automatic ban — evidence, like `death:killer`

An anomaly becomes a row in `audit_logs`, in the `cheating` category that [`MODERATION_WORKFLOW.md`](../admin/MODERATION_WORKFLOW.md) already provides for. **Staff judge.** It is the same rule that already applies to death authorship: OOC truth goes to whoever judges, it never becomes a sentence on its own.

### 14.3 Confirmation window — their good idea, reused

Their detector requires **3 observations within 70 s** before believing, with a 6 h cooldown. That is honest engineering against flapping, and it applies equally on the server side: **never flag based on one strange tick.** Network, lag and the game itself produce isolated absurd readings.

### 14.4 The legitimate middle ground on the client, if it is ever needed

The launcher **already** hashes files for modpack parity, and the player already consented to that by joining. Extending *that* check — integrity of the SKSE DLL, a plugin injected into `Data/` — stays **within the envelope of consent that already exists**, does not scan unrelated files, and is justified by the FormID contract.

That is different, in nature, from listing a person's installed applications.

## 15. How it integrates with the rest of the world

| System | Link |
|---|---|
| `death-service` | Where the check lives — health polling already exists |
| `core/range-utils` | `nearbyActors()` already provides the scene's witnesses |
| `audit_logs` | Where the evidence lands, category `cheating` |
| `MODERATION_WORKFLOW` | The judgment flow is already written |
| `governance-service` | Cheating becomes a case, not a lynching |
| Royal Chancery | Attachable evidence, with a witness |
| Modpack parity | Where the only legitimate client check fits (§14.4) |

---

## Recommended order

**Prerequisite: Phase 0.** You cannot calibrate a plausibility threshold without a real session — without data, any number is a guess, and a guess in cheat detection produces false positives.

1. **Measure before detecting.** During Phase 0, record health and displacement readings **without judging anything**. That is the *threat model / telemetry* the gap analysis asks for.
2. **ActorValue plausibility** on top of the existing polling, with a confirmation window, writing to `audit_logs`.
3. **SKSE integrity** within the parity check that already exists (§14.4).
4. **Never** the process and installed-application scanner, except by explicit decision with an LGPD legal basis, notice to the player and mandatory human review — and even then, not in the public repository.

## The decision, in one sentence

> We detect **the effect on the server**, never **the tool on the client**. The first cannot be forged and costs no privacy; the second is bypassed by renaming a file and charges the player's whole machine in exchange.
