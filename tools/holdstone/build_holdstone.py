"""
Builds meshes/oathbound/holdstone.nif in Blender (PyNifly).

Starts from the vanilla TG08 standing stone NIF so the root node, BSX flags and
Havok collision setup are exactly what the exporter expects, then replaces its
geometry with the holdstone: a two-tier Nordic plinth, a tapered hewn monolith
and glowing runes on the front and back faces. The rune material is copied from
the Solstheim Sun stone (a glow-map lighting shader) with custom textures.

blender -b --factory-startup -P build_holdstone.py -- <scratch> <out.nif> <preview.png>
"""
import bpy, bmesh, sys, math, random, addon_utils
from mathutils import Vector, Matrix

args = sys.argv[sys.argv.index("--") + 1:]
SCRATCH, OUT_NIF, PREVIEW = args[0], args[1], args[2]
VAN = SCRATCH + r"\vanilla\meshes"
TEX = SCRATCH + r"\build\textures"

bpy.ops.wm.read_factory_settings(use_empty=True)
addon_utils.enable("io_scene_nifly", default_set=True)

# ── 1. Vanilla scaffolding ────────────────────────────────────────────────────
bpy.ops.import_scene.pynifly(filepath=VAN + r"\dlc02\landscape\standingstone\dlc2standingstonesun.nif")
glow_mat = bpy.data.materials["DLC2SSSun:4.Mat"]
glow_mat.use_fake_user = True
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.import_scene.pynifly(filepath=VAN + r"\clutter\quest\tg08standingstone.nif")
root = bpy.data.objects["TG08StandingStone:ROOT"]
coll = bpy.data.objects["bhkConvexVerticesShape"]
old = bpy.data.objects["TG08StandingStone:0"]
base_mat = old.data.materials[0]
base_mat.use_fake_user = True
template_props = {k: old[k] for k in old.keys() if not k.startswith("_")}
bpy.data.objects.remove(old, do_unlink=True)
root["pynNodeName"] = "OBHoldstone"
root.name = "OBHoldstone:ROOT"


import os


def _png_twin(path):
    """Blender cannot show uncompressed DDS; give it a PNG twin with the same
    pixels. The exporter writes the path with a .dds suffix either way."""
    png = path[:-4] + ".png"
    if os.path.exists(png):
        return png
    if "oathbound" not in path.lower():
        return path
    across = lambda v: 1 - abs(v - 0.5) * 2
    s = 64
    img = bpy.data.images.new(os.path.basename(png), s, s, alpha=True)
    px = []
    for y in range(s):
        for x in range(s):
            v = y / s
            if path.lower().endswith("_n.dds"):
                px += [0.5, 0.5, 1.0, 1.0]
            elif path.lower().endswith("_g.dds"):
                k = (150 + 105 * across(v)) / 255
                px += [k, k, k, 1.0]
            else:
                k = 0.75 + 0.25 * across(v)
                px += [170 * k / 255, 215 * k / 255, 1.0, 1.0]
    img.pixels = px
    img.filepath_raw = png
    img.file_format = "PNG"
    img.save()
    return png


def set_image(mat, node_name, path):
    n = mat.node_tree.nodes.get(node_name)
    if n is None:
        return False
    n.image = bpy.data.images.load(_png_twin(path), check_existing=True)
    return True


def textured(src, name, diffuse, normal, glow=None):
    m = src.copy()
    m.name = name
    set_image(m, "Diffuse_Texture", TEX + "\\" + diffuse)
    set_image(m, "Normal_Texture", TEX + "\\" + normal)
    m["BSShaderTextureSet_Diffuse"] = "textures\\" + diffuse
    m["BSShaderTextureSet_Normal"] = "textures\\" + normal
    if glow:
        m["BSShaderTextureSet_Glow"] = "textures\\" + glow
        set_image(m, "Glow_Texture", TEX + "\\" + glow)
    return m


mat_stone = textured(base_mat, "OBHoldstone:Stone.Mat",
                     r"architecture\windhelm\whstoneroughsurface.dds",
                     r"architecture\windhelm\whstoneroughsurface_n.dds")
mat_trim = textured(base_mat, "OBHoldstone:Plinth.Mat",
                    r"architecture\windhelm\whtrimstone1.dds",
                    r"architecture\windhelm\whtrimstone1_n.dds")
mat_rune = textured(glow_mat, "OBHoldstone:Rune.Mat",
                    r"oathbound\holdstone\holdstonerune.dds",
                    r"oathbound\holdstone\holdstonerune_n.dds",
                    r"oathbound\holdstone\holdstonerune_g.dds")
for n in mat_rune.node_tree.nodes:
    if n.type == "GROUP":
        if "Emission Color" in n.inputs:
            n.inputs["Emission Color"].default_value = (0.55, 0.8, 1.0, 1.0)
        if "Emission Strength" in n.inputs:
            n.inputs["Emission Strength"].default_value = 2.0

# ── 2. Geometry helpers ───────────────────────────────────────────────────────
rng = random.Random(1715)


def box_uv(bm, scale):
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for l in f.loops:
            c = l.vert.co
            if ax == 0:
                u, v = c.y, c.z
            elif ax == 1:
                u, v = c.x, c.z
            else:
                u, v = c.x, c.y
            l[uv].uv = (u * scale, v * scale)


def make_obj(name, bm, mat, uv_scale=None):
    if uv_scale:
        box_uv(bm, uv_scale)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = False
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.parent = root
    for k, v in template_props.items():
        o[k] = v
    o["pynNodeName"] = name
    return o


def prism(bm, ring_lo, ring_hi):
    lo = [bm.verts.new(p) for p in ring_lo]
    hi = [bm.verts.new(p) for p in ring_hi]
    n = len(lo)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.faces.new(list(reversed(lo)))
    bm.faces.new(hi)


def octagon(r, z):
    return [(r * math.cos(math.pi / 8 + i * math.pi / 4), r * math.sin(math.pi / 8 + i * math.pi / 4), z)
            for i in range(8)]


# ── 3. Plinth: two octagonal tiers, sunk a little so it sits on slopes ────────
bm = bmesh.new()
prism(bm, octagon(76, -14), octagon(76, 10))
prism(bm, octagon(60, 10), octagon(60, 24))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
plinth = make_obj("OBHoldstone:Plinth", bm, mat_trim, uv_scale=1 / 64)

# ── 4. Monolith: tapered, front/back faces flat for the runes ─────────────────
Z0, Z1, APEX = 24, 178, 204
HX0, HX1, HY0, HY1 = 30, 22, 20, 15


def hx(z): return HX0 + (HX1 - HX0) * (z - Z0) / (Z1 - Z0)
def hy(z): return HY0 + (HY1 - HY0) * (z - Z0) / (Z1 - Z0)


def section(z, jitter):
    a, b = hx(z), hy(z)
    j = (lambda: rng.uniform(-jitter, jitter))
    return [(-a * 0.72, -b, z), (a * 0.72, -b, z),
            (a + j(), -b * 0.45, z), (a + j(), b * 0.45, z),
            (a * 0.72, b, z), (-a * 0.72, b, z),
            (-a + j(), b * 0.45, z), (-a + j(), -b * 0.45, z)]


bm = bmesh.new()
levels = [Z0, 62, 100, 140, Z1]
rings = [[bm.verts.new(p) for p in section(z, 0 if z in (Z0, Z1) else 1.6)] for z in levels]
for lo, hi in zip(rings, rings[1:]):
    for i in range(8):
        j = (i + 1) % 8
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
bm.faces.new(list(reversed(rings[0])))
# hewn top: a slightly off-centre ridge instead of a clean point
r1 = Vector((-6, 0, APEX - 4))
r2 = Vector((5, 0, APEX))
a1, a2 = bm.verts.new(r1), bm.verts.new(r2)
top = rings[-1]
bm.faces.new((top[0], top[1], a2, a1))
bm.faces.new((top[1], top[2], a2))
bm.faces.new((top[2], top[3], a2))
bm.faces.new((top[3], top[4], a2))
bm.faces.new((top[4], top[5], a1, a2))
bm.faces.new((top[5], top[6], a1))
bm.faces.new((top[6], top[7], a1))
bm.faces.new((top[7], top[0], a1))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
monolith = make_obj("OBHoldstone:Stone", bm, mat_stone, uv_scale=1 / 96)

# ── 5. Runes: glowing strokes standing just proud of the front and back faces ─
STROKES = [
    ((0, 58), (0, 162)),                         # stem
    ((0, 140), (-11, 158)), ((0, 140), (11, 158)),  # upper arms
    ((0, 80), (-11, 62)), ((0, 80), (11, 62)),      # lower arms
    ((0, 96), (-9, 110)), ((-9, 110), (0, 124)),    # centre diamond
    ((0, 124), (9, 110)), ((9, 110), (0, 96)),
]
WIDTH, LIFT = 2.6, 0.45

bm = bmesh.new()
uvl = bm.loops.layers.uv.verify()
for side in (-1, 1):
    for (x1, z1), (x2, z2) in STROKES:
        d = Vector((x2 - x1, z2 - z1)).normalized()
        nrm = Vector((-d.y, d.x)) * (WIDTH / 2)
        ext = d * (WIDTH / 2)   # square caps so joints meet cleanly
        pts = [(x1 - ext.x + nrm.x, z1 - ext.y + nrm.y), (x2 + ext.x + nrm.x, z2 + ext.y + nrm.y),
               (x2 + ext.x - nrm.x, z2 + ext.y - nrm.y), (x1 - ext.x - nrm.x, z1 - ext.y - nrm.y)]
        vs = [bm.verts.new((x, side * (hy(z) + LIFT), z)) for x, z in pts]
        # winding: this order faces +Y, so reverse it on the front (-Y) face
        f = bm.faces.new(vs if side > 0 else list(reversed(vs)))
        for l, (u, v) in zip(f.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
            l[uvl].uv = (u, v)
bm.normal_update()
runes = make_obj("OBHoldstone:Rune", bm, mat_rune)

# ── 6. Collision: one convex hull around plinth top and monolith ──────────────
pts = [monolith.matrix_world @ v.co for v in monolith.data.vertices]
pts += [Vector(p) for p in octagon(60, 0) + octagon(60, 24)]
bm = bmesh.new()
for p in pts:
    bm.verts.new(coll.matrix_world.inverted() @ p)
bmesh.ops.convex_hull(bm, input=bm.verts)
me = bpy.data.meshes.new("bhkConvexVerticesShape")
bm.to_mesh(me)
bm.free()
old_me = coll.data
coll.data = me
bpy.data.meshes.remove(old_me)

# ── 7. Export ─────────────────────────────────────────────────────────────────
for o in bpy.data.objects:
    print("OBJ", o.name, o.type, "parent=", o.parent.name if o.parent else None,
          "dims=", tuple(round(d, 1) for d in o.dimensions))
for n in mat_rune.node_tree.nodes:
    print("RUNE NODE", n.type, n.name, getattr(n, "image", None) and n.image.filepath)
os.makedirs(os.path.dirname(OUT_NIF), exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = root
bpy.ops.export_scene.pynifly(filepath=OUT_NIF, target_game="SKYRIMSE")
print("EXPORTED", OUT_NIF)

# ── 8. Preview render ─────────────────────────────────────────────────────────
scene = bpy.context.scene
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
cam.location = (190, -300, 150)
cam.rotation_euler = (Vector((0, 0, 100)) - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.data.lens = 50
scene.camera = cam
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.collection.objects.link(sun)
ground = bpy.data.meshes.new("ground")
ground.from_pydata([(-400, -400, 0), (400, -400, 0), (400, 400, 0), (-400, 400, 0)], [], [(0, 1, 2, 3)])
g = bpy.data.objects.new("ground", ground)
scene.collection.objects.link(g)
coll.hide_render = True
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.42, 0.5, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
scene.world = world
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x, scene.render.resolution_y = 900, 1100
scene.render.filepath = PREVIEW
bpy.ops.render.render(write_still=True)
print("RENDERED", PREVIEW)
