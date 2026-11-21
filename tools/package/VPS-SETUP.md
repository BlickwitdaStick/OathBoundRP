# OATHBOUND server on a Windows Server VPS

This archive is the whole server as it ran on the owner's PC: the patched
SkyMP server, its plugins, the saved world, the gamemode, the web panel, the
game API (which the launcher talks to and downloads mods from), the Discord
bot, the player mods, and a dump of the database.

**It contains secrets** (the `.env` files, the database password, the SkyMP
master key, the Discord app secret). Keep it private.

Below, `<ADDRESS>` means the VPS's public IP address or domain name, as
players will type it (for example `203.0.113.10` or `play.example.com`).

## 1. Install

1. **Node.js 24** (x64), from nodejs.org. Tick "Add to PATH".
2. **Microsoft Visual C++ Redistributable 2015-2022 x64**
   (`vc_redist.x64.exe` from Microsoft). The SkyMP server's native module
   needs it.
3. **MariaDB** (11.x or newer), as a Windows service. Remember the root
   password you choose.
4. Unzip this archive into a folder with a short path, for example
   `C:\OATHBOUND-Server\`, so that `C:\OATHBOUND-Server\skymp\server\` exists (the zip has no top folder of its
   own). Below, paths are relative to that folder.

## 2. Database

Open "MariaDB Command Prompt" (or `cmd` in MariaDB's `bin` folder):

```
mariadb -u root -p
```

Then, with the password from `skymp\config\database.local.json` (field
`password`):

```sql
CREATE USER 'oathbound_app'@'localhost' IDENTIFIED BY 'the password from database.local.json';
GRANT ALL PRIVILEGES ON skymp_rp.* TO 'oathbound_app'@'localhost';
FLUSH PRIVILEGES;
exit
```

Load the data (creates the `skymp_rp` database with every account,
character, hold and gold balance):

```
mariadb -u root -p < database\skymp_rp.sql
```

If you pick a different password or user, change it in all four places:
`skymp\config\database.local.json`, and `DB_USER` / `DB_PASS` in
`apps\web\.env`, `apps\game-api\.env` (and `apps\bot-discord\.env` if it has
them).

## 3. Change the addresses

The server listens on every network interface already; these are the
settings that still name the owner's PC (`127.0.0.1` / `localhost`):

| File | Setting | Set to |
|------|---------|--------|
| `apps\web\.env` | `PANEL_PUBLIC_URL` | `http://<ADDRESS>:3001` |
| `apps\web\.env` | `DISCORD_CALLBACK_URL` (keep only one line) | `http://<ADDRESS>:3001/api/auth/discord/callback` |
| `apps\web\.env` | `NODE_ENV` | `production` once it works |

Leave these as they are, they are correct on the VPS too:

- `skymp\server\server-settings.json` `"master": "http://127.0.0.1:3001"` (the
  game server talks to the panel on the same machine);
- `LAUNCHER_REDIRECT_URIS` and `BOT_INTERNAL_URL` in `apps\web\.env`
  (`localhost` there means the player's own PC, or this machine);
- `DB_HOST=127.0.0.1` everywhere.

**Discord:** in the Discord Developer Portal → your application → OAuth2 →
Redirects, add `http://<ADDRESS>:3001/api/auth/discord/callback` (keep the old
one until the move is done). Without it, logging in through Discord fails.

## 4. Open the firewall

In Windows Defender Firewall (inbound rules), and in the VPS provider's own
firewall if it has one:

| Port | Protocol | What |
|------|----------|------|
| 7777 | UDP | game server (players connect here) |
| 3000 | TCP | game server's UI files (chat, panels) |
| 3001 | TCP | web panel, login, Discord sign-in |
| 7758 | TCP | game API: launcher queue and mod downloads |

PowerShell (as Administrator):

```powershell
New-NetFirewallRule -DisplayName "OATHBOUND game" -Direction Inbound -Protocol UDP -LocalPort 7777 -Action Allow
New-NetFirewallRule -DisplayName "OATHBOUND web" -Direction Inbound -Protocol TCP -LocalPort 3000,3001,7758 -Action Allow
```

## 5. Start

PowerShell, in that folder:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\scripts\phase0\Start-AllServices.ps1
```

That starts the web panel, the game API (which first checks the player mods
in `skymp\client-mods`, about 15 GB, which takes a few minutes the first
time) and the Discord bot, and then the game server, each in its own window.
Leave the windows open. Clicking inside the game server window no longer
freezes it.

To restart only the game server: close its window, then
`.\scripts\phase0\Start-Phase0Server.ps1`.

## 6. Check

- `http://<ADDRESS>:3001` opens the panel from another PC.
- `http://<ADDRESS>:7758/health` answers.
- The game server window ends its boot with
  `Boot concluído: 19 ativos, 10 desativados, 0 com falha` (19 modules on).
- Then build the launcher with the new address (the second archive,
  `LAUNCHER-BUILD.md`) and connect.

## Notes

- `skymp\world\` is the saved world (where players stand, spawned holdstones).
  Back it up with the database.
- Adding mods works as before: put them in `skymp\client-mods\`, restart the
  server; the start script updates the load order and what the launcher sends.
- The database dump was taken while packaging; anything that changes on the
  owner's PC after that is not in it.
