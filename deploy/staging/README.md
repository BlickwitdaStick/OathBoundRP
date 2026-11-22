# Reproducible staging

This stack runs MariaDB, the panel, the Game API and the bot in containers. SkyMP
and the launcher stay on the Windows host: the pinned server artifact and Skyrim
are native, so they do not belong in the Linux container.

## Setup

1. Start Docker Desktop.
2. Copy `.env.example` to `.env` and replace **every** placeholder.
3. Confirm that `apps/game-api/mods.json` matches the server's `Data` folder.
4. On first use, run:

```powershell
.\deploy\staging\Start-Staging.ps1 -BootstrapDatabase
```

On later runs, do not repeat the bootstrap:

```powershell
.\deploy\staging\Start-Staging.ps1
```

To also start SkyMP on the host:

```powershell
.\deploy\staging\Start-Staging.ps1 -StartSkyMP
```

The panel is at `127.0.0.1:3001`, the Game API at `127.0.0.1:7758` and MariaDB
at `127.0.0.1:3306` (ports adjustable in `.env`). The bot port is not
published; the panel and the bot talk over the compose private network.

## Verification

```powershell
docker compose --env-file deploy/staging/.env -f deploy/staging/compose.yaml ps
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:7758/health
```

Every container must show as `healthy`. The Game API stays `unhealthy` if the
mods manifest is missing/invalid — intentional fail-closed behavior.

After the bootstrap, point `skymp/config/database.local.json` at the published
port and run `npm run check:schema` in `skymp/gamemode`.

## Shutdown

```powershell
.\deploy\staging\Stop-Staging.ps1
```

The database volume is preserved. `-RemoveVolumes` requires a typed
confirmation and is destructive; use it only to recreate a throwaway staging.

## Backup and restore

```powershell
.\deploy\staging\Backup-Staging.ps1
.\deploy\staging\Restore-Staging.ps1 -BackupFile .\deploy\staging\backups\skymp-staging-YYYYmmdd-HHMMSS.sql.gz
```

The backup uses a consistent transaction, includes the database/routines/events/triggers,
is compressed inside the container and gets a SHA-256 on the host. The restore only
accepts files from the `backups` directory, checks the hash, requires confirmation,
stops the consumers, restores, and runs the schema drift check in strict mode before
bringing the services back up.
