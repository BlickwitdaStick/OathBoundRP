/** Plain-language reason a Skyrim folder was refused, and what to do about it. */
export function describeGamePathProblem(reason?: string): string {
  switch (reason) {
    case 'empty':
      return 'Choose your Skyrim folder first: click Select Folder and pick the folder that contains SkyrimSE.exe (for Steam usually ...\\steamapps\\common\\Skyrim Special Edition).';
    case 'no-skyrim':
      return 'That folder has no SkyrimSE.exe. Pick the main Skyrim Special Edition folder (the one with SkyrimSE.exe and skse64_loader.exe), not its Data folder or the Steam folder.';
    case 'gog':
      return 'This looks like the GOG version of Skyrim. The server needs the Steam version 1.6.1170 with SKSE.';
    default:
      return reason ? `That Skyrim folder can't be used (${reason}).` : "That Skyrim folder can't be used.";
  }
}
