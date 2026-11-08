"""Writes rounded-math.vectors.json: reference results for rounded-math.ts.

Every value is computed with mpmath at several thousand bits and rounded once
to the nearest double through an exact fraction. Run from this directory.
"""
import json
import math
import random
import struct
from fractions import Fraction

from mpmath import mp, mpf

mp.prec = 5000
random.seed(20261105)


def to_double(v):
    sign, man, exp, _ = v._mpf_
    f = Fraction(man) * Fraction(2) ** exp
    return float(-f if sign else f)


def bits(exp_lo, exp_hi):
    """A random double with a uniform exponent and a full random mantissa."""
    e = random.randint(exp_lo, exp_hi)
    return math.ldexp(1 + random.getrandbits(52) / 2**52, e) * random.choice((1, -1))


def near(x, ulps=3):
    out = [x]
    a = b = x
    for _ in range(ulps):
        a, b = math.nextafter(a, math.inf), math.nextafter(b, -math.inf)
        out += [a, b]
    return out


def trig_inputs():
    xs = [bits(-1021, 1023) for _ in range(300)]
    xs += [bits(-30, 12) for _ in range(500)]
    xs += [5e-324, 1e-320, 2.2250738585072014e-308, 1.7976931348623157e308]
    xs += [float(d) for d in range(-90, 91)]
    xs += [d + 0.5 for d in range(0, 360, 7)]
    # The angles with exact or near-exact values, and their neighbours.
    for d in (15, 30, 45, 60, 75, 90, 120, 135, 150, 180, 210, 225, 270, 315, 360, 720, 1e6, 2.0**53):
        xs += near(float(d), 3)
    # Whole turns far from zero, where only an exact reduction lands on them.
    xs += [360.0 * 2**k for k in (40, 53, 200, 1000)] + [90.0 * 2**k + 2.0**k for k in (3, 60, 500)]
    # cos just below 1, next to a midpoint.
    xs += near(to_double(mpf(2) ** mpf("-26.5") * 180 / mp.pi), 4)
    xs += near(to_double(mpf(2) ** mpf("-25.5") * 180 / mp.pi), 4)
    return xs


def turns(x, part):
    """Whether x degrees is an exact multiple of 180 at offset `part`."""
    return Fraction(x) % 180 == part


def sin_degrees(x):
    return 0.0 if turns(x, 0) else to_double(mp.sin(mpf(x) * mp.pi / 180))


def cos_degrees(x):
    return 0.0 if turns(x, 90) else to_double(mp.cos(mpf(x) * mp.pi / 180))


def tan_degrees(x):
    return 0.0 if turns(x, 0) else to_double(mp.tan(mpf(x) * mp.pi / 180))


def unit_inputs():
    xs = [random.uniform(-1, 1) for _ in range(400)]
    xs += [bits(-1021, -1) for _ in range(200)]
    xs += [5e-324, -5e-324, 2.2250738585072014e-308]
    for c in (1.0, -1.0, 0.5, -0.5, 0.0):
        xs += near(c, 3)
    xs += near(math.sqrt(0.5), 3) + near(math.sqrt(3) / 2, 3) + near(-math.sqrt(3) / 2, 3)
    return [x for x in xs if -1 <= x <= 1 and x != 0]


def atan2_inputs():
    pairs = []
    for _ in range(300):
        pairs.append((bits(-40, 40), bits(-40, 40)))
    for _ in range(200):
        pairs.append((bits(-1021, 1023), bits(-1021, 1023)))
    pairs += [
        (5e-324, 1e308),
        (-5e-324, 1e308),
        (5e-324, -1e308),
        (1e308, 5e-324),
        (1e-300, 1e300),
        (3.0, 3.0000000000000004),
    ]
    for y in near(1.0, 2):
        for x in near(1.0, 2):
            if abs(y) != abs(x):
                pairs += [(y, x), (-y, x), (y, -x), (-y, -x)]
    return pairs


def pow_inputs():
    pairs = []
    for _ in range(250):
        pairs.append((abs(bits(-20, 20)), bits(-6, 6)))
    for _ in range(100):
        pairs.append((abs(bits(-1021, 1023)), random.uniform(-1, 1)))
    for _ in range(100):
        pairs.append((1 + (random.getrandbits(30) | 1) / 2**52, random.uniform(-1e15, 1e15)))
    for _ in range(100):
        pairs.append((float(random.getrandbits(27) | 1), float(random.randint(-9, 9) or 2)))
    for k in (2, 4, 8, 16):
        for base in (3.0, 5.0, 0.75, 1.5, 7.0):
            b = base**k
            pairs += [(b, 1 / k), (b, -1 / k), (b, 3 / k)]
    # Exact squares that land on a tie between two doubles, and range edges.
    pairs += [
        (134217727.0, 2.0),
        (134217725.0, 2.0),
        (94906267.0, 2.0),
        (2.0, 0.5),
        (2.0, -1074.0),
        (2.0, -1075.0),
        (2.0, 1023.0),
        (10.0, 308.0),
        (10.0, -323.0),
        (10.0, -324.0),
        (1.0000000000000002, 1e15),
        (0.9999999999999999, 1e15),
        (1.0000000000000002, 2.0**53),
        (1.5, 1750.5),
        (1.5, -1837.0),
        (1e-300, 1.05),
        (1e300, -1.08),
        (5e-324, 0.5),
        (5e-324, -0.9),
        (1e-320, 1.01),
        (3e-310, 0.25),
        (5e-324, 1.5),
    ]
    return pairs


def deg(v):
    return v * 180 / mp.pi


def power(x, y):
    try:
        return to_double(mp.power(mpf(x), mpf(y)))
    except OverflowError:
        return math.inf


vectors = {
    "sin": [[x, sin_degrees(x)] for x in trig_inputs()],
    "cos": [[x, cos_degrees(x)] for x in trig_inputs()],
    "tan": [[x, tan_degrees(x)] for x in trig_inputs() if not turns(x, 90)],
    "sqrt": [
        [x, to_double(mp.sqrt(mpf(x)))]
        for x in [abs(bits(-1021, 1023)) for _ in range(300)] + [5e-324, 1e-320, 2.0, 3.0]
    ],
    "asin": [[x, to_double(deg(mp.asin(mpf(x))))] for x in unit_inputs()],
    "acos": [[x, to_double(deg(mp.acos(mpf(x))))] for x in unit_inputs()],
    "atan2": [[y, x, to_double(deg(mp.atan2(mpf(y), mpf(x))))] for y, x in atan2_inputs()],
    "pow": [[x, y, power(x, y)] for x, y in pow_inputs()],
}


def encode(v):
    # Hex bits keep subnormals and every last place exact.
    return struct.pack(">d", v).hex()


out = {k: [[encode(c) for c in row] for row in rows] for k, rows in vectors.items()}
with open("rounded-math.vectors.json", "w", encoding="utf8", newline="\n") as f:
    json.dump(out, f, separators=(",", ":"))
print({k: len(v) for k, v in out.items()})
