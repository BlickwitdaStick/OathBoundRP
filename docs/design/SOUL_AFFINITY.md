# Soul Affinity — closed design

**Proposal:** replace Soul DNA with a single affinity system that explains magic, vampirism, lycanthropy, blessings, curses, corruption, enchanting and noble lineage.

**Status: DESIGN CLOSED. Domain implemented and tested.** One veto and four conditions, all incorporated. Amended §8 of the Constitution (v1.1).

`skymp/gamemode/core/soul.js` — generator, bands and resolution — **exists, with 28 tests** (§III.13). It is a pure function: it opens no database, does not touch `mp`, does not know a game exists. `skymp/gamemode/soul-service.js` is also implemented and registered behind `ENABLE_SOUL_SERVICE`: it persists the soul, delivers signs, records marks, advances trees and exposes `/alma`. It is off by default and still needs validation with a real client in Phase 0.

The document has three parts. **Part I** is the 15-point analysis required by Constitution §15 — what the proposal solves and what it breaks. **Part II** is the design that comes out of it: how the system becomes good gameplay without losing playability or fun. **Part III** is the specification — values, formula, schema, events and tests.

If you are only going to read one: **Part II**. It contains the answer; I contains the why and III contains the how.

Analysis according to [`CONSTITUICAO.md`](../CONSTITUICAO.md) §15.

---

## Verdict first

The central idea is right and solves a real Skyrim problem: in vanilla, everyone learns everything, and that is poison for Heavy RP. A soul that changes **cost and risk** creates specialization without a closed class, and the **Transformation Tree** ("you do not become a vampire, you walk a path") is the best idea in the proposal — it solves the binary state and turns a curse into a trajectory.

Three things need to change before it exists:

1. **VETO: the 70% death roll on a bite.** Detailed in §3.1. In the proposed form, it turns any vampire into a walking `/permakill` button.
2. **"2 months vs 2 years" is a closed class by another name.** §3.2.
3. **A hidden number that decides outcomes is indistinguishable from a bug and from staff favoritism.** §4.2.

And an addition from the council that solves the problem you raised yourself ("being born better is not fun") at the root: **no soul may be strictly better than another.** §14.

---

## 1. Goal

That progression is narrative and not a talent tree: two characters walking the same path arrive at different places because of who they are and what they chose.

## 2. Problem it solves

- **Skyrim is a machine for identical characters.** Everyone becomes archmage, Companion, Blade and Listener in the same save. That erases identity, which is the currency of Heavy RP.
- **Power without scarcity.** Today anyone enchants, so enchanter is not a profession — and Constitution §11 requires every chain to have a bottleneck.
- **Vampire and werewolf as a buff.** Constitution §9 already forbids it; what was missing was the mechanism that makes the curse rare and expensive.
- **Noble Houses without mechanical identity.** Today they are a table.

## 3. Problems the proposal creates

### 3.1 🔴 VETO — the bite with 70% death

The scenario: a character approved at whitelist, played for months, with social bonds and history. They enter a scene and get bitten. The server rolls. **70% of the time the character dies — permanently, by dice, because of another player's action.**

That violates three things at once:

- **`HEAVY_RP_RULES.md` §6 (powergaming):** "forcing another character to accept permanent consequences without the required process". The bite does exactly that, with the server as accomplice.
- **Constitution §5:** an irreversible choice without warning.
- **It makes the vampire unplayable too.** A vampire who wants to create progeny kills 7 out of 10 attempts. You cannot build a clan, and the clan is the political part that justifies vampirism existing.

And it creates a clean grief vector: just bite to permakill, with the ready defense of "it was the dice".

**Alternative:** the bite **never resolves anything on its own**. It starts a process — the first step of the tree, not a coin toss over someone's life. See §14.2.

### 3.2 🔴 "2 months vs 2 years" is a disguised closed class

An RP server's retention is measured in months. A 2-year path is not a hard path: it is a closed door with an "open" sign. Constitution §5 forbids closed classes.

Worse: since the number is hidden, Pedro does not know he chose a 2-year path. He just feels the game is not responding, and he leaves.

**Alternative:** affinity does not change **time to unlock**, it changes **cost, risk and ceiling**. Pedro casts Fireball — but he needs a master, a component, a longer ritual, and he fails more. He gets there. He gets there at a higher price and with more scars. That is Heavy RP; "wait two years" is an absence of gameplay.

### 3.3 🟠 Rerolling until you get a good soul

A soul generated at creation gets reverse-engineered by the community within weeks. Whitelist + permadeath make rerolling more expensive, but that is **accidental containment** — and it does not protect the server's early days, when nobody is attached to a character.

**Alternative in §14.1:** derive the soul from the approved sheet, not from chance.

### 3.4 🟠 Monopoly by birth

If a true enchanter is born ready, the server may end up with one or two. That is scarcity (good, §11) until the person stops playing — and then a whole industry dies with them. A single point of failure that is a **person**.

**Mitigation:** affinity is necessary for **mastery**, not for **practice**. An apprentice with low affinity produces a common piece; the exceptional piece requires the master. And a master can train — slowly, transferring technique, not soul.

### 3.5 🟡 Hereditary noble lineage

Creates great political identity. But mechanizing blood inheritance quickly runs into marriage as a statistic and exclusion by birth. It needs to be a **tendency**, never a requirement for office, and the House needs to be able to adopt, recognize a bastard and get succession wrong — which is where the stories are.

## 4. Possible exploits

### 4.1 Discovering and optimizing the hidden
The community will measure. It always does. Within 3 months there is a community spreadsheet on "how to find out your affinity in 20 minutes".

**This is not avoidable — it is manageable.** The system has to remain interesting **after** it is known. A system that only works while it is a secret is born with an expiration date.

### 4.2 🔴 The hidden as a shield for accusations
This is the community risk, and it is more dangerous than any mechanical exploit.

A player fails five rituals in a row. They cannot distinguish between: low affinity, a bug, and **staff favoring a friend**. With the number invisible, the favoritism accusation is **unfalsifiable** — and RP servers die of that, not of bugs.

**Mandatory condition:** every roll writes its inputs, result and seed to `audit_logs`. A deterministic seed derived from the character + the event, so that staff can **reproduce and prove** any contested result. The number stays hidden from the player; the audit does not.

### 4.3 Grief through forced transformation
Permanently altering another character's soul without consent is the supernatural version of RDM. It needs the same process that a permanent consequence already requires.

### 4.4 Character suicide as a reroll
If the soul comes from chance, killing your own character becomes a strategy. Solved by §14.1.

## 5. Impact on the economy

**Positive and structural.** Enchanting stops being infinite production and becomes a chain with a human bottleneck (§11): Soul Gems → enchanter with affinity → a piece with a signature and history. It creates a market, fame, theft targets and commissions.

**Risk:** price hyperinflation for a single master's service. Mitigated by §3.4 (the apprentice produces the common).

**Hard requirement:** everything that generates value goes through `core/transaction-service`. No new gold or item path outside it — that is how `economy-service` got deleted.

## 6. Political impact

High and desirable. If House A leans divine and House B martial, the dispute for offices gains a substrate. A Jarl with a hidden shadow affinity is an entire plot.

**Caution:** affinity can **never** be a requirement for public office. The instant it is, the political game becomes a table lookup — and politics dies.

## 7. Military impact

A legendary warrior through martial affinity is good. But SkyMP combat belongs to the client, and the server does not arbitrate blows (see `MODS_AND_GAMEMODE_CONTRACT.md`). Martial affinity can only act where the server is in charge: fatigue, injury, recovery time, command capacity. **Never on per-hit damage.**

## 8. Religious impact

The best story generator in the proposal: **the devout man who has no divine affinity.** That is pure drama, and the church as an institution gains the question "who was truly touched?".

**Condition:** the church cannot have a detector. If the temple measures affinity, the mystery is over and so is faith — it becomes a blood test.

## 9. Social impact

It creates the informal hierarchy Heavy RP needs: who is sought out for what. It also creates playable prejudice (§9 of the Constitution already asks for this for vampires).

**Real risk:** if affinity becomes public in practice — and it will, through reputation — players with a "bad soul" become second-class citizens **outside** the character. That is community management, not code, and it needs to be in the rules before the system exists.

## 10. Technical impact

- **A new table** (`character_soul`), 8 attributes + mutation history. Cheap.
- **Every soul change is an event**, never a direct write — Constitution §13 requires event-driven, and this is the perfect use case.
- **Manifested corruption** (nightmare, voice, physical change): the server does messages and animations today; **physical change requires our own plugin** — stable FormIDs, no script, with the logic in Node (the pattern already documented in `MODS_AND_GAMEMODE_CONTRACT.md` §5).
- **The tree is a state machine**, a sibling of `core/character-state.js`. Its own module, registered in `module-registry`, behind a flag.
- ⚠️ **None of this may become polling.** We already have three services running every 2 s and a Papyrus call costs 13–35 ms.

## 11. Narrative impact

It is the strongest point. It replaces progression with biography: two vampires, same path, one becomes a stable Lord after years of preparation and the other goes mad. That is Constitution §4 being fulfilled literally.

## 12. How it generates stories

- The gifted one who **does not want** the gift — and is hunted for it.
- The devout without divine affinity who builds the church anyway.
- The master enchanter whose signature is worth more than the piece, and who gets kidnapped because of it.
- The Noble House that discovers the heir does not have the blood.
- The server's first vampire, whose name everyone will know.
- The necromancer who still looks human — and the one who no longer does.

## 13. How it can be abused

Covered in §3.1, §4.1–4.4. The most serious is **grief through transformation**, and the second is **the unfalsifiable accusation of favoritism**.

## 14. How to balance — the four conditions

### 14.1 The soul comes from the sheet, not from the dice
A deterministic seed derived from the approved whitelist application — which **already collects `motivations`, `weaknesses` and `social_ties`** (migration v5, exists today). Same sheet, same soul.

Three gains at once: reroll-farming ends; the sheet starts to **matter mechanically**, which improves the quality of applications; and staff, who already review concepts, start reviewing destinies without needing a new tool.

### 14.2 No single event decides a destiny
The bite neither kills nor transforms: it **infects**, and infection is the first node of the tree. What comes after is choice, time, ritual and risk — with exit points (a cure is possible, expensive and humiliating). Without consent and without a process, a transformation does not complete.

### 14.3 Every roll is auditable
Inputs, result and seed in `audit_logs`. Hidden from the player, reproducible by staff. Without this, the system is indefensible in the first community conflict.

### 14.4 🔑 No soul is strictly better — the condition that solves everything
This is the council's main contribution, and it solves at the root the problem you raised ("being born better is not fun").

If high affinity only gives an advantage, there are good souls and bad souls, and birth is a lottery. **So high affinity has to charge a price** — which is literally Constitution §7:

| High affinity | Gain | Price |
|---|---|---|
| **Arcane** | learns cheaply, casts cleanly | ancient things notice who shines: more exposure to corruption and unwanted attention |
| **Divine** | protection, healing, religious authority | obligation — breaking a vow has a mechanical consequence, not just a social one |
| **Shadow** | forbidden power within reach | hunted; institutions react; the body pays |
| **Bestial** | strength, instinct, endurance | control is harder; the beast responds before you do |
| **High Will** | resists, sustains rituals | mechanical stubbornness: harder to be healed, convinced, saved |
| **High Stability** | does not go mad | less sensitive to the supernatural — does not see what the fragile see |

With this, **there is no good roll.** There is a *different* roll, each with its own way of going wrong. And the player who discovers their own soul discovers a problem, not a prize — which is exactly the Heavy RP tone.

## 15. How it integrates with the rest of the world

| Existing system | Link |
|---|---|
| Whitelist (`characters`, v5) | **It is the source of the seed** (§14.1) |
| `core/character-state.js` | The tree is a sibling state machine |
| `core/action-policy.js` | Corruption and transformation restrict actions through the path that already exists |
| `identity-service` | A discovered vampire = a revealed identity; connects to disguise |
| `governance-service` | Necromancy and vampirism are **classifiable crimes** — the hunt becomes a process, not a lynching |
| `death-service` | Permadeath is the succession trigger for a Noble House |
| `core/transaction-service` | All value generated by enchanting goes through here |
| Royal Chancery | The church, the hunt and the Noble House are institutions — the vampire's trial is a process with evidence |

---

# Part II — The solution: how this becomes good gameplay

Part I says what cannot be. This part says **what we do**, and the criterion is a single one: a player who joins today needs to have fun today.

## II.0 The four fun killers

Every hidden-soul system dies of one of these four things. The design below exists to kill all four.

| Killer | How it shows up | How we kill it |
|---|---|---|
| **The closed door** | "you can't do that" | The dice **never** say no. They say *how* it works out. §II.2 |
| **The wait** | "come back in two years" | Deadlines measured in **sessions**, not months. §II.4 |
| **The silence** | "nothing happens, try again" | Every result produces fiction. §II.2 |
| **The invisible** | "I don't know if this is working" | Diegetic signs from the first session. §II.1 |

## II.1 The soul has no numbers. It has signs.

Inside there are 8 values. **The player never interacts with any value** — they interact with *signs*, which arrive as happenings:

> *The flames obey you too quickly.*
> *Dogs growl when you pass, and you don't know why.*
> *You don't dream. You never have.*
> *The priest stares at you too long and says nothing.*

**Every character receives the first sign in the first session.** It is not power — it is identity. The player leaves the first session with something true about the character that nobody wrote on the sheet, and that **can already be roleplayed immediately**.

That solves the deadliest problem of an RP server, which is not balance: it is an empty first hour.

And it solves "indistinguishable from a bug" (§4.2 of Part I) from the right side — the player always receives something that reads as intentional, because it is.

## II.2 The dice never say no. They say which story you got.

**The system's golden rule:** every soul-related attempt produces one of these four results. **All four succeed.**

| Result | What happens | Who gets it most |
|---|---|---|
| **Clean** | Works, with no extra cost | high affinity |
| **Costly** | Works, but consumes more — component, time, exhaustion | middle ground |
| **Complicated** | Works **and something else happens** — a side effect that is a scene hook | low affinity |
| **Marked** | Works and **leaves a permanent mark** on the character | low affinity, an attempt that is too big |

There is never "failed, try again". There is "it worked, and now you have this".

**Example.** Two characters enchant the same blade.

- *João (high Arcane)* → **Clean.** Blade enchanted, beautiful, works. The end.
- *Pedro (low Arcane)* → **Marked.** The blade works — and it came out too cold, and the hand that forged it no longer warms up. Pedro now has a scar that other characters **see**, a blade with a name, and a story.

Who had more fun? That is the question that reorganizes the entire system.

## II.3 The hard road produces the better character — and the system makes that legible

This is the twist that stops "rolling low" from being a punishment.

> **Talent is faster. Stubbornness is more memorable.**

The talented mage is elegant and efficient. The mage who got there **without the gift** is covered in marks, has a reputation, and everyone on the server knows the price they paid. Both fantasies are desirable — and the second generates more story, which is Constitution §4.

**The marks are the progression.** There is no level. There is what stayed with you:

- A **visible** mark — other characters can see it, and that talks to `identity-service` (hiding a mark is a real reason for a hood).
- A **felt** mark — only you know, until someone notices.
- A **known** mark — it entered your reputation; an experienced priest recognizes what happened to you.

A person with many marks is obviously someone who went far. That is **narrative** status, not numeric — and it cannot be farmed, because each mark cost a scene.

## II.4 Deadlines in sessions, not months

| Milestone | When | Depends on affinity? |
|---|---|---|
| First sign | session 1 | no |
| First real capability | within ~5 sessions | **no** |
| Recognized competence | ~1 month of play | a little |
| Mastery | months | **yes**, more social than solitary |

**Nobody waits to start playing.** Affinity changes the top of the curve and the *flavor* of the path, never the entry.

## II.5 Affinity pushes you toward other people

Learning alone is where affinity weighs the most. **Learning with a master flattens the difference.**

This is deliberate and it is the system's best side effect: whoever rolled low has a **mechanical reason to seek people out** — and seeking people out is the central loop of Heavy RP. The system converts a hidden statistic into social life.

And it creates self-sustaining roles: whoever teaches becomes important without needing a staff role.

## II.6 The bite, redone — three paths instead of one die

Replaces the 70% death:

**Bite = infection. Always survivable. Always a choice.**

It opens a window (in-game days) in which the character feels the change and the player decides:

1. **Seek a cure** — expensive, humiliating, requires other people. A real cure, with a price.
2. **Hide it** — playable and tense: thirst, symptoms, people noticing.
3. **Accept it** — enters the tree.

Three playable branches from one event, against zero branches of "you died".

**And the rarity you wanted still exists — but in the right place.** The "1% perfect transformation" is not rolled on the bite: it is **earned** by what the character did during the infection. Whoever prepared, sought a master, obtained the ritual and resisted arrives stable. Whoever just let it happen becomes the hunted monster.

Earned rarity is worth more than drawn rarity — and nobody loses a months-old character because of a number.

## II.7 Discovering your own soul is content

The player never sees a number. But the **character** can discover their inclination, in fiction: a master who evaluates, a ritual, a seer, a dream after something big.

That turns "hidden information" into a **travel destination**. And it gives a function to characters who neither fight nor govern: reading souls is a profession.

## II.8 None of this requires staff

Signs, results, marks and tree progression are computed by the server from events that already exist (`audit_logs`, transactions, character state). Staff arbitrate conflict — they do not operate the system.

It is the Constitution §5 test, in Annex A.2: *if staff disappear for a week, does the world keep producing events?* Here, it does.

---

# Part III — Final specification

This part closes the design. The decisions below were made by the council out of technical or gameplay necessity and **change the original proposal** — each change says why.

## III.1 Seven values, not eight

The original proposal had eight. **We cut one and derived another**, because an extra knob is not depth — it is the impossibility of balancing and communicating.

**Four affinities** — which path is cheap:

| | Domain | Tree |
|---|---|---|
| **Arcane** | structured magic, enchanting, alteration | Alteration → Ritual → Archmage |
| **Divine** | blessing, healing, sacred authority | Blessings → Miracles → Saint |
| **Shadow** | necromancy, vampirism, pact | Vampirism → Necromancy → Vampire Lord |
| **Bestial** | lycanthropy, instinct, natural bond | Lycanthropy → Totems → Alpha → Ancestral Wolf |

**Three traits** — how you bear the cost:

| | What it does |
|---|---|
| **Will** | resists being changed: by corruption, by others, by persuasion |
| **Sensitivity** | perceives the supernatural — sees, hears, feels what is not there for others |
| **Stability** | keeps integrity under strain |

**Cut: "Corruption Resistance".** It overlapped with Will and Stability. It becomes a **derived value** — `resistance = f(Will, Stability)` — without taking up its own space. Fewer knobs, same expressiveness.

**The tension designed on purpose:** high Sensitivity + low Stability is the seer who is coming apart. High Stability + low Sensitivity is the one who never goes mad and never sees anything. Neither is better.

## III.2 Fixed budget — the mechanical guarantee that no soul is better

Condition §14.4 cannot depend on the goodwill of whoever writes content. It becomes a **generator constraint**:

- The four affinities share a **constant budget**.
- The three traits share **another constant budget**.

Consequence: high Arcane **forces** something else to be low. There is no complete soul, no empty soul, and "rolling well" stops meaning anything.

**Bands instead of numbers.** Internally 0–100; resolution uses five bands, and the distribution concentrates in the middle:

`Deaf · Weak · Common · Strong · Rare`

Nobody is nothing. Almost nobody is everything.

## III.3 The seed comes from the sheet

```
semente = HMAC(SEGREDO_SERVIDOR, character_id ‖ normalizar(motivations, weaknesses, social_ties))
```

The three fields **already exist** (migration v5). Same approved sheet → same soul, always. That kills reroll-farming and makes the whitelist application matter mechanically.

⚠️ **`SEGREDO_SERVIDOR` never leaves the server.** Without it, anyone can compute any character's soul from the public sheet — and the entire system stops being hidden.

## III.4 Resolution — how Clean, Costly, Complicated or Marked comes out

```
peso = banda(afinidade_relevante)
     + circunstância      // master present, right component, consecrated place, preparation
     − dificuldade        // of the attempted act
     − pressão            // see III.5
```

The `peso` (weight) shifts the distribution among the four results. **No `peso` value produces failure** — very low weights concentrate on Complicated and Marked, which are still successes with a story.

**Deterministic and auditable roll:**

```
resultado = f(semente_da_alma, id_do_evento, tentativa_n)
```

Writes to `audit_logs` (`soul:resolve`) the inputs, the `peso`, the result and the event seed. Hidden from the player; **reproducible by staff**. It is condition §14.3, and without it the system is indefensible in the first community conflict.

## III.5 Pressure — the anti-spam that is also fiction

Without this, the exploit is obvious: try a hundred times until Clean comes out.

Each attempt at the same act within a window **accumulates pressure**, which pushes the distribution toward Complicated and Marked. Insisting does not converge on a clean success — **it converges on marks**.

It is honest with the fiction: whoever forces the same thing many times ends up paying for it. And it is anti-exploit without needing to say "no".

## III.6 Marks

```sql
character_marks (
  id, character_id,
  kind,                     -- 'fisica' | 'espiritual' | 'social'
  visibility,               -- 'visivel' | 'sentida' | 'conhecida'
  descriptor,               -- text key; never free text from the player
  origin_event_id,          -- trail back to the audit_log that generated it
  created_at
)
```

- **`visivel`** (visible) — others see it. Talks to `identity-service`: hiding a mark is a real reason for a hood.
- **`sentida`** (felt) — only the bearer knows, until someone notices.
- **`conhecida`** (known) — it entered the reputation; whoever understands the subject recognizes it.

**A mark is never removed.** At most it is *covered* — which is also playable, and expensive.

## III.7 Signs

```sql
character_signs (id, character_id, sign_key, revealed_at, source)
```

The first is revealed at the **first spawn**, not by playtime — that is what guarantees the first session is not empty. The following ones arrive through events: something the character did, saw or suffered.

Delivered through the channel that **already exists**: the `panelData` property + `core/panel-refresh-bus.js`. No new infrastructure.

## III.8 The tree is a state machine, a sibling of `character-state`

```sql
character_paths (
  id, character_id,
  tree,                     -- 'arcana' | 'divina' | 'sombria' | 'bestial'
  node,                     -- current node
  entered_at, consented_at, -- explicit consent where it is irreversible
  metadata
)
```

**Separate from `core/character-state.js` on purpose.** That one handles immediate gameplay state (`NORMAL`/`DOWNED`/`IMPRISONED`), with a lifecycle of seconds. This one is a trajectory of months. Mixing the two would couple things with incompatible lifetimes — Constitution §13.

**`consented_at` is the implementation of condition §14.2:** an irreversible node does not advance without recorded consent. It is also the answer to Annex A.3 (warning before the irreversible).

## III.9 Event contract

Everything event-driven, **no polling** — we already have three services at 2 s and a Papyrus call costs 13–35 ms.

| Event emitted | Who consumes it |
|---|---|
| `soul.resolved` | marks, panel, audit |
| `soul.mark.created` | `identity-service` (if visible), panel |
| `soul.sign.revealed` | panel |
| `soul.path.advanced` | governance (classifiable crime), panel |
| `soul.infection.started` | panel, and opens the choice window |

`governance-service` listens to `soul.path.advanced` to classify necromancy and vampirism as **crimes** — which turns a hunt into a process, not a lynching.

## III.10 What the server cannot do, and the consequence

A real SkyMP limit, recorded before someone designs on top of it:

| Manifestation | Viable today? |
|---|---|
| Message, dream, voice, warning | ✅ directly |
| Animation, sound effect | ✅ Papyrus |
| Blocking an action (corruption, transformation) | ✅ `core/action-policy.js` |
| **Visible physical change** | ❌ **requires our own plugin** — a scriptless `.esm`, with FormIDs we control, logic in Node (the `MODS_AND_GAMEMODE_CONTRACT.md` §5 pattern) |

Until the plugin exists, a physical mark is **described**, not rendered. It works — Heavy RP lives on description — but it is a limitation to accept, not to hide.

## III.11 Module and flag

`soul-service.js`, registered in `core/module-registry.js`, `enabledBy: 'ENABLE_SOUL_SERVICE'`, phase `lab`, off by default. Dependencies: none in v1 (the governance integration comes later, via events).

## III.12 Mandatory tests before turning it on

Following `CONTRIBUTING.md` §6 — verify the **argument and the effect**, never just the return value:

1. **The fixed budget is respected** across 10,000 generated souls: no sum escapes the budget.
2. **The distribution concentrates in the middle**: `Common` is the most frequent band; `Rare` is truly rare.
3. **Determinism**: same sheet → same soul, across runs and across processes.
4. **Resolution never fails**: across 10,000 resolutions with the worst possible `peso`, zero results outside the four.
5. **Pressure pushes toward marks**, never toward Clean — the spam exploit test.
6. **An irreversible node refuses to advance without `consented_at`.**
7. **The seed does not leak**: no `panelData` payload contains an affinity number. This is the test that protects the entire system; write it first.
8. **A visible mark respects the identity firewall**: whoever does not know the bearer does not receive a descriptor that reveals their civil name.

## III.13 Verification — the domain exists and the numbers add up

The domain layer (`skymp/gamemode/core/soul.js`) **is already implemented and tested**, with 28 tests. It is a pure function: it opens no database, does not touch `mp`, has no side effects. That is why it does not depend on Phase 0 — what depends on it is the *service*, which talks to the world.

**Actual distribution** (20,000 souls, 80,000 affinities):

| Band | Frequency |
|---|---|
| deaf | 0.8 % |
| weak | 14.3 % |
| **common** | **68.6 %** |
| strong | 15.1 % |
| rare | 1.2 % |

Almost everyone is common in almost everything — which is what makes `rare` mean something. A character has a ~5 % chance of having *some* rare affinity.

### The number that validates the design

The question that decides whether the system is fair: **does preparation make up for birth?**

| Situation | clean | costly | complicated | marked |
|---|---|---|---|---|
| `deaf`, alone, hard act | 4 % | 27 % | 39 % | 30 % |
| **`deaf` with master + component + place** | **25 %** | **40 %** | **25 %** | **10 %** |
| **`rare`, alone, hard act** | **25 %** | **40 %** | **25 %** | **10 %** |
| `rare` with master + component + place | 76 % | 12 % | 10 % | 2 % |

**The two middle rows are identical.** Whoever was born with no gift at all, with a master and the right preparation, arrives exactly where the talented arrive alone.

That is §II.5 proven in numbers, not in promises: affinity does not close a door — it decides **how many people you will need**. Talent still matters (the talented who also prepare reach 76 %), but the giftless path goes through other people, which is the central loop of Heavy RP.

## III.14 Out of v1, deliberately

- **Hereditary noble lineage** — depends on the tree being proven and touches succession, which today is staff-authored.
- **Martial affinity** — combat belongs to the client; the server does not arbitrate blows. It comes in when there is a reliable path, not before.
- **Institutional soul detector** — the church **cannot** have a spiritual blood test. It would kill the mystery and the faith at once.

---

## Implementation proposal — in what order, and not now

**Absolute prerequisite: Phase 0** (in-game test). The project has not yet run a session. Building a soul system on top of an unvalidated gamemode is building in the dark.

After that, the order the council recommends — each stage delivers story on its own, none depends on the next to be worthwhile:

1. **`character_soul` + seed from the sheet + the first sign.** The soul exists, is auditable, and already delivers the session-1 sign (§II.1) — which depends on no heavy mechanic and on its own already improves the first hour of play. No mechanical effect yet: you can validate distribution and readability before any consequence.
2. **The four results (§II.2) in ONE thing only — enchanting.** Clean/Costly/Complicated/Marked, with the first marks. Small scope, measurable economy, the first real profession — and it validates the central mechanism of the entire system in a place where mistakes are cheap.
3. **Corruption**, tied to necromancy. This is where narrative manifestation (§10) and our own plugin come in.
4. **Transformation Tree**, starting with lycanthropy — simpler than vampirism, without clan politics.
5. **Vampirism**, last, because it is what touches politics, religion and grief the most.
6. **Noble lineage**, after the tree has proven it works.

**Never:** release stage 5 before 14.2 (consent and process) is implemented and tested.
