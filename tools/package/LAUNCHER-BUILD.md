# Building the OATHBOUND launcher for the VPS

The server address is built into the launcher, so it is rebuilt whenever the
server moves. Do this on any Windows PC (not necessarily the VPS) once the
VPS is running. `<ADDRESS>` is the VPS's public IP or domain.

## 1. Install

- **Node.js 24** (x64), from nodejs.org.
- Unzip this archive into a folder, for example `C:\OATHBOUND-Launcher-Source\`
  (the zip has no top folder of its own, so `apps\launcher\` lands directly in it).

## 2. Set the address

Edit `apps\launcher\.env`:

| Setting | Set to |
|---------|--------|
| `VITE_SERVER_IP` | `<ADDRESS>` (no `http://`, no port) |
| `VITE_PANEL_URL` | `http://<ADDRESS>:3001` |

Leave the rest: `VITE_SERVER_PORT=7777`, `VITE_API_PORT=7758`,
`VITE_DISCORD_CLIENT_ID`, and `VITE_DISCORD_REDIRECT_URI=http://localhost:19847/callback`
(that is the player's own PC, on purpose).

Everything in this file ends up inside the installer, where any player can
read it. That is fine for these values; never put a secret here.

Optionally, set `"version"` in `apps\launcher\package.json` (it is `0.0.0`)
so players can tell builds apart, e.g. `0.2.0`.

## 3. Build

PowerShell, in `apps\launcher\`:

```powershell
npm ci
npm run build
```

The installer is written to `apps\launcher\dist-electron\`
(`OATHBOUND RP Launcher Setup <version>.exe`). "voice-helper.exe not found"
is only a warning: voice chat is optional and off on this server.

## 4. Hand it out

Upload the installer (for example to the GitHub release) and have players
install it over the old one. Old launchers keep pointing at the owner's PC.
