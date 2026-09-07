/** the pitch-kernel oracle (spec `kex2d-segment-gestures` Validation 8), run by path
 *  (`bun test ./tests/pitch.oracle.ts` — `coding.md` Suite speed, `kex2d-map.md`'s by-path
 *  oracle convention).
 *
 *  `section.evalPitch` is the geo lane's kernel: the authored parameter is the HEADING, so it
 *  prescribes θ(s) off the profile and sweeps the geometry under it by `forward.step`'s own
 *  midpoint-chord rule, then reads the display force back through `bake.forces`. Under
 *  `fidelity.md` the authority for correctness is INDEPENDENT MODELS CONVERGING, so this file
 *  holds it against two of them and never against a previous implementation:
 *
 *  - the **closed form**, where one exists: a Linear key pair is a constant turn rate, which is
 *    a circular arc of radius `L/Δθ`, and with no dissipation `v² = v₀² − 2g·y` is conservation
 *    of energy. Both are known before the kernel is written.
 *  - an **f64 RK4 in `s`** over the same prescribed θ (`oracles/rk4.rk4Pitch`), with the
 *    CONVERGENCE ORDER asserted as `ds` halves rather than a single-point match — a single
 *    point can be met by a wrong scheme with a lucky constant, an order cannot.
 *
 *  Friction and resistance enter both sides through the same `forward.loss` law, so the
 *  dissipative arms are the same claim at a second point of the parameter space rather than a
 *  new one. */

import { describe, expect, test } from "bun:test";
import { invertRange, replay } from "../src/bake";
import { G } from "../src/forward";
import { Easing, type ForcePoint, sampleForce } from "../src/profile";
import { type Entry, evalPitch } from "../src/section";
import { rk4Pitch } from "./oracles/rk4";

const V0 = 25;

/** the prescribed heading a run of `points` demands, as the continuous function of arclength
 *  the RK4 oracle integrates against. Reading it through `profile.sampleForce` is the point:
 *  the profile is the authored curve BOTH models are asked about, and what is under test is the
 *  sweep and the recovery, not the bezier sampler (which `profile.test.ts` owns). */
function thetaOf(points: readonly ForcePoint[]): (s: number) => number {
    return (s: number) => sampleForce(points, s);
}

/** max |candidate − oracle| over the sampled positions. */
function positionError(
    r: { posX: ArrayLike<number>; posY: ArrayLike<number> },
    oracle: readonly (readonly number[])[],
): number {
    let worst = 0;
    for (let i = 0; i < oracle.length; i++) {
        const d = Math.hypot(r.posX[i]! - oracle[i]![0]!, r.posY[i]! - oracle[i]![1]!);
        if (d > worst) worst = d;
    }
    return worst;
}

describe("Linear pitch against the analytic circular arc", () => {
    const L = 40;
    const dTheta = 0.9;
    const kappa = dTheta / L;
    const points: ForcePoint[] = [
        { s: 0, g: 0, ease: Easing.Linear },
        { s: L, g: dTheta, ease: Easing.Linear },
    ];

    test("positions, exit heading and v all match the closed form", () => {
        const ds = 0.25;
        const edges = L / ds;
        const r = evalPitch({ x: 0, y: 0, theta: 0, v: V0 }, points, { edges, ds }, Easing.Linear);
        for (let i = 0; i <= edges; i++) {
            const sigma = i * ds;
            expect(r.posX[i]!).toBeCloseTo(Math.sin(kappa * sigma) / kappa, 3);
            expect(r.posY[i]!).toBeCloseTo((1 - Math.cos(kappa * sigma)) / kappa, 3);
            // energy: with no dissipation the speed depends on height alone, and the height is
            // the arc's own — an identity that never mentions the discretization.
            const vSq = V0 * V0 - 2 * G * ((1 - Math.cos(kappa * sigma)) / kappa);
            expect(r.v[i]!).toBeCloseTo(Math.sqrt(vSq), 2);
        }
        expect(r.exit.theta).toBeCloseTo(dTheta, 2);
    });

    test("the arc's error falls at second order as ds halves", () => {
        const errs = [1, 0.5, 0.25].map((ds) => {
            const edges = Math.round(L / ds);
            const r = evalPitch(
                { x: 0, y: 0, theta: 0, v: V0 },
                points,
                { edges, ds },
                Easing.Linear,
            );
            let worst = 0;
            for (let i = 0; i <= edges; i++) {
                const sigma = i * ds;
                const d = Math.hypot(
                    r.posX[i]! - Math.sin(kappa * sigma) / kappa,
                    r.posY[i]! - (1 - Math.cos(kappa * sigma)) / kappa,
                );
                if (d > worst) worst = d;
            }
            return worst;
        });
        // ≥ 2 means each halving buys a factor of ≥ 4; 3.5 leaves room for the f32 sample
        // buffers without admitting first order (which would read 2).
        expect(errs[0]! / errs[1]!).toBeGreaterThan(3.5);
        expect(errs[1]! / errs[2]!).toBeGreaterThan(3.5);
    });
});

describe("Cubic and Quintic against an f64 RK4 in s", () => {
    const L = 30;
    const entry: Entry = { x: 0, y: 0, theta: 0, v: V0 };

    /** the convergence-order reading for one easing and one dissipation pair: the max position
     *  error against the RK4 oracle at `ds`, `ds/2`, `ds/4`. */
    function orders(ease: Easing, friction: number, resistance: number): number[] {
        const points: ForcePoint[] = [
            { s: 0, g: 0, ease },
            { s: L, g: 0.7, ease },
        ];
        const theta = thetaOf(points);
        return [1, 0.5, 0.25].map((ds) => {
            const edges = Math.round(L / ds);
            const r = evalPitch(entry, points, { edges, ds }, ease, friction, resistance);
            const oracle = rk4Pitch(
                0,
                0,
                V0,
                edges + 1,
                ds,
                theta,
                G,
                friction,
                resistance,
            ) as unknown as number[][];
            return positionError(r, oracle);
        });
    }

    for (const ease of [Easing.Cubic, Easing.Quintic]) {
        test(`${Easing[ease]}: positions converge on the RK4 at order ≥ 2`, () => {
            const errs = orders(ease, 0, 0);
            expect(errs[0]!).toBeGreaterThan(0); // a vacuous zero is not convergence
            expect(errs[0]! / errs[1]!).toBeGreaterThan(3.5);
            expect(errs[1]! / errs[2]!).toBeGreaterThan(3.5);
        });
    }

    test("friction and resistance converge at the same order, through the same loss", () => {
        // dissipation enters the kernel through `forward.loss` and the oracle through the
        // continuum form of the same law, so agreement here is the loss law's own arm — not a
        // restatement of the conservative case, which has no μ or c in it at all.
        const errs = orders(Easing.Cubic, 0.03, 0.002);
        expect(errs[0]!).toBeGreaterThan(0);
        expect(errs[0]! / errs[1]!).toBeGreaterThan(3.5);
        expect(errs[1]! / errs[2]!).toBeGreaterThan(3.5);
    });

    test("dissipation actually moves the answer it is asserted about", () => {
        // the non-vacuity control for the arm above: with μ = c = 0 the same run reaches a
        // different speed, so "converges with friction" is a reading of friction.
        const points: ForcePoint[] = [
            { s: 0, g: 0, ease: Easing.Cubic },
            { s: L, g: 0.7, ease: Easing.Cubic },
        ];
        const step = { edges: 60, ds: 0.5 };
        const dry = evalPitch(entry, points, step, Easing.Cubic, 0, 0);
        const wet = evalPitch(entry, points, step, Easing.Cubic, 0.03, 0.002);
        expect(wet.v[60]!).toBeLessThan(dry.v[60]! - 0.5);
    });
});

describe("the swept geometry is the integrator's own", () => {
    test("pitch positions → invertRange → replay reproduce them to f32 accumulation", () => {
        // the geometry a pitch run sweeps must be a trajectory the forward integrator could
        // have produced: recovering the force that drove it and marching that force forward
        // again must land on the same samples. This is what makes the pitch lane a shape the
        // rest of the substrate can read, rather than a curve drawn beside it.
        const points: ForcePoint[] = [
            { s: 0, g: 0, ease: Easing.Cubic },
            { s: 18, g: 0.55, ease: Easing.Linear },
            { s: 36, g: -0.3, ease: Easing.Quintic },
        ];
        const edges = 72;
        const ds = 0.5;
        const friction = 0.02;
        const resistance = 0.001;
        const r = evalPitch(
            { x: 0, y: 0, theta: 0, v: V0 },
            points,
            { edges, ds },
            Easing.Cubic,
            friction,
            resistance,
        );
        const count = edges + 1;
        const fN = new Float32Array(edges);
        const dsArr = Float32Array.from(r.ds);
        const theta = Float32Array.from(r.theta);
        const v = Float32Array.from(r.v);
        const posX = Float32Array.from(r.posX);
        const posY = Float32Array.from(r.posY);
        invertRange(
            posX,
            posY,
            theta,
            v,
            fN,
            dsArr,
            0,
            edges,
            r.theta[0]!,
            r.v[0]!,
            G,
            undefined,
            friction,
            resistance,
        );
        const rx = new Float32Array(count);
        const ry = new Float32Array(count);
        const rt = new Float32Array(count);
        const rv = new Float32Array(count);
        replay(
            rx,
            ry,
            rt,
            rv,
            fN,
            dsArr,
            r.posX[0]!,
            r.posY[0]!,
            r.theta[0]!,
            r.v[0]!,
            count,
            friction,
            resistance,
        );
        for (let i = 0; i < count; i++) {
            expect(rx[i]!).toBeCloseTo(posX[i]!, 3);
            expect(ry[i]!).toBeCloseTo(posY[i]!, 3);
        }
        // and the run is a real one — a degenerate straight line would satisfy the above.
        expect(Math.abs(r.posY[edges]!)).toBeGreaterThan(1);
    });
});

describe("the run's own seed and the velocity channel", () => {
    test("a run whose opening record owns no entry seeds at entry.theta", () => {
        const incoming: Entry = { x: 5, y: 1, theta: 0.4, v: V0 };
        const points: ForcePoint[] = [{ s: 12, g: 0.9, ease: Easing.Linear }];
        const r = evalPitch(incoming, points, { edges: 24, ds: 0.5 }, Easing.Linear);
        expect(r.posX[0]!).toBe(5);
        expect(r.posY[0]!).toBe(1);
        // the profile the run bakes opens at the incoming heading and ramps to the key, so the
        // halfway heading is the midpoint of the two — a run that stepped to the key at station
        // 0 would already be sitting on 0.9 there.
        expect(r.theta[12]!).toBeCloseTo(0.65, 2);
        expect(r.theta[24]!).toBeCloseTo(0.9, 2);
    });

    test("a velocity strip changes v and fN from its own edges on, never a position", () => {
        const points: ForcePoint[] = [
            { s: 0, g: 0, ease: Easing.Linear },
            { s: 24, g: 0.7, ease: Easing.Linear },
        ];
        const step = { edges: 48, ds: 0.5 };
        const entry: Entry = { x: 0, y: 0, theta: 0, v: V0 };
        const bare = evalPitch(entry, points, step, Easing.Linear);
        const held = evalPitch(entry, points, step, Easing.Linear, 0, 0, [
            { start: 16, end: 32, value: 25 },
        ]);
        // prescribed heading means the geometry never reads `v`: every position sample is
        // bit-identical, strip or no strip, which is why the pitch lane and the velocity lane
        // do not compete for shape.
        expect(Array.from(held.posX)).toEqual(Array.from(bare.posX));
        expect(Array.from(held.posY)).toEqual(Array.from(bare.posY));
        for (let i = 0; i <= 16; i++) expect(held.v[i]!).toBe(bare.v[i]!);
        expect(held.v[24]!).toBeCloseTo(25, 5);
        for (let k = 0; k < 16; k++) expect(held.fN[k]!).toBe(bare.fN[k]!);
        expect(held.fN[24]!).not.toBeCloseTo(bare.fN[24]!, 3);
    });
});
