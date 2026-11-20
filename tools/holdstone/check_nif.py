import sys, addon_utils
addon_utils.enable("io_scene_nifly", default_set=True)
from io_scene_nifly.pyn.pynifly import NifFile
for path in sys.argv[sys.argv.index("--") + 1:]:
    nif = NifFile(path)
    print("FILE", path.split("\\")[-1], "root", nif.rootNode.name, nif.rootNode.blockname)
    for s in nif.shapes:
        p = s.shader.properties
        print("  SHAPE", s.name, "verts", len(s.verts), "tris", len(s.tris),
              "shaderType", p.Shader_Type, "f1", hex(p.Shader_Flags_1), "f2", hex(p.Shader_Flags_2),
              "emissive", [round(c, 2) for c in p.Emissive_Color], "mult", round(p.Emissive_Mult, 2))
        for slot in ("Diffuse", "Normal", "Glow"):
            print("     ", slot, s.textures.get(slot))
    c = nif.rootNode.collision_object
    print("  COLLISION", c.blockname if c else None, c.body.shape.blockname if c else None)
