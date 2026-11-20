# OATHBOUND — setting up a second developer machine

Everything that is code lives on GitHub. Three things deliberately do **not**,
and have to be passed along privately:

| What | Why it is not on GitHub | How to get it |
|---|---|---|
| `.env` files and secrets (`SOUL_SECRET`, `SESSION_SECRET`, `INTERNAL_API_SECRET`, Discord keys, DB password) | The repo is public | Ask the server owner to send them over a private channel. Never commit them. |
| Server-hosted mods (`skymp/client-mods/`, about 11 GB) | Third-party mods, authors' licenses | You don't need them to *play*: the launcher downloads them from the server. To *host* a test server yourself, get a copy of the folder (cloud drive) and drop it into `skymp/client-mods/`. |
| Patched SkyMP binaries (server + client) | Build output | `OATHBOUND-patched-skymp.zip` from the server owner, or build them yourself (below). |

## 1. Get the code

```powershell
git clone https://github.com/BlickwitdaStick/OathBoundRP.git
cd OathBoundRP
git checkout oathbound-rebuild
```

Work on your own branch and open pull requests into `oathbound-rebuild`, so two
people never push over each other.

## 2. Tools

- Node.js 20+ and npm
- MySQL/MariaDB on `127.0.0.1:3306` (database `skymp_rp`; see `skymp/config/database.local.example.json`)
- Skyrim Special Edition (1.6.1170) with SKSE, Address Library
- Only to build SkyMP yourself: Visual Studio 2022/2026 with C++, CMake 3.28+, yarn 1.x

Then install dependencies:

```powershell
cd apps\web; npm install; cd ..\game-api; npm install; cd ..\launcher; npm install; cd ..\bot-discord; npm install; cd ..\..\skymp\gamemode; npm install
```

## 3. Config and secrets

```powershell
powershell -ExecutionPolicy Bypass -File scripts\phase0\Initialize-LocalConfig.ps1
```

Copy every `.env.example` to `.env` (`apps/web`, `apps/game-api`, `apps/bot-discord`,
`apps/launcher`, `skymp/gamemode`) and fill in the values you were sent.
The modules turned on in the main server are the `ENABLE_*` flags set to `true`
in `skymp/gamemode/.env` (death, governance, player panel, soul, nametag,
profession, environment, interaction framework/prompt, trade, depot, crafting,
player shortcuts).

Create `skymp/config/client-mods.local.json` (not committed):

```json
{
  "baseGameDataDir": "C:/path/to/Skyrim Special Edition/Data",
  "serverSupportsLightPlugins": true
}
```

## 4. Patched SkyMP (ESL / light plugin support)

Stock SkyMP cannot load `.esl` plugins, and USSEP / COTN need them. We run
SkyMP at the pin in `patches/manifest.json` plus `patches/skymp/light-plugins.patch`.

**From the shared zip** (unpack it first):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\skymp-build\Install-PatchedSkyMP.ps1 -DistDir C:\path\to\OATHBOUND-patched-skymp -SkyrimDir "C:\path\to\Skyrim Special Edition"
```

**Or build it** (first build: an hour or more):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\skymp-build\Build-PatchedSkyMP.ps1
powershell -ExecutionPolicy Bypass -File scripts\skymp-build\Install-PatchedSkyMP.ps1 -SkyrimDir "C:\path\to\Skyrim Special Edition"
```

The installer backs up every file it replaces and never writes
`skymp5-client-settings.txt`.

**Do not run** `scripts/phase0/Install-SkyMPServerArtifact.ps1` or
`Install-SkyMPClient.ps1` afterwards: they put stock SkyMP back (and the client
one turns on offline mode), and the server will then refuse the `.esl` load order.

## 5. Run

```powershell
powershell -ExecutionPolicy Bypass -File scripts\phase0\Start-AllServices.ps1
```

This syncs `skymp/client-mods` into the server load order, then starts the web
panel/master (3001), game API and the game server (UDP 7777). A healthy boot logs
`Load order: N full plugins and M light plugins`.

Play through the OATHBOUND launcher (`apps/launcher`, `npm run dev`); it signs
you in, downloads the server's mods and starts the game. Do not enable offline
mode or auto-connect.

## 6. Tests

```powershell
cd apps\game-api; npm test
cd ..\launcher; npm test
cd ..\..\skymp\gamemode; npm test
node patches\validate.js
```
