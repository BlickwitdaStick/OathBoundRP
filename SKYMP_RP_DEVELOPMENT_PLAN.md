# SkyMP Heavy RP Public Server – Development Plan

> **Status: Historical — Original strategic vision from 08/11/2026.** The baseline of 547 tests originally described in this plan preserves the state of the project at that time and does not represent the current project. The current operational state and backlog have been superseded by [PRODUCTION_READINESS_ACTION_PLAN.md](docs/roadmap/PRODUCTION_READINESS_ACTION_PLAN.md): the August 24 snapshot includes **1,457 product tests**, including **1,233 gamemode tests**, migrations through **v28**, **76 tables**, zero occurrences from `check-write-guards --all`, clean launcher and gamemode typechecks, and **14/14 system checks**. The promotion decision remains **NO-GO**, as documented in [PRODUCTION_BLOCKERS_2026-08-24.md](docs/operations/PRODUCTION_BLOCKERS_2026-08-24.md). The content below has not been deleted or rewritten because it documents the original strategy and development sequence.

## 1. Vision

Create a public Skyrim Heavy RP server using SkyMP, with strict whitelist access, persistent characters, a controlled economy, staff tools, and a stable modlist managed through a launcher or guided installer.

The project must be treated as a living service and a moderated narrative world. The goal is not simply to run SkyMP, but to operate a serious roleplay environment with rules, moderation, persistence, deployment discipline, and player support.

## 2. Product Scope

### Target Experience

- Public Heavy RP server set in Skyrim.
- Access restricted through a strict whitelist.
- Persistent character progression.
- Names, histories, factions, professions, laws, and economy consistent with the lore.
- Staff-supervised events.
- Controlled modlist and client compatibility.
- Comprehensive logs and administrative audit trails.

### Heavy RP Principles

- Character actions must have plausible motivations within the world.
- Player knowledge and character knowledge are separate things.
- Consequences must persist.
- Staff must protect the integrity of the story before convenience.
- The economy and power progression must be slow enough to preserve roleplay.
- Combat must arise from storytelling, not casual deathmatch.
- Public communication must reinforce immersion, rules, and community standards.

### Initial Capacity Targets

- Closed Alpha: 5–10 players.
- Closed Beta: 20–40 players.
- Public Beta: 50–100 players.
- Scaling Phase: 100+ players only after obtaining real stability data.

## 3. Technical Stack

### Foundation

- SkyMP Server.
- Fixed Skyrim Special Edition / Anniversary Edition version.
- TypeScript for gameplay systems where supported by SkyMP/SkyrimPlatform.
- Windows Server for initial hosting.

### Persistence

- Native SkyMP world/player persistence: evaluate `file`, `zip`, `mongodb`, and `migration`.
- MongoDB recommended for native SkyMP state on a public server, provided testing confirms compatibility with the build being used.
- MariaDB / MySQL recommended for the RP platform: whitelist, accounts, approved characters, staff, external logs, RP economy, web panel, and VIP/Store system.
- Redis optional for queues, session caching, rate limiting, and temporary state.
- Automatic daily backups.
- Schema management through `.sql` files and migrations.

### Web Platform

- Web application for whitelist applications, rules, character profiles, staff panel, ban appeals, and server status.
- Recommended stack:
  - Backend: Node.js/NestJS or Fastify.
  - Frontend: Next.js or React.
  - Authentication: Discord OAuth.
  - Database: MariaDB / MySQL.

### Operations

- Git repository.
- Staging server before production.
- Structured logs.
- Error reporting.
- Uptime monitoring.
- Automated backup verification.

## 4. Repository Structure

Recommended monorepo layout:

```text
skymp-rp/
  apps/
    web/
    launcher/
    admin-panel/
  services/
    api/
    bot-discord/
    worker/
  skymp/
    server/
    gamemode/
    scripts/
    config/
    ui/
  packages/
    shared/
    database/
    rp-types/
  docs/
    rules/
    staff/
    technical/
    roadmap/
  infrastructure/
    docker/
    backups/
    monitoring/
```

## 5. Development Phases

## Phase 0 – Research and Feasibility

### Objective

Confirm the current SkyMP build, client requirements, hosting limitations, and scripting capabilities before investing in large systems.

### Tasks

- Download and run a current SkyMP server build.
- Confirm the supported Skyrim version.
- Confirm the client installation path.
- Confirm the ports being used: main UDP port, UI port, development server, and DevTools.
- Confirm `dataDir`, `loadOrder`, `archives`, `gamemodePath`, `startPoints`, and `databaseDriver`.
- Test the native `file` driver; evaluate `mongodb` for production.
- Test connections with two players.
- Test cell transitions, combat, movement synchronization, item collection, inventory, death, respawn, and basic interactions.
- Identify what can be scripted reliably.
- Document crashes and desynchronization cases.
- Compare behavior against the Red House reference and current SkyMP.
- Create/follow the technical checklist in `docs/technical/SKYMP_SERVER_SETUP.md`.
- Record `server-options` decisions in `docs/technical/SERVER_OPTIONS_SCHEMA.md`.

### Completion Criteria

- Server runs locally.
- At least two clients can connect.
- Known limitations are documented.
- A decision has been made regarding the Skyrim version and base modlist.
- A decision has been made regarding the native SkyMP persistence driver.
- A decision has been made regarding staging ports and firewall configuration.

## Phase 0.5 – Red House Laboratory

### Objective

Use Red House Public strictly as a controlled technical reference to understand server flow, chat, UI, spawning, server-options, and commands without turning its old build into the production foundation.

### Tasks

- Study the Red House structure: `client`, `front`, `server`, `server-build`, `modules`, `compiler`, and `docs`.
- Compare `server-settings.example.json` with current SkyMP.
- Extract ideas for proximity/cell-based chat.
- Extract ideas for spawning by profile ID, but adapt them for approved characters.
- Extract ideas from `server-options`, but remove password-based admin access and dangerous commands.
- Document discovered risks.

### Completion Criteria

- No Red House code becomes a production dependency without review.
- Useful findings are documented in `docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md`.
- Applicable decisions have been transferred into the project's own documentation.
- Unsafe risks have been explicitly blocked in the plan.

## Phase 1 – Private Technical Prototype

### Objective

Create a controlled RP sandbox with a persistence proof of concept.

### Systems

- Account identity.
- Character creation.
- Character spawning.
- Position persistence.
- Basic inventory persistence, if technically feasible.
- Basic administration with role-based permissions: teleport, kick, and ban.
- Server logs.

### Tasks

- Create the database schema for accounts and characters.
- Link player identities to Discord and Steam where possible.
- Implement the initial character registration process.
- Save/load character state.
- Add basic server configuration.
- Create the first set of staff commands.
- Require mandatory reasons and audit logs for staff commands.
- Write an operations runbook.

### Completion Criteria

- Five testers can repeatedly join.
- Characters persist between restarts.
- Staff can remove problematic players.
- Logs identify player and staff actions.
- No destructive command works without permission and logging.

## Phase 2 – Whitelist and Community Control

### Objective

Prevent random access and establish public server discipline before introducing complex RP systems.

### Systems

- Discord OAuth login.
- Whitelist application form.
- Staff review workflow.
- Approved, denied, banned, and appealed statuses.
- Discord role synchronization.
- Acceptance of server rules.

### Tasks

- Build the web whitelist workflow.
- Add a staff panel for reviewing applications.
- Create Discord bot integration.
- Add audit logs for staff decisions.
- Add server-side whitelist verification before allowing entry.
- Control spawning by approved character, not just profile ID.
- Publish rules and naming policies.

### Completion Criteria

- Only approved players can join.
- Only approved characters can spawn.
- Staff can approve/reject applications.
- All decisions are recorded.
- Players accept the rules before gaining access.

## Phase 3 – Roleplay Core

### Objective

Make the server feel like a roleplay world, not simply a synchronized Skyrim sandbox.

### Systems

- Character names.
- Character histories.
- Local chat.
- OOC chat.
- Staff chat.
- Emotes.
- Character descriptions.
- Death and respawn rules.
- Injury and recovery rules.
- Consent/escalation rules for serious consequences.
- Reports.
- Basic imprisonment/punishment workflow.

### Tasks

- Implement local IC, whisper, shout, OOC, staff, and report chat channels.
- Add proximity/visibility rules.
- Create `/me`, `/do`, `/ooc`, `/report`, and staff commands.
- Add biography fields and staff review.
- Add a report queue.
- Add death handling.
- Add injury states, if technically feasible.
- Create an administrative jail or containment area.
- Add moderation logs.

### Completion Criteria

- Players can roleplay without depending on Discord voice/text.
- Staff can handle in-game reports.
- Death and punishments can be enforced.
- Character identity and history can be reviewed by staff.
- Chat is recorded for moderation.
- IC chat uses distance and cell as minimum filters.

## Phase 4 – Economy MVP

### Objective

Introduce controlled money circulation and basic professions without creating inflation or exploits.

### Systems

- Persistent currency.
- Job payments.
- Shops.
- Item pricing.
- Salaries/payday.
- Transaction logs.

### Initial Professions

- Guard.
- Hunter.
- Miner.
- Blacksmith.
- Alchemist.
- Merchant.
- Healer.
- Rogue/criminal path only if sufficient staff is available.

### Tasks

- Create a money ledger.
- Implement a basic wallet/bank model.
- Create shop configuration.
- Implement server-side reward validation.
- Add transaction logs.
- Add admin tools for economy corrections.

### Completion Criteria

- Money cannot be created by the client.
- Every transaction is recorded.
- Staff can audit suspicious players.
- The economy can be reset or adjusted during the beta.

## Phase 5 – Factions and Law

### Objective

Add structured groups and conflict rules to support sustained roleplay.

### Systems

- Factions.
- Ranks.
- Permissions.
- Guard/law enforcement system.
- Criminal records.
- Warrants.
- Prison sentences.
- Faction storage, if feasible.

### Initial Factions

- Whiterun Guard.
- Scholars/mages associated with the College.
- Companions-style mercenaries.
- Merchants' Guild.
- Healers/temple.
- Criminal group introduced later, not at launch.

### Tasks

- Add faction membership tables.
- Add rank-based permissions.
- Create staff-controlled faction assignments.
- Create faction commands.
- Add criminal records and warrant workflows.
- Add prison release timers.

### Completion Criteria

- Factions can be managed without manually editing the database.
- Guard gameplay has enforceable rules.
- Crime and punishment are recorded.
- Staff can resolve abuse using evidence.

## Phase 6 – Properties and World Ownership

### Objective

Create long-term investments for players without destabilizing the world.

### Systems

- Houses.
- Rentals/ownership.
- Keys/access.
- Storage.
- Commercial locations.
- Optional fees or maintenance.

### Tasks

- Define property records.
- Create ownership records.
- Add access permissions.
- Add staff commands for assigning properties.
- Add business licenses.
- Add storage access logs.

### Completion Criteria

- Staff can assign/revoke properties.
- Player access persists.
- Storage does not duplicate items.
- Public rules explain property loss and inactivity.

## Phase 7 – Launcher and Modlist Control

### Objective

Reduce support requirements by making client installation predictable.

### Systems

- Launcher or installer.
- Modlist manifest.
- Version checking.
- File integrity checking.
- Update workflow.
- News/changelog.
- Incompatible client blocking before login/spawn.
- Published licensing and non-affiliation policy.

### Tasks

- Define the legal policy for mod redistribution.
- Follow `docs/technical/LICENSE_AND_AFFILIATION_POLICY.md`.
- Use only mods with permission, or require players to download them themselves when necessary.
- Create a manifest format.
- Build a launcher prototype.
- Add installation/update verification.
- Add compatibility checks against the server.

### Completion Criteria

- New players can install without manually hunting for files.
- The server rejects incompatible builds.
- Staff can publish modlist updates.
- Mod permissions are documented.
- A non-affiliation notice is published on the website/launcher/Discord where applicable.

## Phase 8 – Public Beta

### Objective

Open the server to a controlled audience with good observability and a rollback plan.

### Requirements

- Active whitelist.
- Published rules.
- Trained staff.
- Automated backups.
- Active crash reporting.
- Active Discord support channels.
- Documented list of known exploits.
- Published economy reset policy.
- `offlineMode`, hot reload, and DevTools disabled in production.
- Production ports reviewed and documented.

### Completion Criteria

- 50–100 approved players can play during scheduled sessions.
- Staff can handle reports.
- Critical issues are triaged within 24 hours.
- Server state can be restored from backup.

## Phase 9 – Live Operations

### Objective

Run the project sustainably.

### Weekly Work

- Review bugs.
- Review economy logs.
- Review moderation logs.
- Fix scripts.
- Publish changelogs.
- Hold staff meetings.
- Review whitelist quality.
- Test backup restoration.

### Monthly Work

- Balance the economy.
- Audit staff actions.
- Review faction health.
- Review player retention.
- Update the roadmap.
- Conduct stress tests.

## 6. Initial Database Model

### Main Tables

- `accounts`
- `discord_identities`
- `steam_identities`
- `whitelist_applications`
- `characters`
- `character_positions`
- `character_inventory`
- `wallets`
- `transactions`
- `factions`
- `faction_members`
- `properties`
- `property_access`
- `reports`
- `punishments`
- `audit_logs`
- `server_sessions`
- `staff_command_audit`
- `character_spawn_approvals`
- `modlist_versions`
- `client_integrity_checks`

### Important Rules

- Currency changes must use ledger-style transactions.
- Staff actions must generate audit logs.
- Ban records must be separate from whitelist status.
- Character deletion should be a soft delete by default.
- Inventory writes should be idempotent whenever possible.
- Native SkyMP state and RP platform state must have separate backups.
- Staff commands must record role, target, reason, environment, and result.

## 7. Staff Roles

### Owner

- Final authority.
- Infrastructure access.
- Financial control.
- Approval of emergency rollbacks.

### Lead Developer

- SkyMP scripts.
- Web platform.
- Database migrations.
- Release process.

### Server Administrator

- Staff management.
- Rule enforcement.
- Ban appeals.
- Event approval.

### Moderator

- Reports.
- Chat rule enforcement.
- Player disputes.
- Basic punishments.

### Helper

- Onboarding.
- Installation support.
- Whitelist support.
- No destructive permissions.

## 8. Public Rules Required Before Launch

- Public rules document: `docs/rules/HEAVY_RP_RULES.md`.
- Consolidated public rules outline: `docs/rules/PUBLIC_RULES_LAUNCH_OUTLINE.md`.
- Phase 0 test evidence: `docs/roadmap/PHASE_0_TEST_LOG.md`.
- Character application template: `docs/rules/CHARACTER_APPLICATION_TEMPLATE.md`.
- Staff whitelist rubric: `docs/staff/WHITELIST_RUBRIC.md`.
- Technical reference study: `docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md`.
- SkyMP setup checklist: `docs/technical/SKYMP_SERVER_SETUP.md`.
- Server-options schema: `docs/technical/SERVER_OPTIONS_SCHEMA.md`.
- Licensing and non-affiliation policy: `docs/technical/LICENSE_AND_AFFILIATION_POLICY.md`.
- Technical NPC policy decision: `docs/technical/NPC_POLICY_DECISION.md`.
- Naming policy.
- Character history policy.
- Heavy RP standards.
- Prohibition of fail RP.
- Prohibition of metagaming.
- Prohibition of powergaming.
- Prohibition of random deathmatch.
- Prohibition of combat baiting.
- Prohibition of unrealistic escalation.
- Prohibition of exploiting bugs.
- Prohibition of item duplication.
- Prohibition of harassment.
- Voice/chat rules.
- Death rules.
- Injury rules.
- New life/memory rules.
- Combat initiation rules.
- Hostage, torture, and permanent consequence rules.
- Crime rules.
- Appeals process for staff decisions.
- Mod/client tampering policy.
- Ban policy.

## 8.1 Heavy RP Design Rules

### Whitelist Standards

- The whitelist must test RP maturity, not just memorization of rules.
- Applications must require a character concept, motivations, weaknesses, and social connections.
- Candidates must explain metagaming, powergaming, fail RP, and escalation.
- Staff must reject characters that are too powerful, too vague, or created solely for combat.

### Character Standards

- Characters need plausible names, histories, goals, flaws, and limitations.
- Nobles, powerful mages, assassins, vampires, werewolves, Daedra-affiliated characters, and faction leaders require staff approval.
- Characters must not start as legendary heroes.
- Progression must happen in-game, not in the application text.

### Death and Consequences

- Death must not be casual.
- Permanent death must require strict rules, staff review, or player consent, depending on the situation.
- Injury, capture, imprisonment, reputation damage, debt, and exile should be used before deleting a character.
- Respawn rules must prevent revenge killing and memory abuse.

### Economy Standards

- The economy must support RP scenes, not farming loops.
- Jobs should create interaction between players.
- Valuable items must require history, crafting, faction access, or an approved event.
- Rapid money generation must be treated as a design bug.

### Staff Standards

- Staff must be trained in Heavy RP enforcement.
- Staff characters must follow conflict-of-interest rules.
- Staff commands must be logged.
- Serious punishments must have evidence and review notes.
- Event staff must create situations, not force outcomes.

## 9. Security and Abuse Risks

### High Risk

- Client-side item spawning.
- Currency manipulation.
- Duplication caused by crashes or desynchronization.
- Unauthorized mod files.
- Staff abuse.
- Simple-password administrator access.
- Destructive commands without auditing.
- `offlineMode` enabled in production.
- Hot reload enabled in production.
- Database corruption.
- Legal problems involving mod redistribution.

### Mitigations

- Server-authoritative economy.
- Ledger-based logs.
- File integrity checks.
- Staff audit trails.
- Limited staff permissions.
- Authentication through external identity and roles, not shared passwords.
- Blocking destructive commands outside staging/authorized events.
- Frequent backups.
- Staging environment.
- Explicit tracking of mod permissions.
- Compliance with SkyMP GPL/AGPL licenses and individual mod licenses.

## 10. Release Process

### Environments

- Local development.
- Staging server.
- Production server.

### Release Steps

1. Merge code into the release branch.
2. Run migrations in staging.
3. Perform a staff smoke test.
4. Package client/server changes.
5. Publish the changelog.
6. Back up production.
7. Deploy to production.
8. Monitor logs for at least 60 minutes.

## 11. First 30-Day Roadmap

### Week 1

- Run the SkyMP server locally.
- Validate connections with two players.
- Document client setup.
- Choose the Skyrim version.
- Create the repository structure.
- Create a checklist for ports, `dataDir`, Skyrim masters, and scripts.
- Decide on the initial SkyMP persistence driver.
- Run the Red House laboratory strictly as a reference.

### Week 2

- Add the database.
- Implement the account/character proof of concept.
- Add basic staff commands.
- Add staff command auditing.
- Begin the rules document.

### Week 3

- Build the whitelist web MVP.
- Add Discord OAuth.
- Add the staff review workflow.
- Add whitelist enforcement on the server.

### Week 4

- Add local/OOC/staff chat.
- Add proximity/cell-based chat.
- Add reports.
- Add moderation logs.
- Run a closed test with 5–10 players.

## 12. MVP Backlog

### Required

- Server starts reliably.
- Client installation guide.
- Whitelist.
- Persistent character identity.
- Staff commands.
- Local chat.
- Proximity/cell-based chat.
- Reports.
- Logs.
- Backups.
- Rules.
- Heavy RP whitelist rubric.
- Character history review.

### Should Have

- Economy MVP.
- Professions MVP.
- Factions MVP.
- Discord role synchronization.
- Launcher prototype.
- Custom server-options validated by environment.
- Licensing and non-affiliation policy.
- Initial technical NPC decision.

### Could Have

- Properties.
- Businesses.
- Event dashboard.
- Public character profiles.
- Public server status.

### Outside the MVP

- Huge modpack.
- Complex criminal economy.
- Player-controlled governments.
- Large-scale wars.
- Complete launcher with auto-patching.
- Aggressive monetization (the basic VIP/Store system was brought forward into the MVP).

## 13. Key Decisions

- Server language: Portuguese, English, or bilingual.
- Level of strictness regarding lore.
- Level of Heavy RP strictness.
- Whether character histories require approval before the first login.
- Player target for the first public beta.
- **Voice chat is not mandatory — finalized on 08/07/2026.** Native proximity voice (`/voz`, `voip-service.js`) is **optional, in the `lab` phase, Post-Alpha**: it is not a launch prerequisite, and nothing in the critical path depends on it. Voice for Alpha and Closed Beta will use **temporary Discord voice channels** (`apps/bot-discord/voiceChannels.js`, `/voz-criar`, and `/voz-fechar`) — which already work.
  - **Why:** The client patch that enables microphone access in CEF has never been compiled or validated, and it was submitted to SkyMP upstream three times without ever being merged. All three PRs were automatically closed by their author, without maintainer review, which constitutes abandonment rather than a technical decision. Rebuilding it would require a fork and continuous maintenance of a C++ client, a cost that is not justified before Phase 0 or Alpha. See [`VOICE_CLIENT_PATCH.md`](docs/technical/VOICE_CLIENT_PATCH.md) and the "Do Not Do" section of [`QA_REPORT_2026-08.md`](docs/technical/QA_REPORT_2026-08.md).
  - **This can be revisited.** If upstream merges an equivalent patch, or someone validates the compilation in a Windows/Visual Studio/vcpkg environment, the server side is already ready: `voip-service.js` has WebRTC signaling, single-use tickets, and distance-based volume, all covered by tests. Reversing this decision would mean unlocking an existing component, not rewriting it.
- Whether permanent death exists at launch.
- Whether the launcher is mandatory before the public beta.
- Which mods are permitted and legally redistributable.
- Whether NPCs remain, are reduced, or are replaced by player roles.
- Initial recommended decision: selective vanilla spawning for the MVP.
- Whether the economy will be reset after the beta.
- Whether SkyMP state will use `file` for the MVP and `mongodb` in production.
- How to comply with source-code publication/modification requirements imposed by SkyMP licenses.

## 14. Immediate Next Step

> Rewritten on 08/07/2026. The previous version pointed toward **Housing** or "refining combat/physics" and was written before `hit-events`, `espm`, `safe-zones`, `core/soul.js`, and the first actual server boot existed. Housing remains PARKED by recorded decision, and combat is client-side — the server does not arbitrate hits.

**The next step is not a feature. It is connecting a client.**

Nothing in this project has been validated in a real session. The server first started on 08/06/2026 and the gamemode loaded, but **nobody joined**. Tests use a mocked `mp`, and mocks accept anything — that is how 22 Papyrus calls with incorrect arguments passed months of green test suites.

There are currently **eight systems** carrying the same warning — *confirmed by automated testing, not confirmed in a real session*. There were four when this section was written on 08/07; voice (fallback and native), identity persistence, and the nametag with `/revelaridentidade` were added afterward.

The list is in the single index in [`docs/technical/FASE_0_ROTEIRO.md`](docs/technical/FASE_0_ROTEIRO.md), which consolidated it because the same systems were scattered across three documents. **This section does not repeat the list**: while it was being repeated, it silently became outdated — exactly the problem that the index exists to prevent.

The roadmap is ready and **has not been executed**. It requires three people, two clients, and one server — nothing a coding agent can do alone.

**What Phase 0 unlocks**, and why it must come before any new feature:

- Remove `checkDamageSpike` from `death-service` (the heuristic can only be removed once the hit event is proven to arrive).
- Remove polling from `death-service`, if `mp.onDeath` fires as expected.
- Remove `/internal/session/resolve`, if the master API confirms it is no longer necessary.
- Unlock **Stage 2 of Soul Affinity** — the four enchantment outcomes, which are the first point where the soul produces a mechanical consequence.

**After Phase 0**, and not before, the order already supported by the rest of the documentation is:

1. **Stage 2 of `soul-service`** (`docs/design/SOUL_AFFINITY.md`, "Implementation Proposal"). Small scope, measurable economy, first real profession — and it validates the system's central mechanic in an area where mistakes are inexpensive. This depends on removing `crafting-service` from PARKED, which has already been migrated to `transaction-service` and is ready for this discussion.
2. **Phase 1 — Identity and Emotes**, already mapped out in `REFERENCE_STUDY_SKYMP_RED_HOUSE.md`.
3. **Housing / Properties**, if and when the decision to reactivate it is made — `housing-service.js` has been migrated and parked, and reactivation is a scope decision, not a security decision (see [`PARKED_SERVICES_DECISION.md`](docs/technical/PARKED_SERVICES_DECISION.md)).

The current technical milestone remains:

```text
Milestone 0.1 - SkyMP Connection Test
- Server running                 [completed on 08/06/2026]
- Two clients connected          [PENDING — this is what blocks everything else]
- Version documented
- Base modlist documented
- Crash/desync notes documented
- Decision: continue, fix, or change approach
```