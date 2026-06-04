import { describe, expect, test } from "bun:test";
import { forces, invert, invertRange, replay, resampleByTime } from "../src/bake";
import { integrate, step } from "../src/forward";
import { sampleChain } from "../src/spline";
import { withThetas } from "./helpers/chain";
import { makeBuf } from "./helpers/buf";

const G = 9.80665;
const MAX = 4096;
const DS = 0.5;
const V0 = 10;

describe("invert", () => {
    test("flat horizontal positions invert to F_n = 1 (1g everywhere)", () => {
        const N = 16;
        const b = makeBuf(N);
        for (let i = 0; i < N; i++) {
            b.posX[i] = i * DS;
            b.posY[i] = 0;
        }
        invert(b.posX, b.posY, b.theta, b.v, b.fN, N, DS, 0, V0);
        for (let i = 0; i < N - 1; i++) expect(b.fN[i]).toBeCloseTo(1, 4);
    });

    test("ballistic positions (F_n=0 forward) invert back to F_n ≈ 0", () => {
        const N = 24;
        const ds = 0.3;
        const fwd = makeBuf(N);
        fwd.v[0] = 12;
        integrate(fwd.posX, fwd.posY, fwd.theta, fwd.v, N, ds, () => 0, G);

        const b = makeBuf(N);
        invert(fwd.posX, fwd.posY, b.theta, b.v, b.fN, N, ds, 0, 12);
        for (let i = 0; i < N - 1; i++) expect(b.fN[i]).toBeCloseTo(0, 3);
    });

    test("inversion is the algebraic inverse of one forward step", () => {
        const ds = 0.4;
        const b = makeBuf(8);
        b.theta[0] = 0.15;
        b.v[0] = 12;
        const fNTrue = 1.7;
        step(b.posX, b.posY, b.theta, b.v, 0, 1, fNTrue, ds, G);

        // recover F_n from the positions step() produced. invertRange is the
        // exact algebraic inverse, so it returns the force that drove the step.
        const dsArr = new Float32Array([ds]);
        invertRange(b.posX, b.posY, b.theta, b.v, b.fN, dsArr, 0, 1, b.theta[0], b.v[0], G);
        expect(b.fN[0]).toBeCloseTo(fNTrue, 5);
    });
});

describe("forces — smooth physical normal force", () => {
    /** count of F_n slope sign-reversals over `[0, n)`. a sawtooth flips at
     *  nearly every sample; a smooth profile flips only where the curve's
     *  real curvature turns over. */
    function flips(fN: Float32Array, n: number): number {
        let c = 0;
        for (let i = 2; i < n; i++) {
            const a = fN[i - 1] - fN[i - 2];
            const b = fN[i] - fN[i - 1];
            if (a * b < 0) c++;
        }
        return c;
    }

    test("flat horizontal positions give F_n = 1 (1g everywhere)", () => {
        const N = 16;
        const b = makeBuf(N);
        for (let i = 0; i < N; i++) {
            b.posX[i] = i * DS;
            b.posY[i] = 0;
        }
        const dsArr = new Float32Array(N - 1).fill(DS);
        forces(b.posX, b.posY, b.theta, b.v, b.fN, dsArr, 0, N - 1, V0);
        for (let i = 0; i < N - 1; i++) expect(b.fN[i]).toBeCloseTo(1, 4);
    });

    test("a single short edge gives F_n = cos θ (straight, no turn)", () => {
        // a segment too short to subdivide (M = 1): no interior samples, so θ is
        // just the chord heading and F_n is the gravity-normal term alone.
        const b = makeBuf(2);
        b.posX[1] = 0.6 * Math.cos(0.3);
        b.posY[1] = 0.6 * Math.sin(0.3);
        const dsArr = new Float32Array([0.6]);
        forces(b.posX, b.posY, b.theta, b.v, b.fN, dsArr, 0, 1, V0);
        expect(b.theta[0]).toBeCloseTo(0.3, 6);
        expect(b.fN[0]).toBeCloseTo(Math.cos(0.3), 4);
    });

    test("a smooth curve bakes to a smooth F_n where the algebraic inverse sawtooths", () => {
        // a densely-sampled sine wave — varying curvature, the regime the
        // reflection inverse can't track. its reflection recurrence is exact
        // only at *constant* curvature, so the varying curvature feeds the
        // marginally-stable leapfrog ±(−1)^i mode and F_n's slope flips at
        // nearly every sample (the reported bug). `forces` recovers θ from the
        // tangent bisector, which has no such mode, so it stays smooth. built
        // directly (not via sampleChain — whose per-segment near-arcs would let
        // the reflection track, masking the mode the bake must avoid).
        const N = 160;
        const dx = 0.5;
        const b = makeBuf(N);
        for (let i = 0; i < N; i++) {
            b.posX[i] = i * dx;
            b.posY[i] = 1.5 * Math.sin(0.25 * i * dx);
        }
        const dsArr = new Float32Array(N - 1);
        for (let i = 0; i < N - 1; i++) {
            dsArr[i] = Math.hypot(b.posX[i + 1] - b.posX[i], b.posY[i + 1] - b.posY[i]);
        }
        forces(b.posX, b.posY, b.theta, b.v, b.fN, dsArr, 0, N - 1, V0);

        const rf = makeBuf(N);
        rf.posX.set(b.posX);
        rf.posY.set(b.posY);
        const theta0 = Math.atan2(b.posY[1] - b.posY[0], b.posX[1] - b.posX[0]);
        invertRange(rf.posX, rf.posY, rf.theta, rf.v, rf.fN, dsArr, 0, N - 1, theta0, V0);

        // two regimes, not tuned thresholds: a smooth (low-pass) F_n can't
        // reverse slope on a *majority* of samples — only the near-Nyquist
        // leapfrog mode can. forces stays under a quarter (reversals only at the
        // wave's genuine curvature turning points); the reflection clears half.
        expect(flips(b.fN, N - 1)).toBeLessThan((N - 1) / 4);
        expect(flips(rf.fN, N - 1)).toBeGreaterThan((N - 1) / 2);
    });

    test("a constant-curvature arc recovers the exact tangent at every sample", () => {
        // a circular arc sampled uniformly in angle — the bisector tangent (and
        // its end extrapolation) is exact for constant curvature.
        const R = 10;
        const cx = 0;
        const cy = 10;
        const a0 = -Math.PI / 2; // start at the bottom of the circle, (0, 0)
        const da = 0.1;
        const N = 9;
        const b = makeBuf(N);
        for (let i = 0; i < N; i++) {
            const a = a0 + i * da;
            b.posX[i] = cx + R * Math.cos(a);
            b.posY[i] = cy + R * Math.sin(a);
        }
        const dsArr = new Float32Array(N - 1);
        for (let i = 0; i < N - 1; i++) {
            dsArr[i] = Math.hypot(b.posX[i + 1] - b.posX[i], b.posY[i + 1] - b.posY[i]);
        }
        forces(b.posX, b.posY, b.theta, b.v, b.fN, dsArr, 0, N - 1, V0);
        for (let i = 0; i < N; i++) {
            // tangent of a CCW circle at angle a is a + π/2.
            expect(b.theta[i]).toBeCloseTo(a0 + i * da + Math.PI / 2, 4);
        }
    });

    test("θ stays continuous as the heading sweeps past the ±π branch cut", () => {
        // a wide circular arc whose tangent angle crosses π (a leftward, then
        // downward turn). raw atan2 chord angles wrap from +π to −π there; the
        // recovered θ must sweep through continuously, else the cart (which
        // lerps θ) would spin a full turn between two samples.
        const R = 10;
        const a0 = 1.2;
        const da = 0.1;
        const N = 12; // tangent = a + π/2 crosses π at a ≈ 1.57, mid-chain
        const b = makeBuf(N);
        for (let i = 0; i < N; i++) {
            const a = a0 + i * da;
            b.posX[i] = R * Math.cos(a);
            b.posY[i] = R * Math.sin(a);
        }
        const dsArr = new Float32Array(N - 1);
        for (let i = 0; i < N - 1; i++) {
            dsArr[i] = Math.hypot(b.posX[i + 1] - b.posX[i], b.posY[i + 1] - b.posY[i]);
        }
        forces(b.posX, b.posY, b.theta, b.v, b.fN, dsArr, 0, N - 1, V0);
        // every per-sample turn is ~da, never the ~2π a branch-cut wrap would
        // inject; and θ increases monotonically through π.
        for (let i = 0; i < N - 1; i++) {
            expect(Math.abs(b.theta[i + 1] - b.theta[i])).toBeLessThan(0.5);
            expect(b.theta[i + 1]).toBeGreaterThan(b.theta[i]);
        }
        expect(b.theta[0]).toBeLessThan(Math.PI); // starts below π
        expect(b.theta[N - 1]).toBeGreaterThan(Math.PI); // sweeps past it
    });

    test("a ballistic (zero-force) path inverts to ≈ zero force in the interior", () => {
        // forward-integrate F_n = 0, then recover the force. the free ends carry
        // O(ds²) tangent-extrapolation error on the curving path; the interior,
        // where the bisector is centered, recovers ≈ 0.
        const N = 24;
        const ds = 0.3;
        const fwd = makeBuf(N);
        fwd.v[0] = 12;
        integrate(fwd.posX, fwd.posY, fwd.theta, fwd.v, N, ds, () => 0, G);

        const b = makeBuf(N);
        const dsArr = new Float32Array(N - 1).fill(ds);
        forces(fwd.posX, fwd.posY, b.theta, b.v, b.fN, dsArr, 0, N - 1, 12);
        for (let i = 1; i < N - 2; i++) expect(b.fN[i]).toBeCloseTo(0, 3);
    });
});

describe("spline round-trip", () => {
    test("free-drag positions round-trip through invert → replay", () => {
        // free-drag path: interpolate node positions, invert to F_n, replay.
        // θ0 is the first edge's heading (derived), and gentle heights keep
        // v ≥ V_FLOOR, so the inversion is the exact inverse of the forward step.
        const nodes = withThetas([
            { x: 0, y: 0 },
            { x: 8, y: 1.5 },
            { x: 16, y: 0.5 },
            { x: 24, y: 2 },
            { x: 32, y: 0 },
        ]);
        const src = makeBuf(MAX);
        const r = sampleChain(nodes, DS, src.posX, src.posY, src.ds, MAX);
        expect(r.valid).toBe(true);

        const theta0 = Math.atan2(src.posY[1] - src.posY[0], src.posX[1] - src.posX[0]);
        invertRange(src.posX, src.posY, src.theta, src.v, src.fN, src.ds, 0, r.edges, theta0, V0);

        const dst = makeBuf(MAX);
        replay(
            dst.posX,
            dst.posY,
            dst.theta,
            dst.v,
            src.fN,
            src.ds,
            src.posX[0],
            src.posY[0],
            theta0,
            V0,
            r.edges + 1,
        );
        for (let i = 0; i <= r.edges; i++) {
            expect(dst.posX[i]).toBeCloseTo(src.posX[i], 2);
            expect(dst.posY[i]).toBeCloseTo(src.posY[i], 2);
        }
    });
});

describe("resampleByTime — continuous (linear) read", () => {
    test("interpolates between edge-center anchors and clamps flat past the ends", () => {
        // 3 edges with distinct forces at uniform unit times. edge e is anchored
        // at its mid-time (0.5, 1.5, 2.5); a query before/after the first/last
        // anchor clamps flat, in between it ramps linearly. continuity here is
        // what stops a node nudge from stair-stepping the optimizer's prior.
        const t = new Float32Array([0, 1, 2, 3]);
        const fN = new Float32Array([0, 2, 4]);
        const grid = resampleByTime(fN, t, 4, 7, 3); // τ = 0, 0.5, 1, 1.5, 2, 2.5, 3
        const want = [0, 0, 1, 2, 3, 4, 4];
        for (let i = 0; i < want.length; i++) expect(grid[i]).toBeCloseTo(want[i], 5);
    });

    test("a single edge reads constant", () => {
        const grid = resampleByTime(new Float32Array([1.7]), new Float32Array([0, 2]), 2, 5, 2);
        for (let i = 0; i < grid.length; i++) expect(grid[i]).toBeCloseTo(1.7, 6);
    });
});
