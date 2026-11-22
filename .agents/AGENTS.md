# Global Project Rules: SkyMP Heavy RP

These rules must be followed strictly when working on this project:

1. **Project Context:** 
   - This is a public **Skyrim Heavy RP** server, built on the **SkyMP** framework.
   - The project keeps a strict separation between the RP platform (web panel, whitelist, store) and native in-game state (positions, world).

2. **Database (CRITICAL):**
   - The project's official relational database is **MariaDB / MySQL**. 
   - **NEVER** suggest, migrate to or create schemas for PostgreSQL.
   - All backend code talks to the database through the `mysql2/promise` library.

3. **Architecture and Code:**
   - The main gamemode code lives in `skymp/gamemode/`.
   - Changes to the database structure require updating the migration file in `skymp/packages/database/schema.sql`.

4. **Product and Game Design Rules:**
   - The server is focused on Strict RP (Heavy RP). Actions must have plausible in-game motivations.
   - Progression and economy systems must be intentionally slow.
   - The monetization system (VIP/Supporter) exists to keep the server running, but aggressive Pay-to-Win mechanics are forbidden by design.

5. **Test Management and Technical Setup:**
   - For local tests, always assume `offlineMode=true` on the server artifact, allowing the use of `profileId`. In production this is strictly forbidden.
   - Setup, client install and server boot scripts must always use the PowerShell scripts in the `scripts/phase0/` folder.
   - Setup from scratch (dependencies, database, `.env`, Skyrim assets, server artifact, Discord, troubleshooting) is documented in `docs/technical/FASE_0_SETUP_DO_ZERO.md`. Before guiding anyone (human or agent) through a from-scratch boot, follow that guide instead of reconstructing the steps yourself.
