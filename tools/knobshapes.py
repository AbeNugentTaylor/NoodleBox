"""Generates the SVG outlines for Noodle Box's masked knob caps.

Run `python3 tools/knobshapes.py` to print each path and write
tools/shapes-preview.html showing them all at 200px -- worth looking at before
wiring a new shape in, since a silhouette change that matters at 200px
can be invisible on a 36px knob. Paste the printed path into the
matching `.kwrap.shape-* .kdot` rule in style.css.
"""

import math
import os
C = 50.0

def f(x):
    s = "%.2f" % x
    return s.rstrip('0').rstrip('.') if '.' in s else s

def pt(r, ang):
    a = math.radians(ang)
    return (C + r*math.sin(a), C - r*math.cos(a))

def lobed(n, Rt, h, Rv, rTip=None, skew=0.0, start=0.0, tilt=0.0):
    """n arms. Tips sit at radius Rt with perpendicular half-width h, joined by
    valleys diving to radius Rv. rTip=None -> sharp points (h must be 0).
    skew rotates the valley low point off-centre, which leans the arms."""
    arms = []
    for i in range(n):
        a = start + i*360.0/n
        ar = math.radians(a)
        d = (math.sin(ar), -math.cos(ar))
        pr = math.radians(a + tilt)
        p = (math.cos(pr), math.sin(pr))
        cx, cy = C + Rt*d[0], C + Rt*d[1]
        arms.append((a, (cx - h*p[0], cy - h*p[1]), (cx + h*p[0], cy + h*p[1])))
    segs = ["M%s %s" % (f(arms[0][1][0]), f(arms[0][1][1]))]
    for i in range(n):
        a_i, _, dep = arms[i]
        if h > 0 and rTip:
            segs.append("A%s %s 0 0 1 %s %s" % (f(rTip), f(rTip), f(dep[0]), f(dep[1])))
        arr = arms[(i+1) % n][1]
        V = pt(Rv, a_i + (360.0/n)/2.0 + skew)
        # control point solved so the quadratic passes exactly through V
        ctrl = ((4*V[0] - dep[0] - arr[0])/2.0, (4*V[1] - dep[1] - arr[1])/2.0)
        segs.append("Q%s %s %s %s" % (f(ctrl[0]), f(ctrl[1]), f(arr[0]), f(arr[1])))
    return "".join(segs) + "Z"

def notched(n, R, rb, start=0.0):
    """A disc with n round bites taken out of the rim."""
    th = math.degrees(math.acos(1 - rb*rb/(2*R*R)))
    segs = []
    for i in range(n):
        m, mn = start + i*360.0/n, start + (i+1)*360.0/n
        p1, p2, p3 = pt(R, m+th), pt(R, mn-th), pt(R, mn+th)
        if not segs:
            segs.append("M%s %s" % (f(p1[0]), f(p1[1])))
        segs.append("A%s %s 0 0 1 %s %s" % (f(R), f(R), f(p2[0]), f(p2[1])))
        segs.append("A%s %s 0 0 0 %s %s" % (f(rb), f(rb), f(p3[0]), f(p3[1])))
    return "".join(segs) + "Z"

SHAPES = {
  # Only the caps that actually ship. lobed() will happily make five-point
  # stars, swept-blade pinwheels and the like -- they were tried and cut,
  # because an abstract graphic silhouette stops reading as a physical
  # object, which is the opposite of what these are for.
  "teardrop":  "M50 4C61 22 86 34 86 58A36 36 0 1 1 14 58C14 34 39 22 50 4Z",  # hand-drawn
  "trilobe":   lobed(3, 46, 15, 20, rTip=34),
  "scalloped": lobed(8, 40, 8, 29, rTip=13),
}

for k, v in SHAPES.items():
    print(k, "=>", v)

cells = "".join(
    "<figure><svg viewBox='0 0 100 100' width='200' height='200'>"
    "<path fill='#efe8d6' stroke='#c3b48f' stroke-width='0.75' d='%s'/></svg>"
    "<figcaption>%s</figcaption></figure>" % (v, k) for k, v in SHAPES.items())
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "shapes-preview.html"), "w").write(
  "<!doctype html><meta charset=utf-8><body style=\"margin:0;background:#e9e2d2;"
  "display:flex;flex-wrap:wrap;gap:6px;padding:16px;font:12px ui-monospace,monospace;color:#241f17\">"
  + cells.replace("<figure>", "<figure style='margin:0;text-align:center'>") + "</body>")
