"""Regenerate the FCStd fixtures with a real FreeCAD.

    freecadcmd lib/fcstd-import/fixtures/generate.py

Set FCSTD_CASES to a comma-separated list of case names to write only those.

Each case is a small document FreeCAD solves and saves, so the shape it stores
for each Body is what the importer has to reproduce. The volumes printed are
FreeCAD's.
"""
import math
import os

import FreeCAD as App
import Part
import Sketcher

App.ParamGet("User parameter:BaseApp/Preferences/Document").SetBool("CreateBackupFiles", False)
OUT = os.environ.get("FCSTD_FIXTURES_OUT", os.path.dirname(os.path.abspath(__file__)))
V = App.Vector


def origin(body, role):
    for feature in body.Origin.OriginFeatures:
        if feature.Role == role:
            return feature
    raise KeyError(role)


def new_body(doc, name="Body"):
    return doc.addObject("PartDesign::Body", name)


def sketch_on(body, support, name="Sketch", offset=None):
    sketch = body.newObject("Sketcher::SketchObject", name)
    sketch.AttachmentSupport = support
    sketch.MapMode = "FlatFace"
    if offset is not None:
        sketch.AttachmentOffset = offset
    return sketch


def line(sketch, a, b, construction=False):
    return sketch.addGeometry(Part.LineSegment(V(a[0], a[1], 0), V(b[0], b[1], 0)), construction)


def rectangle(sketch, x0, y0, x1, y1):
    """Four lines, counter-clockwise from (x0, y0), joined and squared by constraints."""
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    first = None
    for i, a in enumerate(corners):
        g = line(sketch, a, corners[(i + 1) % 4])
        first = g if first is None else first
    for i in range(4):
        sketch.addConstraint(Sketcher.Constraint("Coincident", first + i, 2, first + (i + 1) % 4, 1))
    sketch.addConstraint(Sketcher.Constraint("Horizontal", first))
    sketch.addConstraint(Sketcher.Constraint("Horizontal", first + 2))
    sketch.addConstraint(Sketcher.Constraint("Vertical", first + 1))
    sketch.addConstraint(Sketcher.Constraint("Vertical", first + 3))
    return first


def circle(sketch, x, y, r, radius=True):
    g = sketch.addGeometry(Part.Circle(V(x, y, 0), V(0, 0, 1), r), False)
    if radius:
        sketch.addConstraint(Sketcher.Constraint("Radius", g, r))
    return g


def feature(body, kind, name, **props):
    f = body.newObject("PartDesign::" + kind, name)
    for key, value in props.items():
        setattr(f, key, value)
    return f


def block(body, w=30, h=20, d=10, name="Base"):
    """A w x h x d block from the origin up, sketched on XY with its sizes as dimensions."""
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], name + "Sketch")
    g = rectangle(sketch, 0, 0, w, h)
    sketch.addConstraint(Sketcher.Constraint("Coincident", g, 1, -1, 1))
    sketch.addConstraint(Sketcher.Constraint("DistanceX", g, 1, g, 2, w))
    sketch.addConstraint(Sketcher.Constraint("DistanceY", g + 1, 1, g + 1, 2, h))
    return feature(body, "Pad", name, Profile=sketch, Length=d)


def edges_where(shape, test):
    return ["Edge%d" % (i + 1) for i, e in enumerate(shape.Edges) if test(e)]


def vertical(e):
    a, b = e.Vertexes[0].Point, e.Vertexes[-1].Point
    return abs(a.x - b.x) < 1e-6 and abs(a.y - b.y) < 1e-6


def at_top(z):
    return lambda e: all(abs(v.Point.z - z) < 1e-6 for v in e.Vertexes)


# ---- sketches and their constraints ----


def constrained_plate(doc):
    """A dimensioned plate with a dimensioned hole: every constraint holds the stored geometry."""
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    g = rectangle(sketch, 0, 0, 40, 20)
    sketch.addConstraint(Sketcher.Constraint("Coincident", g, 1, -1, 1))
    sketch.addConstraint(Sketcher.Constraint("DistanceX", g, 1, g, 2, 40))
    sketch.addConstraint(Sketcher.Constraint("DistanceY", g + 1, 1, g + 1, 2, 20))
    c = circle(sketch, 30, 10, 4)
    sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, c, 3, 30))
    sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, c, 3, 10))
    feature(body, "Pad", "Pad", Profile=sketch, Length=10)


def slot(doc):
    """Two lines and two arcs joined tangent, the lines equal and symmetric about the V axis."""
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    a = line(sketch, (-10, -5), (10, -5))
    b = line(sketch, (10, 5), (-10, 5))
    r = sketch.addGeometry(Part.ArcOfCircle(Part.Circle(V(10, 0, 0), V(0, 0, 1), 5), -math.pi / 2, math.pi / 2), False)
    l = sketch.addGeometry(Part.ArcOfCircle(Part.Circle(V(-10, 0, 0), V(0, 0, 1), 5), math.pi / 2, 3 * math.pi / 2), False)
    sketch.addConstraint(Sketcher.Constraint("Tangent", a, 2, r, 1))
    sketch.addConstraint(Sketcher.Constraint("Tangent", r, 2, b, 1))
    sketch.addConstraint(Sketcher.Constraint("Tangent", b, 2, l, 1))
    sketch.addConstraint(Sketcher.Constraint("Tangent", l, 2, a, 1))
    sketch.addConstraint(Sketcher.Constraint("Equal", r, l))
    sketch.addConstraint(Sketcher.Constraint("Symmetric", a, 1, a, 2, -2))
    sketch.addConstraint(Sketcher.Constraint("PointOnObject", r, 3, -1))
    sketch.addConstraint(Sketcher.Constraint("Radius", r, 5))
    sketch.addConstraint(Sketcher.Constraint("Distance", a, 20))
    feature(body, "Pad", "Pad", Profile=sketch, Length=3)


def angled(doc):
    """A triangle with an angle, a perpendicular and a parallel line inside it, and a diameter."""
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    a = line(sketch, (0, 0), (30, 0))
    b = line(sketch, (30, 0), (30, 20))
    c = line(sketch, (30, 20), (0, 0))
    for x, y in ((a, b), (b, c), (c, a)):
        sketch.addConstraint(Sketcher.Constraint("Coincident", x, 2, y, 1))
    sketch.addConstraint(Sketcher.Constraint("Coincident", a, 1, -1, 1))
    sketch.addConstraint(Sketcher.Constraint("PointOnObject", a, 2, -1))
    sketch.addConstraint(Sketcher.Constraint("Perpendicular", a, b))
    sketch.addConstraint(Sketcher.Constraint("DistanceX", a, 1, a, 2, 30))
    sketch.addConstraint(Sketcher.Constraint("Angle", a, 1, c, 2, math.atan2(20, 30)))
    d = sketch.addGeometry(Part.Circle(V(22, 6, 0), V(0, 0, 1), 3), False)
    sketch.addConstraint(Sketcher.Constraint("Diameter", d, 6))
    e = line(sketch, (12, 2), (20, 2), True)
    sketch.addConstraint(Sketcher.Constraint("Parallel", e, a))
    feature(body, "Pad", "Pad", Profile=sketch, Length=4)


# ---- pads and pockets ----


def plane_xz(doc):
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XZ_Plane"), "")])
    rectangle(sketch, 2, 3, 12, 8)
    feature(body, "Pad", "Pad", Profile=sketch, Length=7)


def plane_yz(doc):
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "YZ_Plane"), "")])
    rectangle(sketch, 2, 3, 12, 8)
    feature(body, "Pad", "Pad", Profile=sketch, Length=7)


def pad_symmetric(doc):
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    rectangle(sketch, 0, 0, 10, 10)
    feature(body, "Pad", "Pad", Profile=sketch, Length=6, SideType="Symmetric")


def pad_two_lengths(doc):
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    rectangle(sketch, 0, 0, 10, 10)
    feature(body, "Pad", "Pad", Profile=sketch, Length=6, Length2=2, SideType="Two sides")


def pad_taper(doc):
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    rectangle(sketch, 0, 0, 20, 20)
    feature(body, "Pad", "Pad", Profile=sketch, Length=5, TaperAngle=-10)


def pocket_through_all(doc):
    body = new_body(doc)
    block(body)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "Tool", App.Placement(V(0, 0, 10), App.Rotation()))
    circle(sketch, 15, 10, 4)
    feature(body, "Pocket", "Pocket", Profile=sketch, Type="ThroughAll")


def pocket_reversed(doc):
    body = new_body(doc)
    block(body)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "Tool")
    rectangle(sketch, 5, 5, 15, 15)
    feature(body, "Pocket", "Pocket", Profile=sketch, Length=4, Reversed=True)


def multi_loop(doc):
    """An outline with two holes and a separate island in one sketch."""
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    rectangle(sketch, 0, 0, 40, 30)
    circle(sketch, 10, 15, 4)
    rectangle(sketch, 22, 8, 34, 22)
    circle(sketch, 28, 15, 3)
    feature(body, "Pad", "Pad", Profile=sketch, Length=5)


def body_placement(doc):
    body = new_body(doc)
    block(body)
    body.Placement = App.Placement(V(100, 200, 300), App.Rotation(V(0, 0, 1), 90))


def sketch_offset(doc):
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "Sketch", App.Placement(V(1, 2, 3), App.Rotation(V(1, 0, 0), 30)))
    rectangle(sketch, 0, 0, 10, 5)
    feature(body, "Pad", "Pad", Profile=sketch, Length=4)


def sketch_on_face(doc):
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    top = next("Face%d" % (i + 1) for i, f in enumerate(base.Shape.Faces) if abs(f.CenterOfMass.z - 10) < 1e-6)
    sketch = sketch_on(body, [(base, top)], "OnTop")
    circle(sketch, 5, 5, 3)
    feature(body, "Pad", "Boss", Profile=sketch, Length=6)


def datum_plane(doc):
    body = new_body(doc)
    block(body)
    datum = body.newObject("PartDesign::Plane", "DatumPlane")
    datum.AttachmentSupport = [(origin(body, "XY_Plane"), "")]
    datum.MapMode = "FlatFace"
    datum.AttachmentOffset = App.Placement(V(0, 0, 20), App.Rotation(V(0, 1, 0), 20))
    sketch = sketch_on(body, [(datum, "")], "OnDatum")
    rectangle(sketch, -4, -4, 4, 4)
    feature(body, "Pad", "Boss", Profile=sketch, Length=5)


def second_body(doc):
    block(new_body(doc, "First"))
    body = new_body(doc, "Second")
    sketch = sketch_on(body, [(origin(body, "XZ_Plane"), "")])
    rectangle(sketch, 0, 0, 8, 6)
    feature(body, "Pad", "Pad", Profile=sketch, Length=3)


# ---- revolutions ----


def ring_sketch(body):
    sketch = sketch_on(body, [(origin(body, "XZ_Plane"), "")])
    rectangle(sketch, 10, 0, 16, 8)
    return sketch


def revolution_partial(doc):
    body = new_body(doc)
    sketch = ring_sketch(body)
    feature(body, "Revolution", "Revolution", Profile=sketch, ReferenceAxis=(sketch, ["V_Axis"]), Angle=100)


def revolution_two_angles(doc):
    body = new_body(doc)
    sketch = ring_sketch(body)
    feature(body, "Revolution", "Revolution", Profile=sketch, ReferenceAxis=(sketch, ["V_Axis"]), Type="TwoAngles", Angle=70, Angle2=30)


def revolution_construction_axis(doc):
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    rectangle(sketch, 2, 0, 6, 5)
    line(sketch, (-3, -9), (-3, 9), True)
    feature(body, "Revolution", "Revolution", Profile=sketch, ReferenceAxis=(sketch, ["Axis0"]), Angle=90)


def groove_partial(doc):
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "BaseSketch")
    circle(sketch, 0, 0, 20)
    feature(body, "Pad", "Base", Profile=sketch, Length=30)
    tool = sketch_on(body, [(origin(body, "XZ_Plane"), "")], "GrooveSketch")
    rectangle(tool, 15, 10, 25, 18)
    feature(body, "Groove", "Groove", Profile=tool, ReferenceAxis=(tool, ["V_Axis"]), Angle=100)


# ---- dress-up features ----


def fillet(doc):
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    feature(body, "Fillet", "Fillet", Base=(base, edges_where(base.Shape, vertical)), Radius=2)


def fillet_past_tip(doc):
    """Rolled back to the block: the fillet after it is not in the Body's shape, and names edges of a shape that is."""
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    feature(body, "Fillet", "Fillet", Base=(base, edges_where(base.Shape, vertical)), Radius=2)
    doc.recompute()
    body.Tip = base


def chamfer(doc):
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    feature(body, "Chamfer", "Chamfer", Base=(base, edges_where(base.Shape, at_top(10))), Size=1)


def fillet_after_pocket(doc):
    """A fillet on the edges of a pocket, whose edges exist only after the cut."""
    body = new_body(doc)
    block(body)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "Tool", App.Placement(V(0, 0, 10), App.Rotation()))
    rectangle(sketch, 10, 5, 20, 15)
    cut = feature(body, "Pocket", "Pocket", Profile=sketch, Length=4)
    doc.recompute()
    inner = lambda e: vertical(e) and 9 < e.Vertexes[0].Point.x < 21 and 4 < e.Vertexes[0].Point.y < 16
    feature(body, "Fillet", "Fillet", Base=(cut, edges_where(cut.Shape, inner)), Radius=1)


# ---- holes ----


def hole_sketch(body, name="HoleSketch"):
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], name, App.Placement(V(0, 0, 10), App.Rotation()))
    circle(sketch, 8, 10, 2.5, radius=False)
    circle(sketch, 22, 10, 2.5, radius=False)
    body.Document.recompute()
    return sketch


def hole_reversed(doc):
    """Holes drilled up from the bottom face, off the middle so a mirrored position would miss."""
    body = new_body(doc)
    block(body)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "HoleSketch")
    circle(sketch, 8, 6, 2.5, radius=False)
    circle(sketch, 22, 6, 2.5, radius=False)
    doc.recompute()
    feature(body, "Hole", "Hole", Profile=sketch, Diameter=5, Depth=6, DepthType="Dimension", DrillPoint="Flat", Reversed=True, Threaded=False)


def hole_through(doc):
    body = new_body(doc)
    block(body)
    feature(body, "Hole", "Hole", Profile=hole_sketch(body), Diameter=5, DepthType="ThroughAll", Threaded=False)


def hole_threaded(doc):
    """A tapped hole with no modelled thread: FreeCAD drills it at the tap drill."""
    body = new_body(doc)
    block(body)
    feature(body, "Hole", "Hole", Profile=hole_sketch(body), DepthType="ThroughAll", Threaded=True, ThreadType="ISOMetricProfile", ThreadSize="M6x1.0", ThreadClass="6H", ModelThread=False)


def hole_model_thread(doc):
    body = new_body(doc)
    block(body)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "HoleSketch", App.Placement(V(0, 0, 10), App.Rotation()))
    circle(sketch, 15, 10, 2.5, radius=False)
    doc.recompute()
    feature(body, "Hole", "Hole", Profile=sketch, DepthType="ThroughAll", Threaded=True, ThreadType="ISOMetricProfile", ThreadSize="M6x1.0", ThreadClass="6H", ModelThread=True)


def hole_model_thread_blind(doc):
    body = new_body(doc)
    block(body)
    feature(body, "Hole", "Hole", Profile=hole_sketch(body), Depth=6, DepthType="Dimension", DrillPoint="Flat", Threaded=True, ThreadType="ISOMetricProfile", ThreadSize="M6x1.0", ThreadClass="6H", ModelThread=True)


def hole_blind(doc):
    body = new_body(doc)
    block(body)
    feature(body, "Hole", "Hole", Profile=hole_sketch(body), Diameter=5, Depth=6, DepthType="Dimension", DrillPoint="Angled", DrillPointAngle=118, Threaded=False)


def hole_counterbore(doc):
    body = new_body(doc)
    block(body)
    h = feature(body, "Hole", "Hole", Profile=hole_sketch(body), Diameter=5, DepthType="ThroughAll", Threaded=False)
    h.HoleCutType = "Counterbore"
    h.HoleCutDiameter = 9
    h.HoleCutDepth = 3


def hole_countersink(doc):
    body = new_body(doc)
    block(body)
    h = feature(body, "Hole", "Hole", Profile=hole_sketch(body), Diameter=5, DepthType="ThroughAll", Threaded=False)
    h.HoleCutType = "Countersink"
    h.HoleCutDiameter = 9
    h.HoleCutCountersinkAngle = 90


# ---- patterns and mirrors ----


def notch(body, name="Notch"):
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], name + "Sketch", App.Placement(V(0, 0, 10), App.Rotation()))
    rectangle(sketch, 3, 3, 6, 6)
    return feature(body, "Pocket", name, Profile=sketch, Length=3)


def linear_pattern(doc):
    body = new_body(doc)
    block(body)
    cut = notch(body)
    body.Tip = feature(body, "LinearPattern", "LinearPattern", Originals=[cut], Direction=(origin(body, "X_Axis"), [""]), Length=16, Occurrences=3)


def polar_pattern(doc):
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "BaseSketch")
    circle(sketch, 0, 0, 20)
    feature(body, "Pad", "Base", Profile=sketch, Length=8)
    tool = sketch_on(body, [(origin(body, "XY_Plane"), "")], "ToolSketch", App.Placement(V(0, 0, 8), App.Rotation()))
    circle(tool, 14, 0, 2)
    cut = feature(body, "Pocket", "Pocket", Profile=tool, Type="ThroughAll")
    body.Tip = feature(body, "PolarPattern", "PolarPattern", Originals=[cut], Axis=(origin(body, "Z_Axis"), [""]), Angle=360, Occurrences=6)


def mirrored(doc):
    """A boss on one side of a block across the YZ plane, mirrored to the other."""
    body = new_body(doc)
    base = sketch_on(body, [(origin(body, "XY_Plane"), "")], "BaseSketch")
    rectangle(base, -15, 0, 15, 20)
    feature(body, "Pad", "Base", Profile=base, Length=10)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "BossSketch", App.Placement(V(0, 0, 10), App.Rotation()))
    circle(sketch, 6, 10, 3)
    boss = feature(body, "Pad", "Boss", Profile=sketch, Length=4)
    body.Tip = feature(body, "Mirrored", "Mirrored", Originals=[boss], MirrorPlane=(origin(body, "YZ_Plane"), [""]))


# ---- bases, faces, chains and other workbenches ----


def pad_on_face(doc):
    """A pad of the top face of a block, not of a sketch."""
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    top = next("Face%d" % (i + 1) for i, f in enumerate(base.Shape.Faces) if abs(f.CenterOfMass.z - 10) < 1e-6)
    feature(body, "Pad", "OnFace", Profile=(base, [top]), Length=3)


def pad_face_up_to_datum(doc):
    """A pad of a block's top face up to a datum plane, with no length of its own."""
    body = new_body(doc)
    base = block(body)
    plane = body.newObject("PartDesign::Plane", "Stop")
    plane.AttachmentSupport = [(origin(body, "XY_Plane"), "")]
    plane.MapMode = "FlatFace"
    plane.AttachmentOffset = App.Placement(V(0, 0, 25), App.Rotation())
    doc.recompute()
    top = next("Face%d" % (i + 1) for i, f in enumerate(base.Shape.Faces) if abs(f.CenterOfMass.z - 10) < 1e-6)
    feature(body, "Pad", "OnFace", Profile=(base, [top]), Type=3, UpToFace=(plane, [""]), Length=0)


def fillet_then_chamfer(doc):
    """A chamfer on edges of a fillet: the second rounds what the first made."""
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    first = feature(body, "Fillet", "Fillet", Base=(base, edges_where(base.Shape, vertical)), Radius=2)
    doc.recompute()
    feature(body, "Chamfer", "Chamfer", Base=(first, edges_where(first.Shape, at_top(10))), Size=0.5)


def base_feature(doc):
    """A Body that starts from a Part workbench box."""
    stock = doc.addObject("Part::Box", "Stock")
    stock.Length, stock.Width, stock.Height = 40, 30, 10
    body = new_body(doc)
    body.BaseFeature = stock
    doc.recompute()
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "Tool", App.Placement(V(0, 0, 10), App.Rotation()))
    circle(sketch, 20, 15, 5)
    feature(body, "Pocket", "Pocket", Profile=sketch, Length=4)


def part_workbench(doc):
    """No Body at all: a box with a cylinder cut from it, in the Part workbench."""
    box = doc.addObject("Part::Box", "Box")
    box.Length, box.Width, box.Height = 20, 20, 20
    cylinder = doc.addObject("Part::Cylinder", "Cylinder")
    cylinder.Radius, cylinder.Height = 5, 30
    cylinder.Placement = App.Placement(V(10, 10, -5), App.Rotation())
    cut = doc.addObject("Part::Cut", "Cut")
    cut.Base, cut.Tool = box, cylinder
    box.Visibility = cylinder.Visibility = False


def primitives(doc):
    """PartDesign primitives: a box, a cylinder cut from it, a cone on top."""
    body = new_body(doc)
    feature(body, "AdditiveBox", "Box", Length=30, Width=20, Height=10)
    doc.recompute()
    hole = feature(body, "SubtractiveCylinder", "Hole", Radius=4, Height=10)
    hole.Placement = App.Placement(V(15, 10, 0), App.Rotation())
    doc.recompute()
    cone = feature(body, "AdditiveCone", "Cone", Radius1=4, Radius2=2, Height=6)
    cone.Placement = App.Placement(V(5, 5, 10), App.Rotation())


def symmetric_point(doc):
    """A rectangle held symmetric about the origin by two of its corners."""
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    g = rectangle(sketch, -10, -5, 10, 5)
    sketch.addConstraint(Sketcher.Constraint("Symmetric", g, 1, g + 1, 2, -1, 1))
    sketch.addConstraint(Sketcher.Constraint("DistanceX", g, 1, g, 2, 20))
    sketch.addConstraint(Sketcher.Constraint("DistanceY", g + 1, 1, g + 1, 2, 10))
    feature(body, "Pad", "Pad", Profile=sketch, Length=4)


def pocket_up_to_face(doc):
    """A pocket down to the floor of an earlier slot, picked as a face."""
    body = new_body(doc)
    block(body)
    top = App.Placement(V(0, 0, 10), App.Rotation())
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "SlotSketch", top)
    rectangle(sketch, 20, 4, 28, 16)
    slot = feature(body, "Pocket", "Slot", Profile=sketch, Length=4)
    doc.recompute()
    floor = next("Face%d" % (i + 1) for i, f in enumerate(slot.Shape.Faces) if abs(f.CenterOfMass.z - 6) < 1e-6)
    tool = sketch_on(body, [(origin(body, "XY_Plane"), "")], "ToolSketch", top)
    rectangle(tool, 2, 4, 10, 16)
    feature(body, "Pocket", "ToFloor", Profile=tool, Type="UpToFace", UpToFace=(slot, [floor]))


def lofted(body, name, kind, **props):
    low = sketch_on(body, [(origin(body, "XY_Plane"), "")], name + "Low")
    rectangle(low, 0, 0, 20, 20)
    high = sketch_on(body, [(origin(body, "XY_Plane"), "")], name + "High", App.Placement(V(0, 0, 15), App.Rotation()))
    high.addGeometry(Part.Circle(V(10, 10, 0), V(0, 0, 1), 5), False)
    body.Document.recompute()
    return feature(body, kind, name, Profile=low, Sections=[high], **props)


def loft(doc):
    """A square lofted up to a circle."""
    lofted(new_body(doc), "Loft", "AdditiveLoft")


def loft_ruled(doc):
    lofted(new_body(doc), "Loft", "AdditiveLoft", Ruled=True)


def loft_cut(doc):
    """A loft cut from a block sized to hold it."""
    body = new_body(doc)
    block(body, 40, 40, 30)
    low = sketch_on(body, [(origin(body, "XY_Plane"), "")], "Low", App.Placement(V(0, 0, 30), App.Rotation()))
    rectangle(low, 10, 10, 30, 30)
    high = sketch_on(body, [(origin(body, "XY_Plane"), "")], "High", App.Placement(V(0, 0, 15), App.Rotation()))
    high.addGeometry(Part.Circle(V(20, 20, 0), V(0, 0, 1), 5), False)
    doc.recompute()
    feature(body, "SubtractiveLoft", "Loft", Profile=low, Sections=[high])


def piped(body, kind):
    profile = sketch_on(body, [(origin(body, "XY_Plane"), "")], "Section")
    profile.addGeometry(Part.Circle(V(0, 0, 0), V(0, 0, 1), 2), False)
    spine = sketch_on(body, [(origin(body, "XZ_Plane"), "")], "Spine")
    a = line(spine, (0, 0), (0, 20))
    r = spine.addGeometry(Part.ArcOfCircle(Part.Circle(V(10, 20, 0), V(0, 0, 1), 10), math.pi / 2, math.pi), False)
    spine.addConstraint(Sketcher.Constraint("Coincident", a, 2, r, 2))
    body.Document.recompute()
    return feature(body, kind, "Pipe", Profile=profile, Spine=spine)


def pipe(doc):
    """A circle along a line and an arc."""
    piped(new_body(doc), "AdditivePipe")


def pipe_edges(doc):
    """A section run along edges of a block."""
    body = new_body(doc)
    base = block(body, 40, 40, 10)
    doc.recompute()
    edge = next("Edge%d" % (i + 1) for i, e in enumerate(base.Shape.Edges) if abs(e.CenterOfMass.y) < 1e-6 and abs(e.CenterOfMass.z - 10) < 1e-6)
    profile = sketch_on(body, [(origin(body, "YZ_Plane"), "")], "Section", App.Placement(V(0, 0, 0), App.Rotation()))
    rectangle(profile, -2, 8, 2, 12)
    doc.recompute()
    feature(body, "SubtractivePipe", "Pipe", Profile=profile, Spine=(base, [edge]))


def thickness_inward(doc):
    """A block hollowed from its top."""
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    top = next("Face%d" % (i + 1) for i, f in enumerate(base.Shape.Faces) if abs(f.CenterOfMass.z - 10) < 1e-6)
    feature(body, "Thickness", "Shell", Base=(base, [top]), Value=2, Reversed=True, Join="Intersection")


def draft_faces(doc):
    """Two opposite walls of a block drafted about its bottom."""
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    walls = ["Face%d" % (i + 1) for i, f in enumerate(base.Shape.Faces) if abs(f.CenterOfMass.x) < 1e-6 or abs(f.CenterOfMass.x - 30) < 1e-6]
    feature(body, "Draft", "Draft", Base=(base, walls), Angle=5, NeutralPlane=(origin(body, "XY_Plane"), [""]))


def multi_transform(doc):
    """A pocket patterned along x, then each copy along y, in one feature."""
    body = new_body(doc)
    block(body, 60, 40, 5)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "HoleSketch", App.Placement(V(0, 0, 5), App.Rotation()))
    circle(sketch, 10, 10, 3, radius=False)
    doc.recompute()
    pocket = feature(body, "Pocket", "Hole", Profile=sketch, Type="ThroughAll")
    doc.recompute()
    first = body.newObject("PartDesign::LinearPattern", "AlongX")
    first.Direction = (origin(body, "X_Axis"), [""])
    first.Length = 40
    first.Occurrences = 3
    second = body.newObject("PartDesign::LinearPattern", "AlongY")
    second.Direction = (origin(body, "Y_Axis"), [""])
    second.Length = 20
    second.Occurrences = 2
    multi = body.newObject("PartDesign::MultiTransform", "Both")
    multi.Originals = [pocket]
    multi.Transformations = [first, second]
    body.Tip = multi


def multi_transform_mirror(doc):
    """A pocket patterned along x, then mirrored in a plane."""
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "Plate")
    rectangle(sketch, -30, -20, 30, 20)
    feature(body, "Pad", "Plate", Profile=sketch, Length=5)
    hole = sketch_on(body, [(origin(body, "XY_Plane"), "")], "HoleSketch", App.Placement(V(0, 0, 5), App.Rotation()))
    circle(hole, 8, 10, 3, radius=False)
    doc.recompute()
    pocket = feature(body, "Pocket", "Hole", Profile=hole, Type="ThroughAll")
    doc.recompute()
    first = body.newObject("PartDesign::LinearPattern", "AlongX")
    first.Direction = (origin(body, "X_Axis"), [""])
    first.Length = 12
    first.Occurrences = 2
    second = body.newObject("PartDesign::Mirrored", "Across")
    second.MirrorPlane = (origin(body, "YZ_Plane"), [""])
    multi = body.newObject("PartDesign::MultiTransform", "Both")
    multi.Originals = [pocket]
    multi.Transformations = [first, second]
    body.Tip = multi


def helixed(body, kind, **props):
    sketch = sketch_on(body, [(origin(body, "XZ_Plane"), "")], "Section")
    sketch.addGeometry(Part.Circle(V(10, 0, 0), V(0, 0, 1), 1), False)
    body.Document.recompute()
    return feature(body, kind, "Helix", Profile=sketch, ReferenceAxis=(sketch, ["V_Axis"]), Pitch=5, Height=20, **props)


def helix(doc):
    """A spring: a circle along a helix about the sketch's V axis."""
    helixed(new_body(doc), "AdditiveHelix")


def helix_left(doc):
    helixed(new_body(doc), "AdditiveHelix", LeftHanded=True)


def partial_primitives(doc):
    """A quarter of a cylinder, with a half cone and a cap of a sphere on it."""
    body = new_body(doc)
    feature(body, "AdditiveCylinder", "Cylinder", Radius=10, Height=5, Angle=90)
    doc.recompute()
    cone = feature(body, "AdditiveCone", "Cone", Radius1=8, Radius2=3, Height=6, Angle=180)
    cone.Placement = App.Placement(V(0, 0, 5), App.Rotation())
    doc.recompute()
    sphere = feature(body, "AdditiveSphere", "Sphere", Radius=6, Angle1=0, Angle3=270)
    sphere.Placement = App.Placement(V(0, 0, 11), App.Rotation())


def prism(doc):
    body = new_body(doc)
    feature(body, "AdditivePrism", "Prism", Polygon=6, Circumradius=8, Height=12)


def pad_custom_direction(doc):
    """A pad along a direction leaning off the sketch normal."""
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    rectangle(sketch, 0, 0, 10, 10)
    doc.recompute()
    feature(body, "Pad", "Pad", Profile=sketch, Length=10, UseCustomVector=True, Direction=V(1, 0, 1), AlongSketchNormal=False)


def part_container(doc):
    """A Body in a moved App::Part, and a Link placing it again."""
    container = doc.addObject("App::Part", "Part")
    container.Placement = App.Placement(V(0, 0, 50), App.Rotation())
    body = new_body(doc)
    container.addObject(body)
    block(body)
    body.Placement = App.Placement(V(10, 0, 0), App.Rotation())
    doc.recompute()
    copy = doc.addObject("App::Link", "Copy")
    copy.LinkedObject = body
    copy.Placement = App.Placement(V(100, 0, 0), App.Rotation())


def parameters_sheet(doc):
    """A plate sized from a spreadsheet: a sketch dimension, its pad and a formula cell."""
    sheet = doc.addObject("Spreadsheet::Sheet", "Sizes")
    sheet.set("A1", "width")
    sheet.set("B1", "=40 mm")
    sheet.setAlias("B1", "width")
    sheet.set("A2", "thick")
    sheet.set("B2", "=5 mm")
    sheet.setAlias("B2", "thick")
    sheet.set("B3", "=width / 2")
    sheet.setAlias("B3", "half")
    doc.recompute()
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    g = rectangle(sketch, 0, 0, 40, 20)
    sketch.addConstraint(Sketcher.Constraint("Coincident", g, 1, -1, 1))
    wide = sketch.addConstraint(Sketcher.Constraint("DistanceX", g, 1, g, 2, 40))
    sketch.renameConstraint(wide, "Width")
    high = sketch.addConstraint(Sketcher.Constraint("DistanceY", g + 1, 1, g + 1, 2, 20))
    sketch.setExpression("Constraints.Width", "Sizes.width")
    sketch.setExpression("Constraints[%d]" % high, "Sizes.half")
    pad = feature(body, "Pad", "Pad", Profile=sketch)
    pad.setExpression("Length", "Sizes.thick * 2")


def chamfer_two_sizes(doc):
    """One top edge of a block, cut 3 by 1, FreeCAD choosing which face takes which."""
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    edge = next("Edge%d" % (i + 1) for i, e in enumerate(base.Shape.Edges) if abs(e.CenterOfMass.y) < 1e-6 and abs(e.CenterOfMass.z - 10) < 1e-6)
    feature(body, "Chamfer", "Chamfer", Base=(base, [edge]), ChamferType="Two distances", Size=3, Size2=1)


def chamfer_flipped(doc):
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    edge = next("Edge%d" % (i + 1) for i, e in enumerate(base.Shape.Edges) if abs(e.CenterOfMass.y) < 1e-6 and abs(e.CenterOfMass.z - 10) < 1e-6)
    feature(body, "Chamfer", "Chamfer", Base=(base, [edge]), ChamferType="Two distances", Size=3, Size2=1, FlipDirection=True)


def expression_between_features(doc):
    """A pocket half as deep as the pad it cuts, by an expression."""
    body = new_body(doc)
    pad = block(body, d=12)
    doc.recompute()
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "SlotSketch", App.Placement(V(0, 0, 12), App.Rotation()))
    rectangle(sketch, 5, 5, 15, 15)
    pocket = feature(body, "Pocket", "Slot", Profile=sketch)
    pocket.setExpression("Length", "Base.Length / 2")


def revolution_symmetric(doc):
    """A quarter turn, half of it either side of the sketch."""
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XZ_Plane"), "")])
    rectangle(sketch, 5, 0, 10, 10)
    feature(body, "Revolution", "Revolution", Profile=sketch, ReferenceAxis=(sketch, ["V_Axis"]), Angle=90, Midplane=True)


def revolution_projected(doc):
    """A partial revolve about the H axis of a sketch off the origin plane."""
    body = new_body(doc)
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], offset=App.Placement(V(0, 0, 4), App.Rotation()))
    rectangle(sketch, 2, 5, 12, 15)
    feature(body, "Revolution", "Revolution", Profile=sketch, ReferenceAxis=(sketch, ["H_Axis"]), Angle=120)


def pad_up_to_datum(doc):
    """A pad up to a tilted datum plane."""
    body = new_body(doc)
    plane = body.newObject("PartDesign::Plane", "Stop")
    plane.AttachmentSupport = [(origin(body, "XY_Plane"), "")]
    plane.MapMode = "FlatFace"
    plane.AttachmentOffset = App.Placement(V(0, 0, 20), App.Rotation(V(1, 0, 0), 20))
    doc.recompute()
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")])
    rectangle(sketch, 0, 0, 10, 10)
    doc.recompute()
    feature(body, "Pad", "Pad", Profile=sketch, Type=3, UpToFace=(plane, [""]))


def pocket_up_to_datum_behind(doc):
    """A pocket whose datum plane lies behind its sketch, away from where a pocket runs."""
    body = new_body(doc)
    base = block(body, 30, 20, 30)
    plane = body.newObject("PartDesign::Plane", "Stop")
    plane.AttachmentSupport = [(origin(body, "XY_Plane"), "")]
    plane.MapMode = "FlatFace"
    plane.AttachmentOffset = App.Placement(V(0, 0, 25), App.Rotation())
    doc.recompute()
    sketch = sketch_on(body, [(origin(body, "XY_Plane"), "")], "PocketSketch", App.Placement(V(0, 0, 10), App.Rotation()))
    rectangle(sketch, 5, 5, 15, 15)
    doc.recompute()
    feature(body, "Pocket", "Pocket", Profile=sketch, Type=3, UpToFace=(plane, [""]))


def chamfer_on_face(doc):
    """A chamfer that names a face: all of its edges."""
    body = new_body(doc)
    base = block(body)
    doc.recompute()
    top = [i + 1 for i, f in enumerate(base.Shape.Faces) if abs(f.CenterOfMass.z - 10) < 1e-6]
    feature(body, "Chamfer", "Chamfer", Base=(base, ["Face%d" % top[0]]), Size=2)


def boolean_bodies(doc):
    """One Body cut by another, moved, as PartDesign's Boolean does."""
    tool = new_body(doc, "Tool")
    block(tool, 10, 10, 30)
    tool.Placement = App.Placement(V(5, 5, -5), App.Rotation())
    body = new_body(doc, "Body")
    block(body)
    doc.recompute()
    cut = body.newObject("PartDesign::Boolean", "Boolean")
    cut.Type = "Cut"
    cut.addObject(tool)
    doc.recompute()
    tool.Visibility = False


def link_shapes(doc):
    """An assembly's shape: Part workbench shapes in a group, placed by links, one of them twice."""
    group = doc.addObject("App::DocumentObjectGroup", "Shapes")
    box = doc.addObject("Part::Box", "Box")
    box.Length, box.Width, box.Height = 10, 20, 30
    box.Placement = App.Placement(V(5, 0, 0), App.Rotation())
    pin = doc.addObject("Part::Cylinder", "Pin")
    pin.Radius, pin.Height = 2, 40
    group.addObject(box)
    group.addObject(pin)
    assembly = doc.addObject("App::Part", "Assembly")
    assembly.Placement = App.Placement(V(0, 0, 100), App.Rotation())
    doc.recompute()
    for name, target, at in (("BoxA", box, V(100, 0, 0)), ("BoxB", box, V(200, 0, 0)), ("PinA", pin, V(0, 50, 0))):
        link = doc.addObject("App::Link", name)
        link.LinkedObject = target
        link.Placement = App.Placement(at, App.Rotation())
        assembly.addObject(link)


def group_shapes(doc):
    """Shapes shown from inside a group, beside an object that holds no shape."""
    group = doc.addObject("App::DocumentObjectGroup", "Shapes")
    box = doc.addObject("Part::Box", "Box")
    box.Length, box.Width, box.Height = 10, 20, 30
    hidden = doc.addObject("Part::Box", "Hidden")
    hidden.Placement = App.Placement(V(50, 0, 0), App.Rotation())
    group.addObject(box)
    group.addObject(hidden)
    group.addObject(doc.addObject("Part::Feature", "Nothing"))
    doc.recompute()
    hidden.Visibility = False


CASES = [
    constrained_plate, slot, angled, plane_xz, plane_yz, pad_symmetric, pad_two_lengths, pad_taper,
    pocket_through_all, pocket_reversed, multi_loop, body_placement, sketch_offset, sketch_on_face,
    datum_plane, second_body, revolution_partial, revolution_two_angles, revolution_construction_axis,
    groove_partial, fillet, chamfer, fillet_after_pocket, hole_through, hole_blind, hole_counterbore,
    hole_countersink, linear_pattern, polar_pattern, mirrored, pad_on_face, fillet_then_chamfer,
    base_feature, part_workbench, primitives, symmetric_point, pocket_up_to_face, hole_reversed,
    loft, loft_ruled, loft_cut, pipe, pipe_edges, thickness_inward, draft_faces, multi_transform,
    multi_transform_mirror, helix, helix_left, partial_primitives, prism, pad_custom_direction,
    part_container, parameters_sheet, chamfer_two_sizes, chamfer_flipped, expression_between_features,
    revolution_symmetric, revolution_projected, hole_threaded, hole_model_thread, hole_model_thread_blind,
    fillet_past_tip, pad_up_to_datum, pocket_up_to_datum_behind, chamfer_on_face, boolean_bodies, link_shapes,
    group_shapes, pad_face_up_to_datum,
]
ONLY = [c for c in os.environ.get("FCSTD_CASES", "").split(",") if c]

for case in CASES:
    if ONLY and case.__name__ not in ONLY:
        continue
    print("CASE", case.__name__)
    doc = App.newDocument(case.__name__)
    case(doc)
    doc.recompute()
    for obj in doc.Objects:
        if not obj.isValid():
            print("INVALID", case.__name__, obj.Name, obj.getStatusString())
    doc.saveAs(os.path.join(OUT, case.__name__ + ".FCStd"))
    for obj in doc.Objects:
        if obj.TypeId == "PartDesign::Body":
            box = obj.Shape.BoundBox
            print("%-28s %-7s vol=%10.3f" % (case.__name__, obj.Name, obj.Shape.Volume))
    App.closeDocument(doc.Name)
