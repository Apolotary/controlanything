"""
Procedural virtual room for the ControlEverything sim (Blender 5.x + Cycles). Everything is built from
primitives and procedural materials in this file: no external assets.

The room is rendered as separate *linear light layers* that the browser adds back together in real time:

    pixel = sky + level * cct(T) * lamp + night * amber * nightLamp      (then exposure, tone curve, grain)

Rendering is linear per RGB channel, so that sum reproduces any brightness, colour temperature and
night-light state exactly, at the cost of three renders per camera view.

Usage (from the repo root):
    /Applications/Blender.app/Contents/MacOS/Blender -b -P apps/sim/scene/room.py -- --out apps/sim/scene/out
    ... -- --out <dir> --preview          one quick 640x480 tone-mapped PNG per view (composition check)
    ... -- --out <dir> --samples 512      final layers (Radiance .hdr) + id masks (.png) + scene.json

Then `npx tsx apps/sim/scripts/pack-room.ts` packs the layers into apps/sim/public/room/.
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector

# --------------------------------------------------------------------------------------------- args

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv) and not argv[i + 1].startswith('--'):
            return argv[i + 1]
        return True
    return default


OUT = os.path.abspath(arg('--out', 'apps/sim/scene/out'))
PREVIEW = bool(arg('--preview', False))
SAMPLES = int(arg('--samples', 512))
ONLY_VIEW = arg('--view', None)
MASKS_ONLY = bool(arg('--masks-only', False))
WIDTH, HEIGHT = 1280, 960
# Quest 3 passthrough stream at 1280x960 (research/04): fx = fy = 868.31 px
FX = 868.31

# room interior (metres, Blender Z-up): x 0..W, y 0..D, z 0..H
W, D, H = 3.6, 3.6, 2.4
LAMP_C = Vector((1.8, 1.9, H))  # centre of the fixture's ceiling plate
LAMP_R = 0.29

random.seed(7)

# ------------------------------------------------------------------------------------------ helpers


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    return scene


def set_in(node, name, value):
    sock = node.inputs.get(name)
    if sock is not None:
        sock.default_value = value


def principled(name, color, rough=0.5, metal=0.0, **extra):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    set_in(p, 'Base Color', (*color, 1.0))
    set_in(p, 'Roughness', rough)
    set_in(p, 'Metallic', metal)
    for k, v in extra.items():
        set_in(p, k.replace('_', ' '), v)
    return m


def link(nt, a, b):
    nt.links.new(a, b)


def noise_bump(m, scale=60.0, strength=0.08, detail=6.0):
    """Fine procedural bump (wallpaper, plaster, fabric)."""
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nz = nt.nodes.new('ShaderNodeTexNoise')
    set_in(nz, 'Scale', scale)
    set_in(nz, 'Detail', detail)
    bump = nt.nodes.new('ShaderNodeBump')
    set_in(bump, 'Strength', strength)
    set_in(bump, 'Distance', 0.002)
    link(nt, tc.outputs['Object'], nz.inputs['Vector'])
    link(nt, nz.outputs['Fac'], bump.inputs['Height'])
    link(nt, bump.outputs['Normal'], p.inputs['Normal'])
    return m


def tint_noise(m, c1, c2, scale=8.0, detail=4.0):
    """Base colour = mix of two colours by low-frequency noise (breaks up flat surfaces)."""
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nz = nt.nodes.new('ShaderNodeTexNoise')
    set_in(nz, 'Scale', scale)
    set_in(nz, 'Detail', detail)
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*c1, 1)
    ramp.color_ramp.elements[1].color = (*c2, 1)
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[1].position = 0.7
    link(nt, tc.outputs['Object'], nz.inputs['Vector'])
    link(nt, nz.outputs['Fac'], ramp.inputs['Fac'])
    link(nt, ramp.outputs['Color'], p.inputs['Base Color'])
    return m


def wood(name, c1, c2, rough=0.45, planks=False, scale=1.0):
    """Procedural wood: noise stretched along X (grain streaks), optional plank layout via the brick texture."""
    m = principled(name, c1, rough)
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    set_in(mp, 'Scale', (1.5 * scale, 45.0 * scale, 1.5 * scale))
    nz = nt.nodes.new('ShaderNodeTexNoise')
    set_in(nz, 'Scale', 2.5)
    set_in(nz, 'Detail', 9.0)
    set_in(nz, 'Roughness', 0.62)
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (*c1, 1)
    ramp.color_ramp.elements[1].position = 0.68
    ramp.color_ramp.elements[1].color = (*c2, 1)
    link(nt, tc.outputs['Object'], mp.inputs['Vector'])
    link(nt, mp.outputs['Vector'], nz.inputs['Vector'])
    link(nt, nz.outputs['Fac'], ramp.inputs['Fac'])
    color_out = ramp.outputs['Color']
    if planks:
        brick = nt.nodes.new('ShaderNodeTexBrick')
        set_in(brick, 'Scale', 1.0)
        set_in(brick, 'Mortar Size', 0.004)
        set_in(brick, 'Brick Width', 1.6)
        set_in(brick, 'Row Height', 0.14)
        brick.offset = 0.37
        set_in(brick, 'Color1', (1, 1, 1, 1))
        set_in(brick, 'Color2', (0.84, 0.84, 0.84, 1))
        set_in(brick, 'Mortar', (0.25, 0.25, 0.25, 1))
        link(nt, tc.outputs['Object'], brick.inputs['Vector'])
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        set_in(mix, 'Factor', 1.0)
        link(nt, ramp.outputs['Color'], mix.inputs[6])
        link(nt, brick.outputs['Color'], mix.inputs[7])
        color_out = mix.outputs[2]
    link(nt, color_out, p.inputs['Base Color'])
    return m


def emissive(name, color, strength):
    m = principled(name, (0.02, 0.02, 0.02), 0.4)
    p = m.node_tree.nodes.get('Principled BSDF')
    set_in(p, 'Emission Color', (*color, 1))
    set_in(p, 'Emission Strength', strength)
    return m


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def finish(obj, mat=None, bevel=0.0, segments=3, smooth=False):
    if mat is not None:
        assign(obj, mat)
    if bevel > 0:
        b = obj.modifiers.new('Bevel', 'BEVEL')
        b.width = bevel
        b.segments = segments
        b.limit_method = 'ANGLE'
    if smooth:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
        except Exception:
            bpy.ops.object.shade_smooth()
        obj.select_set(False)
    return obj


def box(name, center, size, mat=None, bevel=0.0, rot_z=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center, rotation=(0, 0, rot_z))
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, mat, bevel, smooth=bevel > 0)


def cyl(name, center, r, depth, mat=None, verts=64, bevel=0.0, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=center, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    return finish(o, mat, bevel, smooth=True)


def parent_all(name, objs):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    for o in objs:
        o.parent = e
    return e


# --------------------------------------------------------------------------------------- materials

M = {}


def make_materials():
    M['wall'] = noise_bump(tint_noise(principled('wall', (0.78, 0.76, 0.72), 0.92), (0.76, 0.74, 0.70), (0.80, 0.78, 0.74), 3.0), 90.0, 0.12)
    M['ceiling'] = noise_bump(principled('ceiling', (0.80, 0.80, 0.78), 0.95), 140.0, 0.10)
    M['floor'] = wood('floor', (0.30, 0.19, 0.10), (0.46, 0.31, 0.17), 0.35, planks=True)
    M['oak'] = wood('oak', (0.55, 0.40, 0.25), (0.68, 0.52, 0.34), 0.5, scale=2.0)
    M['shelfwood'] = wood('shelfwood', (0.42, 0.28, 0.16), (0.55, 0.38, 0.22), 0.55, scale=2.0)
    M['base'] = principled('baseboard', (0.32, 0.24, 0.17), 0.5)
    M['white_plastic'] = principled('white_plastic', (0.86, 0.86, 0.85), 0.38, Coat_Weight=0.1)
    M['ac'] = principled('ac_white', (0.85, 0.85, 0.84), 0.32)
    M['dark_slot'] = principled('dark_slot', (0.05, 0.05, 0.05), 0.6)
    M['alu'] = principled('aluminium', (0.80, 0.80, 0.81), 0.32, metal=1.0)
    M['alu_dark'] = principled('aluminium_dark', (0.30, 0.30, 0.31), 0.4, metal=1.0)
    M['sash'] = principled('window_sash', (0.55, 0.53, 0.50), 0.35, metal=1.0)
    M['glass'] = principled('glass', (1, 1, 1), 0.02, Transmission_Weight=1.0, IOR=1.45, Thin_Wall=True)
    M['lace'] = principled('lace', (0.92, 0.92, 0.90), 0.85, Transmission_Weight=0.55, Thin_Wall=True)
    M['curtain'] = noise_bump(principled('curtain', (0.55, 0.50, 0.42), 0.9, Sheen_Weight=0.4), 220.0, 0.15)
    M['rug'] = noise_bump(tint_noise(principled('rug', (0.30, 0.33, 0.36), 0.95, Sheen_Weight=0.5), (0.27, 0.30, 0.33), (0.34, 0.37, 0.40), 25.0), 300.0, 0.3)
    M['black'] = principled('black_metal', (0.03, 0.03, 0.03), 0.45, metal=0.6)
    M['key_white'] = principled('key_white', (0.86, 0.86, 0.84), 0.35)
    M['key_black'] = principled('key_black', (0.04, 0.04, 0.045), 0.4)
    M['knob_blue'] = principled('knob_blue', (0.05, 0.22, 0.75), 0.35)
    M['knob_ochre'] = principled('knob_ochre', (0.80, 0.55, 0.06), 0.35)
    M['knob_grey'] = principled('knob_grey', (0.55, 0.55, 0.56), 0.35)
    M['knob_orange'] = principled('knob_orange', (0.90, 0.25, 0.04), 0.35)
    M['button_grey'] = principled('button_grey', (0.35, 0.35, 0.36), 0.5)
    M['frame'] = principled('picture_frame', (0.08, 0.07, 0.06), 0.5)
    M['pot'] = principled('pot', (0.65, 0.42, 0.30), 0.7)
    M['leaf'] = principled('leaf', (0.08, 0.22, 0.07), 0.55, Subsurface_Weight=0.1)
    M['book'] = [principled(f'book{i}', c, 0.65) for i, c in enumerate([
        (0.45, 0.10, 0.08), (0.10, 0.20, 0.35), (0.65, 0.58, 0.42), (0.12, 0.25, 0.15), (0.20, 0.20, 0.22),
        (0.72, 0.70, 0.66), (0.50, 0.32, 0.12), (0.30, 0.12, 0.25), (0.60, 0.45, 0.10), (0.15, 0.15, 0.40)])]
    M['synth_screen'] = synth_screen_material()
    M['laptop_screen'] = laptop_screen_material()
    M['art'] = art_material()
    M['diffuser'] = diffuser_material()


def screen_tex_material(name, base_rgb, make_pattern):
    m = principled(name, (0.01, 0.01, 0.012), 0.15)
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    strength = nt.nodes.new('ShaderNodeValue')
    strength.name = 'screen_strength'
    strength.outputs[0].default_value = 1.0
    col = make_pattern(nt)
    mul = nt.nodes.new('ShaderNodeVectorMath')
    mul.operation = 'MULTIPLY'
    set_in(mul, 'Vector', base_rgb)
    link(nt, col, mul.inputs[1])
    link(nt, mul.outputs['Vector'], p.inputs['Emission Color'])
    link(nt, strength.outputs[0], p.inputs['Emission Strength'])
    return m


def synth_screen_material():
    # a dim black OLED with four coloured arcs drawn by a polar gradient (static; the browser overlays the live screen)
    def pattern(nt):
        tc = nt.nodes.new('ShaderNodeTexCoord')
        wave = nt.nodes.new('ShaderNodeTexWave')
        wave.wave_type = 'RINGS'
        set_in(wave, 'Scale', 3.0)
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.interpolation = 'CONSTANT'
        ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
        ramp.color_ramp.elements[1].position = 0.82
        ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
        link(nt, tc.outputs['UV'], wave.inputs['Vector'])
        link(nt, wave.outputs['Fac'], ramp.inputs['Fac'])
        return ramp.outputs['Color']
    return screen_tex_material('synth_screen', (0.35, 0.75, 0.9), pattern)


def laptop_screen_material():
    # a desktop wallpaper: deep blue to violet diagonal gradient with a soft glow
    def pattern(nt):
        tc = nt.nodes.new('ShaderNodeTexCoord')
        grad = nt.nodes.new('ShaderNodeTexGradient')
        grad.gradient_type = 'QUADRATIC_SPHERE'
        mp = nt.nodes.new('ShaderNodeMapping')
        set_in(mp, 'Location', (-0.3, -0.6, 0.0))
        set_in(mp, 'Scale', (1.2, 1.6, 1.0))
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].color = (0.10, 0.12, 0.35, 1)
        ramp.color_ramp.elements[1].color = (0.75, 0.45, 0.85, 1)
        link(nt, tc.outputs['UV'], mp.inputs['Vector'])
        link(nt, mp.outputs['Vector'], grad.inputs['Vector'])
        link(nt, grad.outputs['Fac'], ramp.inputs['Fac'])
        return ramp.outputs['Color']
    return screen_tex_material('laptop_screen', (1.0, 1.0, 1.0), pattern)


def art_material():
    # abstract print for the wall frame: soft colour field
    m = principled('art', (0.5, 0.5, 0.5), 0.8)
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nz = nt.nodes.new('ShaderNodeTexNoise')
    set_in(nz, 'Scale', 1.6)
    set_in(nz, 'Detail', 1.0)
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (0.10, 0.22, 0.30, 1)
    ramp.color_ramp.elements[1].color = (0.85, 0.55, 0.30, 1)
    link(nt, tc.outputs['UV'], nz.inputs['Vector'])
    link(nt, nz.outputs['Fac'], ramp.inputs['Fac'])
    link(nt, ramp.outputs['Color'], p.inputs['Base Color'])
    return m


def diffuser_material():
    """White acrylic shade. Emission = main * radial profile + night * small centre spot (layers toggle main/night)."""
    m = principled('diffuser', (0.80, 0.80, 0.79), 0.55, Subsurface_Weight=0.15, Specular_IOR_Level=0.3)
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    link(nt, tc.outputs['Object'], sep.inputs['Vector'])
    x2 = nt.nodes.new('ShaderNodeMath')
    x2.operation = 'MULTIPLY'
    link(nt, sep.outputs['X'], x2.inputs[0])
    link(nt, sep.outputs['X'], x2.inputs[1])
    y2 = nt.nodes.new('ShaderNodeMath')
    y2.operation = 'MULTIPLY'
    link(nt, sep.outputs['Y'], y2.inputs[0])
    link(nt, sep.outputs['Y'], y2.inputs[1])
    r2 = nt.nodes.new('ShaderNodeMath')
    r2.operation = 'ADD'
    link(nt, x2.outputs[0], r2.inputs[0])
    link(nt, y2.outputs[0], r2.inputs[1])
    # main profile: 0.82 + 0.18 * (1 - r^2)  (object space: r = 1 at the rim)
    prof = nt.nodes.new('ShaderNodeMapRange')
    set_in(prof, 'From Min', 0.0)
    set_in(prof, 'From Max', 1.0)
    set_in(prof, 'To Min', 1.0)
    set_in(prof, 'To Max', 0.82)
    link(nt, r2.outputs[0], prof.inputs['Value'])
    # night spot: 1 at the centre, 0 beyond r = 0.22 (about 6 cm)
    spot = nt.nodes.new('ShaderNodeMapRange')
    spot.interpolation_type = 'SMOOTHERSTEP'
    set_in(spot, 'From Min', 0.004)
    set_in(spot, 'From Max', 0.05)
    set_in(spot, 'To Min', 1.0)
    set_in(spot, 'To Max', 0.0)
    link(nt, r2.outputs[0], spot.inputs['Value'])
    main = nt.nodes.new('ShaderNodeValue')
    main.name = 'main'
    main.outputs[0].default_value = 0.0
    night = nt.nodes.new('ShaderNodeValue')
    night.name = 'night'
    night.outputs[0].default_value = 0.0
    # LED ceiling lights throw their light down: the bottom of the shade glows fully, the rim much less
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    nsep = nt.nodes.new('ShaderNodeSeparateXYZ')
    link(nt, geo.outputs['Normal'], nsep.inputs['Vector'])
    down = nt.nodes.new('ShaderNodeMath')
    down.operation = 'MULTIPLY'
    down.inputs[1].default_value = -1.0
    link(nt, nsep.outputs['Z'], down.inputs[0])
    clampd = nt.nodes.new('ShaderNodeMath')
    clampd.operation = 'MAXIMUM'
    clampd.inputs[1].default_value = 0.0
    link(nt, down.outputs[0], clampd.inputs[0])
    powd = nt.nodes.new('ShaderNodeMath')
    powd.operation = 'POWER'
    powd.inputs[1].default_value = 2.0
    link(nt, clampd.outputs[0], powd.inputs[0])
    rim = nt.nodes.new('ShaderNodeMath')
    rim.operation = 'ADD'
    rim.inputs[1].default_value = 0.06
    link(nt, powd.outputs[0], rim.inputs[0])
    a0 = nt.nodes.new('ShaderNodeMath')
    a0.operation = 'MULTIPLY'
    link(nt, prof.outputs['Result'], a0.inputs[0])
    link(nt, rim.outputs[0], a0.inputs[1])
    a = nt.nodes.new('ShaderNodeMath')
    a.operation = 'MULTIPLY'
    link(nt, a0.outputs[0], a.inputs[0])
    link(nt, main.outputs[0], a.inputs[1])
    b = nt.nodes.new('ShaderNodeMath')
    b.operation = 'MULTIPLY'
    link(nt, spot.outputs['Result'], b.inputs[0])
    link(nt, night.outputs[0], b.inputs[1])
    b2 = nt.nodes.new('ShaderNodeMath')
    b2.operation = 'MULTIPLY'
    b2.inputs[1].default_value = 25.0  # the night LED is a small, intense spot
    link(nt, b.outputs[0], b2.inputs[0])
    s = nt.nodes.new('ShaderNodeMath')
    s.operation = 'ADD'
    link(nt, a.outputs[0], s.inputs[0])
    link(nt, b2.outputs[0], s.inputs[1])
    set_in(p, 'Emission Color', (1, 1, 1, 1))
    link(nt, s.outputs[0], p.inputs['Emission Strength'])
    return m


# ------------------------------------------------------------------------------------------- build

DEVICES = {}  # id -> list of objects (for masks and scene.json)
SCREENS = {}  # screen id -> object (quad corners exported per view)


def build_room():
    t = 0.12
    box('floor', (W / 2, D / 2, -t / 2), (W + 2 * t, D + 2 * t, t), M['floor'])
    box('ceiling', (W / 2, D / 2, H + t / 2), (W + 2 * t, D + 2 * t, t), M['ceiling'])
    box('wall_left', (-t / 2, D / 2, H / 2), (t, D, H), M['wall'])
    box('wall_right', (W + t / 2, D / 2, H / 2), (t, D, H), M['wall'])
    box('wall_near', (W / 2, -t / 2, H / 2), (W, t, H), M['wall'])
    # far wall with a window opening x 2.15..3.35, z 0.85..2.05
    wx0, wx1, wz0, wz1 = 2.15, 3.35, 0.85, 2.05
    yfar = D + t / 2
    box('wall_far_left', (wx0 / 2, yfar, H / 2), (wx0, t, H), M['wall'])
    box('wall_far_right', ((wx1 + W) / 2, yfar, H / 2), (W - wx1, t, H), M['wall'])
    box('wall_far_below', ((wx0 + wx1) / 2, yfar, wz0 / 2), (wx1 - wx0, t, wz0), M['wall'])
    box('wall_far_above', ((wx0 + wx1) / 2, yfar, (wz1 + H) / 2), (wx1 - wx0, t, H - wz1), M['wall'])
    # baseboards and ceiling trim
    for name, c, s in [
        ('bb_left', (0.006, D / 2, 0.035), (0.012, D, 0.07)),
        ('bb_right', (W - 0.006, D / 2, 0.035), (0.012, D, 0.07)),
        ('bb_far', (W / 2, D - 0.006, 0.035), (W, 0.012, 0.07)),
        ('trim_far', (W / 2, D - 0.008, H - 0.012), (W, 0.016, 0.024)),
        ('trim_left', (0.008, D / 2, H - 0.012), (0.016, D, 0.024)),
        ('trim_right', (W - 0.008, D / 2, H - 0.012), (0.016, D, 0.024)),
    ]:
        box(name, c, s, M['base'])
    build_window(wx0, wx1, wz0, wz1)
    # rug
    box('rug', (1.75, 1.75, 0.006), (1.6, 2.0, 0.012), M['rug'], bevel=0.004)
    # wall art on the right wall
    box('art_frame', (W - 0.015, 1.25, 1.55), (0.02, 0.62, 0.46), M['frame'], bevel=0.003)
    bpy.ops.mesh.primitive_plane_add(size=1, location=(W - 0.027, 1.25, 1.55), rotation=(math.pi / 2, 0, -math.pi / 2))
    art = bpy.context.active_object
    art.name = 'art'
    art.scale = (0.56, 0.40, 1)
    assign(art, M['art'])
    # light switch plate near the window
    box('switch', (W - 0.01, 3.05, 1.2), (0.012, 0.07, 0.12), M['white_plastic'], bevel=0.003)


def pleated(name, x0, x1, y, z0, z1, amp, period, mat, nx=120, nz=8):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rows = []
    for j in range(nz + 1):
        z = z0 + (z1 - z0) * j / nz
        row = []
        for i in range(nx + 1):
            x = x0 + (x1 - x0) * i / nx
            row.append(bm.verts.new((x, y + amp * math.sin(2 * math.pi * (x - x0) / period), z)))
        rows.append(row)
    for j in range(nz):
        for i in range(nx):
            bm.faces.new((rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]))
    bm.to_mesh(mesh)
    bm.free()
    o = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(o)
    for poly in mesh.polygons:
        poly.use_smooth = True
    assign(o, mat)
    return o


def build_window(x0, x1, z0, z1):
    y = D
    f = 0.035
    # outer aluminium frame
    box('win_frame_l', (x0 + f / 2, y + 0.03, (z0 + z1) / 2), (f, 0.07, z1 - z0), M['sash'])
    box('win_frame_r', (x1 - f / 2, y + 0.03, (z0 + z1) / 2), (f, 0.07, z1 - z0), M['sash'])
    box('win_frame_b', ((x0 + x1) / 2, y + 0.03, z0 + f / 2), (x1 - x0, 0.07, f), M['sash'])
    box('win_frame_t', ((x0 + x1) / 2, y + 0.03, z1 - f / 2), (x1 - x0, 0.07, f), M['sash'])
    # two sliding panes (Japanese aluminium sash) with a centre overlap
    xm = (x0 + x1) / 2
    for i, (a, b, yy) in enumerate([(x0 + f, xm + 0.02, y + 0.045), (xm - 0.02, x1 - f, y + 0.02)]):
        box(f'win_mullion{i}', ((a if i else b), yy, (z0 + z1) / 2), (0.03, 0.025, z1 - z0 - 2 * f), M['sash'])
        bpy.ops.mesh.primitive_plane_add(size=1, location=((a + b) / 2, yy, (z0 + z1) / 2), rotation=(math.pi / 2, 0, 0))
        g = bpy.context.active_object
        g.name = f'glass{i}'
        g.scale = (b - a, z1 - z0 - 2 * f, 1)
        assign(g, M['glass'])
    # sill
    box('win_sill', ((x0 + x1) / 2, y - 0.03, z0 - 0.01), (x1 - x0 + 0.08, 0.07, 0.02), M['white_plastic'], bevel=0.004)
    # curtains: lace across the window, heavier side curtains, a rail
    box('curtain_rail', ((x0 + x1) / 2, y - 0.09, z1 + 0.12), (x1 - x0 + 0.5, 0.03, 0.025), M['sash'])
    pleated('lace', x0 - 0.05, x1 + 0.05, y - 0.06, z0 - 0.08, z1 + 0.1, 0.012, 0.06, M['lace'])
    pleated('curtain_l', x0 - 0.3, x0 + 0.12, y - 0.12, 0.05, z1 + 0.1, 0.035, 0.13, M['curtain'], nx=60)
    pleated('curtain_r', x1 - 0.12, x1 + 0.22, y - 0.12, 0.05, z1 + 0.1, 0.035, 0.13, M['curtain'], nx=50)


def build_lamp():
    c = LAMP_C
    plate = cyl('lamp_plate', (c.x, c.y, H - 0.012), 0.20, 0.024, M['white_plastic'], bevel=0.004)
    body = cyl('lamp_body', (c.x, c.y, H - 0.035), 0.26, 0.03, M['white_plastic'], bevel=0.006)
    ring = cyl('lamp_ring', (c.x, c.y, H - 0.051), LAMP_R + 0.004, 0.006, M['alu'], bevel=0.002)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, radius=1.0, location=(c.x, c.y, H - 0.052))
    shade = bpy.context.active_object
    shade.name = 'lamp_diffuser'
    shade.scale = (LAMP_R, LAMP_R, 0.07)
    # keep only the lower half (the upper half is hidden inside the body)
    bpy.context.view_layer.objects.active = shade
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(shade.data)
    for v in [v for v in bm.verts if v.co.z > 0.02]:
        bm.verts.remove(v)
    bmesh.update_edit_mesh(shade.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    finish(shade, M['diffuser'], smooth=True)
    DEVICES['ceiling-light'] = [plate, body, ring, shade]


def build_desk():
    x0, x1, y0, y1, top = 0.25, 1.65, 2.98, 3.58, 0.72
    desk = box('desk_top', ((x0 + x1) / 2, (y0 + y1) / 2, top - 0.015), (x1 - x0, y1 - y0, 0.03), M['oak'], bevel=0.003)
    legs = []
    for lx in (x0 + 0.04, x1 - 0.04):
        for ly in (y0 + 0.04, y1 - 0.04):
            legs.append(box('desk_leg', (lx, ly, (top - 0.03) / 2), (0.035, 0.035, top - 0.03), M['black'], bevel=0.003))
    box('desk_rail', ((x0 + x1) / 2, y1 - 0.04, top - 0.08), (x1 - x0 - 0.1, 0.02, 0.07), M['black'])
    build_synth(Vector((0.80, 3.20, top)), math.radians(-4))
    build_remote(Vector((0.42, 3.08, top)), math.radians(12))
    build_laptop(Vector((1.30, 3.28, top)), math.radians(8))
    # a mug and a small plant for clutter
    cyl('mug', (1.58, 3.05, top + 0.045), 0.04, 0.09, M['white_plastic'], bevel=0.003)
    cyl('pot', (0.33, 3.48, top + 0.06), 0.06, 0.12, M['pot'], bevel=0.005)
    for i in range(14):
        a = i * 2.4
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.045,
                                             location=(0.33 + 0.05 * math.cos(a), 3.48 + 0.05 * math.sin(a), top + 0.15 + 0.012 * (i % 5)))
        lf = bpy.context.active_object
        lf.scale = (1.0, 0.5, 0.35)
        lf.rotation_euler = (random.uniform(-0.6, 0.6), random.uniform(-0.6, 0.6), a)
        finish(lf, M['leaf'], smooth=True)


def build_synth(o, rot):
    """A generic compact synth: aluminium body, two-octave keyboard, four coloured encoders, small screen."""
    parts = []
    w, d, h = 0.33, 0.115, 0.022
    rotm = Matrix.Rotation(rot, 4, 'Z')

    def P(x, y, z):
        return o + (rotm @ Vector((x, y, z)))

    body = box('synth_body', P(0, 0, h / 2), (w, d, h), M['alu'], bevel=0.004, rot_z=rot)
    parts.append(body)
    # keyboard: 14 white keys across the front 55% of the body
    kw = (w - 0.03) / 14
    for i in range(14):
        k = box('synth_key_w', P(-w / 2 + 0.015 + kw * (i + 0.5), -d / 2 + 0.03, h + 0.003), (kw * 0.92, 0.05, 0.006), M['key_white'], bevel=0.001, rot_z=rot)
        parts.append(k)
    for i in range(13):
        if i % 7 in (2, 6):
            continue
        k = box('synth_key_b', P(-w / 2 + 0.015 + kw * (i + 1), -d / 2 + 0.042, h + 0.008), (kw * 0.55, 0.03, 0.007), M['key_black'], bevel=0.001, rot_z=rot)
        parts.append(k)
    # encoders top right, screen top left
    for i, mat in enumerate(['knob_blue', 'knob_ochre', 'knob_grey', 'knob_orange']):
        k = cyl('synth_knob', P(0.035 + i * 0.033, d / 2 - 0.028, h + 0.007), 0.0105, 0.014, M[mat], verts=40, bevel=0.0015)
        parts.append(k)
        cap = cyl('synth_knob_cap', P(0.035 + i * 0.033, d / 2 - 0.028, h + 0.0145), 0.0045, 0.002, M['key_white'], verts=24)
        parts.append(cap)
    bezel = box('synth_bezel', P(-0.085, d / 2 - 0.028, h + 0.0005), (0.085, 0.040, 0.002), M['key_black'], rot_z=rot)
    parts.append(bezel)
    bpy.ops.mesh.primitive_plane_add(size=1, location=P(-0.085, d / 2 - 0.028, h + 0.0017), rotation=(0, 0, rot))
    scr = bpy.context.active_object
    scr.name = 'synth_screen'
    scr.scale = (0.072, 0.030, 1)
    assign(scr, M['synth_screen'])
    parts.append(scr)
    SCREENS['synth-screen'] = scr
    for i in range(6):
        b = cyl('synth_btn', P(-0.145 + i * 0.016, d / 2 - 0.012, h + 0.002), 0.004, 0.004, M['button_grey'], verts=20)
        parts.append(b)
    DEVICES['synth'] = parts


def build_remote(o, rot):
    """A plain white IR remote (no brand marks), the virtual stand-in for the lamp's remote."""
    parts = []
    rotm = Matrix.Rotation(rot, 4, 'Z')

    def P(x, y, z):
        return o + (rotm @ Vector((x, y, z)))

    body = box('remote_body', P(0, 0, 0.009), (0.048, 0.135, 0.018), M['white_plastic'], bevel=0.007, rot_z=rot)
    parts.append(body)
    for j, yy in enumerate([0.040, 0.016, -0.008, -0.032]):
        for i, xx in enumerate([-0.011, 0.011]):
            b = box('remote_btn', P(xx, yy, 0.0185), (0.016, 0.011, 0.003), M['button_grey'] if j else M['knob_orange'], bevel=0.0015, rot_z=rot)
            parts.append(b)
    DEVICES['remote'] = parts


def build_laptop(o, rot):
    parts = []
    rotm = Matrix.Rotation(rot, 4, 'Z')

    def P(x, y, z):
        return o + (rotm @ Vector((x, y, z)))

    base = box('laptop_base', P(0, -0.02, 0.008), (0.30, 0.21, 0.014), M['alu'], bevel=0.004, rot_z=rot)
    parts.append(base)
    box('laptop_keys', P(0, 0.0, 0.0155), (0.26, 0.09, 0.001), M['alu_dark'], rot_z=rot)
    th = math.radians(75)  # lid opened to 105 degrees from the base
    hinge = Vector((0, 0.085, 0.015))
    lid_dir = Vector((0, math.cos(th), math.sin(th)))
    lid_c = P(*(hinge + lid_dir * 0.1))
    bpy.ops.mesh.primitive_cube_add(size=1, location=lid_c, rotation=(th, 0, rot))
    lid = bpy.context.active_object
    lid.name = 'laptop_lid'
    lid.scale = (0.30, 0.2, 0.006)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish(lid, M['alu'], bevel=0.003, smooth=True)
    parts.append(lid)
    n = (rotm.to_3x3() @ Vector((0, -math.sin(th), math.cos(th)))).normalized()
    bpy.ops.mesh.primitive_plane_add(size=1, location=lid_c + n * 0.0035, rotation=(th, 0, rot))
    scr = bpy.context.active_object
    scr.name = 'laptop_screen'
    scr.scale = (0.27, 0.17, 1)
    assign(scr, M['laptop_screen'])
    parts.append(scr)
    DEVICES['laptop'] = parts


def build_ac():
    x0, x1 = 0.35, 1.20
    y = D - 0.13
    body = box('ac_body', ((x0 + x1) / 2, y, 2.12), (x1 - x0, 0.24, 0.29), M['ac'], bevel=0.03)
    slot = box('ac_slot', ((x0 + x1) / 2, y - 0.10, 2.0), (x1 - x0 - 0.1, 0.06, 0.025), M['dark_slot'], bevel=0.008)
    led = box('ac_led', (x1 - 0.12, y - 0.121, 2.07), (0.02, 0.002, 0.004), M['button_grey'])
    DEVICES['air-conditioner'] = [body, slot, led]


def build_shelf():
    # low bookshelf against the right wall, near the far corner
    x = W - 0.16
    y0, y1 = 2.25, 3.25
    h = 1.15
    parts = []
    parts.append(box('shelf_side_a', (x, y0, h / 2), (0.30, 0.02, h), M['shelfwood']))
    parts.append(box('shelf_side_b', (x, y1, h / 2), (0.30, 0.02, h), M['shelfwood']))
    parts.append(box('shelf_back', (W - 0.008, (y0 + y1) / 2, h / 2), (0.01, y1 - y0, h), M['shelfwood']))
    for z in (0.01, 0.38, 0.76, h - 0.01):
        parts.append(box('shelf_board', (x, (y0 + y1) / 2, z), (0.30, y1 - y0, 0.02), M['shelfwood']))
    for z0 in (0.02, 0.39, 0.77):
        yy = y0 + 0.02
        while yy < y1 - 0.06:
            bw = random.uniform(0.018, 0.045)
            bh = random.uniform(0.20, 0.33)
            bd = random.uniform(0.17, 0.24)
            if random.random() < 0.08:
                yy += 0.05
                continue
            box('book', (W - 0.02 - bd / 2, yy + bw / 2, z0 + bh / 2), (bd, bw, bh), random.choice(M['book']), bevel=0.002)
            yy += bw + 0.002
    # a speaker on top of the shelf
    box('speaker', (x, y0 + 0.2, h + 0.11), (0.17, 0.14, 0.2), M['black'], bevel=0.01)
    cyl('speaker_cone', (x - 0.086, y0 + 0.2, h + 0.09), 0.045, 0.004, M['alu_dark'], rot=(0, math.pi / 2, 0))


def build_lights():
    scene = bpy.context.scene
    world = bpy.data.worlds.new('dusk')
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get('Background')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.45
    ramp.color_ramp.elements[0].color = (0.55, 0.32, 0.22, 1)  # warm horizon
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (0.06, 0.12, 0.32, 1)  # blue hour zenith
    link(nt, tc.outputs['Generated'], sep.inputs['Vector'])
    link(nt, sep.outputs['Z'], ramp.inputs['Fac'])
    link(nt, ramp.outputs['Color'], bg.inputs['Color'])
    set_in(bg, 'Strength', 1.0)
    set_in(bg, 'Strength', 6.0)
    # a portal in the window opening guides Cycles' sampling of the dusk sky through it (far less noise)
    lw = bpy.data.lights.new('window_portal', 'AREA')
    lw.shape = 'RECTANGLE'
    lw.size = 1.25
    lw.size_y = 1.25
    lw.cycles.is_portal = True
    lo = bpy.data.objects.new('window_portal', lw)
    lo.location = (2.75, D + 0.09, 1.45)
    lo.rotation_euler = (math.radians(-90), 0, 0)  # -Z of the portal points into the room
    scene.collection.objects.link(lo)
    # faint fill from the corridor side (keeps the unlit room readable, like light from a hallway)
    lf = bpy.data.lights.new('fill', 'AREA')
    lf.shape = 'RECTANGLE'
    lf.size = 2.5
    lf.size_y = 1.5
    lf.energy = 6.0
    lf.color = (0.75, 0.80, 1.0)
    fo = bpy.data.objects.new('fill', lf)
    fo.location = (1.8, 0.05, 1.3)
    fo.rotation_euler = (math.radians(90), 0, 0)  # pointing into the room (+Y)
    scene.collection.objects.link(fo)


# ---------------------------------------------------------------------------------------- cameras

VIEWS = {
    # a person standing near the door, looking at the ceiling light (the lamp scene)
    'room': {'pos': (1.30, 0.35, 1.60), 'target': (1.62, 2.45, 1.655)},
    # standing at the desk, looking down at the synth and the remote
    'desk': {'pos': (0.92, 2.52, 1.30), 'target': (0.84, 3.22, 0.74)},
}


def make_camera(name, pos, target):
    cam = bpy.data.cameras.new(name)
    cam.sensor_fit = 'HORIZONTAL'
    cam.sensor_width = 36.0
    cam.lens = FX * 36.0 / WIDTH
    cam.clip_start = 0.05
    cam.clip_end = 30.0
    o = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(o)
    o.location = pos
    d = Vector(target) - Vector(pos)
    o.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return o


# Blender world (Z up) -> WebXR local-floor (Y up, -Z forward): x' = x, y' = z, z' = -y
B2X = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))


def to_xr_vec(v):
    return [round(c, 5) for c in (B2X @ Vector(v))]


def to_xr_pose(obj):
    mw = obj.matrix_world
    rot = (B2X @ mw.to_3x3()).normalized().to_quaternion()
    return {'position': dict(zip('xyz', to_xr_vec(mw.translation))),
            'orientation': {'x': round(rot.x, 6), 'y': round(rot.y, 6), 'z': round(rot.z, 6), 'w': round(rot.w, 6)}}


def world_bbox(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def screen_quad(scene, cam, obj):
    out = []
    for c in [(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)]:
        p = obj.matrix_world @ Vector(c)
        v = world_to_camera_view(scene, cam, p)
        out.append([round(v.x * WIDTH, 2), round((1 - v.y) * HEIGHT, 2)])
    return out


# ------------------------------------------------------------------------------------------ layers

MASK_IDS = {'ceiling-light': (1, 0, 0), 'synth': (0, 1, 0), 'remote': (0, 0, 1), 'laptop': (1, 1, 0), 'air-conditioner': (1, 0, 1)}


def set_layer(layer):
    """'sky' (window + world + screens), 'lamp' (main LEDs, unit), 'night' (night LED, unit), 'full' (preview)."""
    scene = bpy.context.scene
    d = M['diffuser'].node_tree.nodes
    d['main'].outputs[0].default_value = {'lamp': 1.0, 'full': 14.0}.get(layer, 0.0)
    d['night'].outputs[0].default_value = 1.0 if layer == 'night' else 0.0
    sky_on = layer in ('sky', 'full')
    scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value = 6.0 if sky_on else 0.0
    bpy.data.objects['fill'].hide_render = not sky_on
    for key in ('synth_screen', 'laptop_screen'):
        M[key].node_tree.nodes['screen_strength'].outputs[0].default_value = (3.0 if key == 'synth_screen' else 1.6) if sky_on else 0.0


def flat_emission(name, color, strength):
    """Emission shader only (no BSDF, so nothing reflects): for the id mask pass."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for nd in list(nt.nodes):
        nt.nodes.remove(nd)
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*color, 1)
    em.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m


def mask_materials():
    black = flat_emission('mask_black', (0, 0, 0), 0.0)
    ids = {k: flat_emission(f'mask_{k}', c, 1.0) for k, c in MASK_IDS.items()}
    screen_mat = flat_emission('mask_screen', (1, 1, 1), 1.0)
    owner = {}
    for k, objs in DEVICES.items():
        for o in objs:
            owner[o.name] = k
    saved = {}
    for o in bpy.context.scene.objects:
        if o.type != 'MESH':
            continue
        saved[o.name] = list(o.data.materials)
        o.data.materials.clear()
        if o.name == SCREENS['synth-screen'].name:
            o.data.materials.append(screen_mat)
        elif o.name in owner:
            o.data.materials.append(ids[owner[o.name]])
        else:
            o.data.materials.append(black)
    return saved


def restore_materials(saved):
    for o in bpy.context.scene.objects:
        if o.name in saved:
            o.data.materials.clear()
            for m in saved[o.name]:
                o.data.materials.append(m)


def setup_render(samples, preview):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = True
    scene.cycles.device = 'GPU'
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.006 if not preview else 0.05
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    scene.cycles.max_bounces = 8
    scene.cycles.diffuse_bounces = 5
    scene.cycles.glossy_bounces = 4
    scene.cycles.transmission_bounces = 8
    scene.cycles.sample_clamp_indirect = 0.0
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.render.resolution_x = WIDTH
    scene.render.resolution_y = HEIGHT
    scene.render.resolution_percentage = 50 if preview else 100
    scene.render.film_transparent = False
    scene.render.use_persistent_data = True


def render_to(path, fmt):
    scene = bpy.context.scene
    s = scene.render.image_settings
    if fmt == 'HDR':
        s.file_format = 'HDR'
        scene.view_settings.view_transform = 'Standard'
    elif fmt == 'MASK':
        s.file_format = 'PNG'
        s.color_mode = 'RGB'
        s.color_depth = '8'
        scene.view_settings.view_transform = 'Standard'
        scene.view_settings.look = 'None'
    else:  # preview
        s.file_format = 'PNG'
        s.color_mode = 'RGB'
        s.color_depth = '8'
        scene.view_settings.view_transform = 'AgX'
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    reset()
    make_materials()
    build_room()
    build_lamp()
    build_desk()
    build_ac()
    build_shelf()
    build_lights()
    scene = bpy.context.scene
    cams = {k: make_camera(f'cam_{k}', v['pos'], v['target']) for k, v in VIEWS.items()}
    os.makedirs(OUT, exist_ok=True)
    setup_render(64 if PREVIEW else SAMPLES, PREVIEW)
    views = [v for v in VIEWS if not ONLY_VIEW or v == ONLY_VIEW]
    meta = {'v': 1, 'generator': 'apps/sim/scene/room.py', 'blender': bpy.app.version_string, 'width': WIDTH, 'height': HEIGHT,
            'space': 'local-floor', 'room': {'size': to_xr_vec((W, H, D)), 'note': 'interior x 0..3.6 m, y (up) 0..2.4 m, z 0..-3.6 m'},
            'layers': ['sky', 'lamp', 'night'], 'samples': SAMPLES, 'views': {}, 'devices': {}, 'maskIds': MASK_IDS}
    for k, objs in DEVICES.items():
        lo, hi = world_bbox(objs)
        meta['devices'][k] = {'center': to_xr_vec((lo + hi) / 2), 'size': [round(abs(c), 4) for c in (B2X @ (hi - lo))]}
    for v in views:
        cam = cams[v]
        scene.camera = cam
        bpy.context.view_layer.update()
        vdir = os.path.join(OUT, v)
        os.makedirs(vdir, exist_ok=True)
        meta['views'][v] = {
            'pose': to_xr_pose(cam),
            'intrinsics': {'fx': FX, 'fy': FX, 'cx': WIDTH / 2, 'cy': HEIGHT / 2, 'width': WIDTH, 'height': HEIGHT},
            'fovYDeg': round(math.degrees(2 * math.atan(HEIGHT / 2 / FX)), 3),
            'screens': {sid: screen_quad(scene, cam, o) for sid, o in SCREENS.items()},
        }
        if PREVIEW:
            pl = arg('--preview-layer', 'full')
            set_layer(pl)
            scene.view_settings.exposure = float(arg('--preview-ev', 0))
            render_to(os.path.join(OUT, f'preview_{v}_{pl}.png'), 'PREVIEW')
            scene.view_settings.exposure = 0.0
            continue
        for layer in ('sky', 'lamp', 'night'):
            if MASKS_ONLY:
                break
            set_layer(layer)
            scene.cycles.samples = {'sky': SAMPLES * 3, 'lamp': SAMPLES, 'night': max(128, SAMPLES // 2)}[layer]
            render_to(os.path.join(vdir, f'{layer}.hdr'), 'HDR')
        scene.cycles.samples = SAMPLES
        # id mask: flat emission, 1 sample, no pixel filter
        saved = mask_materials()
        set_layer('sky')
        scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value = 0.0
        bpy.data.objects['fill'].hide_render = True
        samples, filt, den, bounces = scene.cycles.samples, scene.cycles.filter_width, scene.cycles.use_denoising, scene.cycles.max_bounces
        scene.cycles.samples, scene.cycles.filter_width, scene.cycles.use_denoising, scene.cycles.max_bounces = 1, 0.01, False, 0
        render_to(os.path.join(vdir, 'mask.png'), 'MASK')
        scene.cycles.samples, scene.cycles.filter_width, scene.cycles.use_denoising, scene.cycles.max_bounces = samples, filt, den, bounces
        restore_materials(saved)
    with open(os.path.join(OUT, 'scene.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    print('[room] wrote', OUT)


main()
