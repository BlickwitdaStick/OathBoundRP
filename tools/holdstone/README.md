# Holdstone model

![Holdstone preview](preview.png)

The in-game holdstone: a hewn monolith on a two-step Nordic plinth, with
glowing icy-blue runes on its front and back. About 2.9 m tall, 2.1 m across
the plinth, with collision.

`dist/` holds the finished files, laid out the way they go into Skyrim's
`Data/` folder:

| File | What it is |
|------|------------|
| `OathboundHoldstone.esp` | ESL-flagged plugin, one activator: `OBHoldstone` "Holdstone" (`800:OathboundHoldstone.esp`) |
| `meshes/oathbound/holdstone.nif` | the model |
| `textures/oathbound/holdstone/*.dds` | rune colour, glow and normal maps |

The stone and plinth use vanilla Windhelm stone textures, so players need
nothing extra for those.

## In game

`/holdstone spawn <hold>` places one in front of you and binds it to the hold
(see `docs/gameplay/HOLDSTONES_AND_PARCELS.md`). Pressing **E** on it opens the
hold menu. The activator has no Papyrus script: the server catches the
activation (`holdstone-service.js`).

To place stones by hand in the Creation Kit instead, load
`OathboundHoldstone.esp`, find `OBHoldstone` under Activators, drop it in the
world, and bind it in game with `/holdstone place <hold>` + **E**. A stone
placed this way must be saved in a plugin that every player loads.

## Rebuilding

```
node tools/holdstone/build.js             # build into dist/
node tools/holdstone/build.js --install   # build, then copy into skymp/client-mods/
```

Needs Blender 5.x with the PyNifly add-on, and the Skyrim SE `Data/` folder
(read only: two vanilla NIFs and the stone textures are read from its BSAs).
Override paths with `BLENDER` and `SKYRIM_DATA`. After `--install`, restart
the server so the launcher publishes it.

| Script | Step |
|--------|------|
| `bsa.js` | lists and extracts files from SSE BSAs |
| `make_dds.js` | writes the rune textures |
| `build_holdstone.py` | Blender: builds the geometry, collision and materials, exports the NIF, renders `preview.png` |
| `set_glow.js` | sets the rune's glow colour (PyNifly exports it black) |
| `build-plugin.js` | writes the plugin |
| `check_nif.py` | prints shaders, textures and collision of a NIF, to check the result |

The shape is in `build_holdstone.py`: plinth sizes, the monolith's taper
(`Z0`, `Z1`, `HX0`…), and the rune strokes (`STROKES`, as x/z pairs on the
front face).
