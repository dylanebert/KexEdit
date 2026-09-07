import { describe, expect, test } from "bun:test";
import { integrate, step } from "../src/forward";

const G = 9.80665;

type Buf = { posX: Float32Array; posY: Float32Array; theta: Float32Array; v: Float32Array };

function makeBuf(n = 64): Buf {
    return {
        posX: new Float32Array(n),
        posY: new Float32Array(n),
        theta: new Float32Array(n),
        v: new Float32Array(n),
    };
}

function setSample(b: Buf, i: number, x: number, y: number, theta: number, v: number): void {
    b.posX[i] = x;
    b.posY[i] = y;
    b.theta[i] = theta;
    b.v[i] = v;
}

function readSample(b: Buf, i: number): { x: number; y: number; theta: number; v: number } {
    return { x: b.posX[i], y: b.posY[i], theta: b.theta[i], v: b.v[i] };
}

describe("step", () => {
    test("flat F_n=1 at θ=0 advances straight horizontal, v constant", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0, 10);
        step(b.posX, b.posY, b.theta, b.v, 0, 1, 1.0, 0.5, G);
        const next = readSample(b, 1);

        expect(next.x).toBeCloseTo(0.5, 12);
        expect(next.y).toBeCloseTo(0, 12);
        expect(next.theta).toBeCloseTo(0, 12);
        expect(next.v).toBeCloseTo(10, 12);
    });

    test("does not mutate source index", () => {
        const b = makeBuf();
        setSample(b, 0, 1, 2, 0.3, 5);
        const snapshot = readSample(b, 0);
        step(b.posX, b.posY, b.theta, b.v, 0, 1, 1.5, 0.5, G);
        expect(readSample(b, 0)).toEqual(snapshot);
    });

    test("dθ matches (F_n − cos θ) · g · Δs / v²", () => {
        const fN = 2.5;
        const v = 15;
        const theta = 0.4;
        const ds = 0.3;
        const expected = ((fN - Math.cos(theta)) * G * ds) / (v * v);

        const b = makeBuf();
        setSample(b, 0, 0, 0, theta, v);
        step(b.posX, b.posY, b.theta, b.v, 0, 1, fN, ds, G);

        expect(b.theta[1] - theta).toBeCloseTo(expected, 7);
    });

    test("F_n=0 at θ=0 curves downward (negative dθ)", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0, 10);
        step(b.posX, b.posY, b.theta, b.v, 0, 1, 0, 0.1, G);
        expect(b.theta[1]).toBeLessThan(0);
    });

    test("F_n > cos θ curves upward (positive dθ)", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0, 10);
        step(b.posX, b.posY, b.theta, b.v, 0, 1, 2.0, 0.1, G);
        expect(b.theta[1]).toBeGreaterThan(0);
    });

    test("position uses midpoint angle, not source angle", () => {
        // At F_n large enough to bend θ noticeably, the y advance is
        // sin(θ̄)·Δs, not sin(θ_i)·Δs. Start at θ=0 with F_n>1: θ_{i+1} > 0,
        // midpoint > 0, so y advances positive even though sin(0) = 0.
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0, 10);
        const ds = 0.5;
        step(b.posX, b.posY, b.theta, b.v, 0, 1, 3.0, ds, G);

        const thetaNext = b.theta[1];
        const midAngle = 0.5 * (0 + thetaNext);
        expect(b.posX[1]).toBeCloseTo(ds * Math.cos(midAngle), 7);
        expect(b.posY[1]).toBeCloseTo(ds * Math.sin(midAngle), 7);
        expect(thetaNext).toBeGreaterThan(0);
    });

    test("energy ½v² + g·y is preserved per step", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0.2, 12);
        step(b.posX, b.posY, b.theta, b.v, 0, 1, 1.5, 0.5, G);
        const prev = readSample(b, 0);
        const next = readSample(b, 1);
        const ePrev = 0.5 * prev.v * prev.v + G * prev.y;
        const eNext = 0.5 * next.v * next.v + G * next.y;
        expect(eNext).toBeCloseTo(ePrev, 4);
    });

    test("v=0 below v_min does not blow up", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0, 0);
        step(b.posX, b.posY, b.theta, b.v, 0, 1, 1.0, 0.5, G, 0.1);
        const next = readSample(b, 1);
        expect(Number.isFinite(next.x)).toBe(true);
        expect(Number.isFinite(next.y)).toBe(true);
        expect(Number.isFinite(next.theta)).toBe(true);
        expect(Number.isFinite(next.v)).toBe(true);
    });

    test("v clamps to zero when energy would go negative", () => {
        // Steep upward angle, low speed: would-be v² goes negative, clamps to 0.
        const b = makeBuf();
        setSample(b, 0, 0, 0, Math.PI / 2, 0.5);
        step(b.posX, b.posY, b.theta, b.v, 0, 1, 1.0, 1.0, G);
        expect(b.v[1]).toBe(0);
    });

    // A true stall (v² ≤ 0 at the edge's entry) must freeze the frame rather
    // than march through V_FLOOR — the same shape `bake.forces`' degenerate
    // (ds == 0) branch already carries a stationary cart's frame across with
    // no arc traversed. WITNESSED RED (before this fix, `vSafe = max(|v|,
    // V_FLOOR)` at forward.ts:90 made a truly-stopped edge indistinguishable
    // from a barely-crawling one, both driven by the same V_FLOOR = 0.01
    // clamp), run via `bun run <scratch>/red_witness.ts` against this exact
    // (θ=0.3, F_n=2.0, ds=0.5) case:
    //   V=0    -> { x: 2.9552972316741943, y: 4.497997760772705, theta: 51223.546875, v: 0 }
    //   V=0.01 -> { x: 2.9552972316741943, y: 4.497997760772705, theta: 51223.546875, v: 0 }
    // bit-identical, including the invented ~51223 rad of accumulated
    // curvature — a stopped ride's own march.
    test("true stall (v²≤0) freezes the frame: no dθ, position/theta carried, distinct from a sub-V_WARN crawl", () => {
        const stalled = makeBuf();
        setSample(stalled, 0, 3, 4, 0.3, 0);
        step(stalled.posX, stalled.posY, stalled.theta, stalled.v, 0, 1, 2.0, 0.5, G);

        expect(stalled.posX[1]).toBe(3);
        expect(stalled.posY[1]).toBe(4);
        expect(stalled.theta[1]).toBeCloseTo(0.3, 6);
        expect(stalled.v[1]).toBe(0);

        // distinct from a merely sub-V_WARN crawl: v=0.01 is a real, if tiny,
        // positive speed — not a true stall — so it marches normally and
        // diverges from the frozen frame above.
        const crawling = makeBuf();
        setSample(crawling, 0, 3, 4, 0.3, 0.01);
        step(crawling.posX, crawling.posY, crawling.theta, crawling.v, 0, 1, 2.0, 0.5, G);

        expect(readSample(crawling, 1)).not.toEqual(readSample(stalled, 1));
    });

    test("a negative entry v² (already over-clamped upstream) counts as a true stall too", () => {
        const b = makeBuf();
        // v itself is stored non-negative (sqrt(max(vSq,0))), but a caller
        // handing step() a genuinely stalled edge always does so at v=0 —
        // v²≤0 and v===0 coincide once v is real-valued. This arm pins the
        // boundary reads exactly zero, not "very small".
        setSample(b, 0, 1, 1, -0.6, 0);
        step(b.posX, b.posY, b.theta, b.v, 0, 1, -3.0, 2.0, G);
        const next = readSample(b, 1);
        expect(next.x).toBe(1);
        expect(next.y).toBe(1);
        expect(next.theta).toBeCloseTo(-0.6, 6);
        expect(next.v).toBe(0);
    });
});

describe("integrate", () => {
    test("writes N−1 samples beyond index 0", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0, 10);
        // Sentinel marker beyond N to confirm integrate doesn't overrun.
        b.theta[16] = 999;
        integrate(b.posX, b.posY, b.theta, b.v, 16, 0.5, () => 1.0, G);
        expect(b.theta[16]).toBe(999);
    });

    test("index 0 is preserved", () => {
        const b = makeBuf();
        setSample(b, 0, 1, 2, 0.3, 10);
        integrate(b.posX, b.posY, b.theta, b.v, 8, 0.5, () => 1.0, G);
        const a = readSample(b, 0);
        expect(a.x).toBe(1);
        expect(a.y).toBe(2);
        expect(a.theta).toBeCloseTo(0.3, 6);
        expect(a.v).toBe(10);
    });

    test("flat F_n=1 produces straight horizontal line", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0, 10);
        const ds = 0.5;
        const N = 32;
        integrate(b.posX, b.posY, b.theta, b.v, N, ds, () => 1.0, G);

        for (let i = 0; i < N; i++) {
            expect(b.posX[i]).toBeCloseTo(i * ds, 9);
            expect(b.posY[i]).toBeCloseTo(0, 10);
            expect(b.theta[i]).toBeCloseTo(0, 10);
            expect(b.v[i]).toBeCloseTo(10, 9);
        }
    });

    test("energy ½v² + g·y is preserved across all samples", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0.1, 15);
        const N = 64;
        integrate(b.posX, b.posY, b.theta, b.v, N, 0.4, () => 0.5, G);
        const E0 = 0.5 * 15 * 15 + G * 0;
        for (let i = 0; i < N; i++) {
            const sample = readSample(b, i);
            const E = 0.5 * sample.v * sample.v + G * sample.y;
            expect(E).toBeCloseTo(E0, 4);
        }
    });

    test("ballistic F_n=0 at θ=0: y descends, v increases", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0, 5);
        const N = 32;
        integrate(b.posX, b.posY, b.theta, b.v, N, 0.5, () => 0, G);
        const last = readSample(b, N - 1);
        expect(last.y).toBeLessThan(0);
        expect(last.v).toBeGreaterThan(5);
    });

    test("integrate matches step-by-step composition (source-σ convention)", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0.05, 12);
        const fN = (sigma: number) => 1.0 + 0.5 * Math.sin(sigma);
        const ds = 0.4;
        const N = 10;

        integrate(b.posX, b.posY, b.theta, b.v, N, ds, fN, G);

        const m = makeBuf();
        setSample(m, 0, 0, 0, 0.05, 12);
        expect(readSample(b, 0)).toEqual(readSample(m, 0));
        for (let i = 0; i < N - 1; i++) {
            // Source convention: F_n sampled at σ_i drives step i → i+1
            step(m.posX, m.posY, m.theta, m.v, i, i + 1, fN(i * ds), ds, G);
            expect(readSample(b, i + 1)).toEqual(readSample(m, i + 1));
        }
    });

    test("driver curve is sampled at σ_i = i · ds for i in [0, N−1)", () => {
        const b = makeBuf();
        setSample(b, 0, 0, 0, 0, 10);
        const ds = 0.5;
        const N = 8;
        const queried: number[] = [];
        integrate(
            b.posX,
            b.posY,
            b.theta,
            b.v,
            N,
            ds,
            (sigma) => {
                queried.push(sigma);
                return 1.0;
            },
            G,
        );
        expect(queried.length).toBe(N - 1);
        for (let i = 0; i < N - 1; i++) {
            expect(queried[i]).toBeCloseTo(i * ds, 12);
        }
    });

    test("θ=π/2 + v=10 + F_n=1: vertical launch starts curving back", () => {
        // Pointing straight up, normal force = 1g (gravity-only): the rider
        // continues along the +y direction initially. dθ at θ=π/2 is
        // (1 − cos(π/2))·g·ds/v² = g·ds/v² > 0 → curls toward +θ (away from
        // vertical, into a backflip). Smoke test that the integrator handles
        // the vertical case without singularity.
        const b = makeBuf();
        setSample(b, 0, 0, 0, Math.PI / 2, 10);
        const N = 32;
        integrate(b.posX, b.posY, b.theta, b.v, N, 0.5, () => 1.0, G);
        // y should rise (we're going up, decelerating)
        expect(b.posY[1]).toBeGreaterThan(0);
        // No NaN/Inf
        for (let i = 0; i < N; i++) {
            const sample = readSample(b, i);
            expect(Number.isFinite(sample.x)).toBe(true);
            expect(Number.isFinite(sample.y)).toBe(true);
            expect(Number.isFinite(sample.theta)).toBe(true);
            expect(Number.isFinite(sample.v)).toBe(true);
        }
    });
});
