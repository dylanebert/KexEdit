import { expect, test } from "bun:test";
import { bezierY, constraintTargets } from "../src/bezier";
import { defaultHandle, type Pin } from "../src/pins";

// a bezier keyframe with explicit handles (no store — pure data).
function kf(
    id: number,
    index: number,
    value: number,
    hl = defaultHandle(),
    hr = defaultHandle(),
): Pin {
    return { id, index, value, hl, hr };
}

test("default handles hit the endpoints and ease symmetrically between", () => {
    // default p1x=1/3, p2x=2/3 ⇒ x(s)=s exactly, so bezierY(t) reads y(t) directly.
    // flat tangents (p1y=vA, p2y=vB) give the ease y(t)=3t²(3−2t) for vA=0, vB=3.
    const y = (t: number) => bezierY(1 / 3, 0, 2 / 3, 3, 0, 3, t);
    expect(y(0)).toBeCloseTo(0, 6); // hits vA
    expect(y(1)).toBeCloseTo(3, 6); // hits vB
    expect(y(0.5)).toBeCloseTo(1.5, 6); // symmetric midpoint = 3·0.25·2
    expect(y(0.25)).toBeCloseTo(3 * 0.0625 * (3 - 0.5), 6); // 0.46875 — eases in slow
    // monotone increasing through the segment.
    for (let t = 0.1; t <= 1; t += 0.1) expect(y(t)).toBeGreaterThan(y(t - 0.1));
});

test("inversion converges at the degenerate x'(s)=0 handle (Newton stalls → bisection)", () => {
    // p1x=1, p2x=0 ⇒ x'(s)=3(1−2s)², which is 0 at s=0.5 where x=0.5. pure Newton
    // stalls there; the bisection fallback must still land the value. y controls
    // (0,0,1,1) ⇒ y at s(x=0.5)=0.5 is 0.5.
    expect(bezierY(1, 0, 0, 1, 0, 1, 0.5)).toBeCloseTo(0.5, 5);
    // and it stays a clean function across the whole span, endpoints exact.
    expect(bezierY(1, 0, 0, 1, 0, 1, 0)).toBeCloseTo(0, 6);
    expect(bezierY(1, 0, 0, 1, 0, 1, 1)).toBeCloseTo(1, 6);
});

test("the curve is a single-valued function of time under extreme handles (no fold)", () => {
    // extreme but in-bounds x handles + monotone y controls ⇒ y monotone in x,
    // never folding back. clamps guard out-of-range handles too.
    const y = (t: number) => bezierY(0, 0, 1, 5, 0, 5, t);
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
        const v = y(t);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9); // non-decreasing, no fold
        prev = v;
    }
    // out-of-range x handles are clamped to [0,1], not NaN.
    expect(Number.isFinite(bezierY(-3, 0, 4, 1, 0, 1, 0.5))).toBe(true);
});

test("a flat segment with non-zero handle dy bumps above the keyframes (absolute-g, not normalized)", () => {
    // two equal-g pins (2g) with positive handle dy. theatre's value-delta
    // normalization would give a dead-flat line (vB−vA=0); absolute-g lets it bump.
    const a = kf(1, 0, 2, defaultHandle(), { dx: 1 / 3, dy: 1.5 });
    const b = kf(2, 4, 2, { dx: 1 / 3, dy: 1.5 }, defaultHandle());
    const targets = constraintTargets([a, b]);
    expect(targets[0].value).toBeCloseTo(2, 6); // endpoints stay at the pins
    expect(targets[targets.length - 1].value).toBeCloseTo(2, 6);
    const mid = targets.find((t) => t.index === 2);
    if (!mid) throw new Error("expected an interior target at index 2");
    expect(mid.value).toBeGreaterThan(2.3); // a real bump, not a flat line
});

test("a single pin is a lone point target (the Phase 2b degenerate path)", () => {
    expect(constraintTargets([kf(1, 17, 3.5)])).toEqual([{ index: 17, value: 3.5 }]);
    expect(constraintTargets([])).toEqual([]);
});

test("two pins yield a target at every grid index in the span, endpoints equal the pins", () => {
    const a = kf(1, 10, 1);
    const b = kf(2, 16, 4);
    const targets = constraintTargets([a, b]);
    expect(targets.map((t) => t.index)).toEqual([10, 11, 12, 13, 14, 15, 16]); // dense span
    expect(targets[0].value).toBeCloseTo(1, 6);
    expect(targets[targets.length - 1].value).toBeCloseTo(4, 6);
    // nothing outside [10,16].
    expect(targets.every((t) => t.index >= 10 && t.index <= 16)).toBe(true);
    // interior follows the (monotone) bezier between the pins.
    for (let i = 1; i < targets.length; i++)
        expect(targets[i].value).toBeGreaterThan(targets[i - 1].value);
});

test("targets follow index order regardless of pin insertion order", () => {
    const a = kf(1, 20, 4); // inserted first but later in time
    const b = kf(2, 10, 1);
    const targets = constraintTargets([a, b]);
    expect(targets[0]).toEqual({ index: 10, value: expect.closeTo(1, 6) });
    expect(targets[targets.length - 1]).toEqual({ index: 20, value: expect.closeTo(4, 6) });
    for (let i = 1; i < targets.length; i++)
        expect(targets[i].index).toBeGreaterThan(targets[i - 1].index);
});

test("two pins at the same index collapse to one target, no NaN (highest id wins)", () => {
    const a = kf(1, 12, 2);
    const b = kf(2, 12, 5); // same index, higher id
    const targets = constraintTargets([a, b]);
    expect(targets).toEqual([{ index: 12, value: 5 }]); // the later edit, no zero-width curve
    expect(targets.every((t) => Number.isFinite(t.value))).toBe(true);
});
