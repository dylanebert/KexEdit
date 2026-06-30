/**
 * the bezier constraint draft (roadmap "kex2d Phase 2c").
 *
 * a force pin promotes to a bezier *keyframe* carrying two tangent handles
 * (`pins.ts Handle`). with ≥2 keyframes the constraint draft is the piecewise
 * cubic through them, evaluated on the draft-time grid → a dense set of force
 * targets the optimizer pulls toward (`optimize.ts` builds one `PointCon` per
 * target). a single keyframe stays a one-sample point constraint, byte-identical
 * to the Phase 2b path.
 *
 * each segment is a unit-box cubic: x runs the segment's draft-time fraction
 * [0,1], the control xs (`p1x`, `p2x`) clamped to [0,1] so x(s) is monotone (the
 * CSS cubic-bezier function-of-time guarantee). evaluating a target at a fixed
 * grid index means inverting x(s)=xTarget for s, then reading y(s) — the WebKit
 * `UnitBezier::solve` algorithm (Newton with a bisection fallback where x'(s)≈0).
 *
 * the y axis is *absolute g* (the control ys are real force values, a handle's dy
 * a g-delta from the keyframe), NOT theatre's value-delta normalization — so a
 * flat segment (equal-g pins) with non-zero handle dy still bumps and can
 * overshoot the force band. that authored overshoot survives the solve because
 * the pin weight (1e4) dominates the band hinge (≈4); see `solve.ts`.
 *
 * reference: theatre `Curve.tsx` / `CurveHandle.tsx` (the unit-box handle model);
 * WebKit `UnitBezier` (the x-inversion).
 */

import type { Pin } from "./pins";

const NEWTON_ITERS = 8;
const BISECT_ITERS = 20;
const EPS = 1e-7;

function clamp01(x: number): number {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** the unit-box cubic with x control points (0, p1x, p2x, 1): value at s. */
function curveX(s: number, p1x: number, p2x: number): number {
    const u = 1 - s;
    return 3 * u * u * s * p1x + 3 * u * s * s * p2x + s * s * s;
}

function curveXDeriv(s: number, p1x: number, p2x: number): number {
    const u = 1 - s;
    return 3 * u * u * p1x + 6 * u * s * (p2x - p1x) + 3 * s * s * (1 - p2x);
}

/** the unit-box cubic with arbitrary y control points (p0y, p1y, p2y, p3y) at s. */
function curveY(s: number, p0y: number, p1y: number, p2y: number, p3y: number): number {
    const u = 1 - s;
    return u * u * u * p0y + 3 * u * u * s * p1y + 3 * u * s * s * p2y + s * s * s * p3y;
}

/** solve x(s)=xTarget for the curve parameter s, given x control points (0, p1x,
 *  p2x, 1) with p1x,p2x ∈ [0,1]. Newton, falling back to bisection where the
 *  derivative is near zero (a pure-Newton solve stalls at e.g. p1x=1,p2x=0). */
function solveCurveX(xTarget: number, p1x: number, p2x: number): number {
    if (xTarget <= 0) return 0;
    if (xTarget >= 1) return 1;
    let s = xTarget; // x(s)≈s near the diagonal — a good seed
    for (let i = 0; i < NEWTON_ITERS; i++) {
        const x = curveX(s, p1x, p2x) - xTarget;
        if (Math.abs(x) < EPS) return s;
        const dx = curveXDeriv(s, p1x, p2x);
        if (Math.abs(dx) < 1e-6) break;
        s -= x / dx;
    }
    // bisection backstop — x is monotone in [0,1], so the root is bracketed.
    let lo = 0;
    let hi = 1;
    s = clamp01(s);
    for (let i = 0; i < BISECT_ITERS; i++) {
        const x = curveX(s, p1x, p2x);
        if (Math.abs(x - xTarget) < EPS) return s;
        if (x < xTarget) lo = s;
        else hi = s;
        s = 0.5 * (lo + hi);
    }
    return s;
}

/**
 * evaluate the unit-box cubic (control points (0,p0y), (p1x,p1y), (p2x,p2y),
 * (1,p3y)) as a function of x: invert x(s)=xTarget then read y(s). `p1x`/`p2x`
 * are clamped to [0,1] so the curve stays a function of time.
 */
export function bezierY(
    p1x: number,
    p1y: number,
    p2x: number,
    p2y: number,
    p0y: number,
    p3y: number,
    xTarget: number,
): number {
    const s = solveCurveX(clamp01(xTarget), clamp01(p1x), clamp01(p2x));
    return curveY(s, p0y, p1y, p2y, p3y);
}

/**
 * the constraint targets on the draft-time grid: one `{index, value}` per integer
 * grid index in the span [firstPin.index, lastPin.index]. indices outside the span
 * stay unconstrained (the prior + smoothness govern there).
 *
 * pins need not be sorted — a copy is sorted by (index, id). pins sharing an index
 * collapse to the highest id (the most recent edit wins — a zero-width segment has
 * no curve). 0 pins → []; 1 pin → its single point (handles ignored, the Phase 2b
 * degenerate path).
 */
export function constraintTargets(pins: readonly Pin[]): { index: number; value: number }[] {
    if (pins.length === 0) return [];

    // sort a copy by index, breaking ties by id (highest last). the store keeps
    // insertion order so stable ids survive remove→undo; only the curve sorts.
    const sorted = [...pins].sort((a, b) => a.index - b.index || a.id - b.id);
    // collapse equal indices, keeping the last (highest id) — no zero-width curve.
    const kf: Pin[] = [];
    for (const p of sorted) {
        if (kf.length > 0 && kf[kf.length - 1].index === p.index) kf[kf.length - 1] = p;
        else kf.push(p);
    }

    if (kf.length === 1) return [{ index: kf[0].index, value: kf[0].value }];

    const out: { index: number; value: number }[] = [];
    for (let seg = 0; seg < kf.length - 1; seg++) {
        const a = kf[seg];
        const b = kf[seg + 1];
        const span = b.index - a.index;
        const p1x = a.hr.dx;
        const p1y = a.value + a.hr.dy;
        const p2x = 1 - b.hl.dx;
        const p2y = b.value + b.hl.dy;
        // walk [a.index, b.index): the shared endpoint b.index is emitted by the
        // next segment's start, or by the tail append below for the last segment.
        for (let i = a.index; i < b.index; i++) {
            const xFrac = (i - a.index) / span;
            out.push({ index: i, value: bezierY(p1x, p1y, p2x, p2y, a.value, b.value, xFrac) });
        }
    }
    out.push({ index: kf[kf.length - 1].index, value: kf[kf.length - 1].value });
    return out;
}
