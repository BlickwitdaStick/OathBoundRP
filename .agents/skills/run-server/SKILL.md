---
name: run_skymp_server
description: Skill for starting and testing the local SkyMP server safely and autonomously, analyzing logs and checking the connection ports.
---

# SkyMP Server Startup and Test Instructions

Whenever the user asks to "test the server", "start the server" or "check whether the server is running", follow the steps below.

This assumes the from-scratch setup is already done (dependencies installed, database migrated, `.env` files filled in, Skyrim assets in `skymp/data/`, server artifact installed in `skymp/server/`). If any of these does not exist yet — for example `skymp/server/dist_back/skymp5-server.js` does not exist, or `skymp/data/*.esm` is missing — do not try to work around it: follow `docs/technical/FASE_0_SETUP_DO_ZERO.md` from the beginning, including the known-issues section.

1. **Make sure the local configuration exists:**
   If the local files do not exist in `skymp/config/`, run in the terminal:
   `.\scripts\phase0\Initialize-LocalConfig.ps1`

2. **Start the server in the background:**
   Run the start script with the command-line tool (`run_command`), either sending it to the background or running it for X seconds (so it does not block your ongoing execution):
   `.\scripts\phase0\Start-Phase0Server.ps1`
   If you only need to validate the boot (quick liveness test), run:
   `.\scripts\phase0\Start-Phase0Server.ps1 -Seconds 15`

3. **Analyze the output logs:**
   Look in the terminal output for these success strings:
   - "Using data dir"
   - "[phase0] SkyMP Heavy RP gamemode loaded"
   - "Server resources folder is listening on 3000"

4. **Check the connection:**
   Make sure the main UDP port `7777` is listed in the terminal output.

5. **Report:**
   At the end, always summarize for the user concisely whether the server came up successfully, which ports it opened and whether any critical error appeared in the output.
