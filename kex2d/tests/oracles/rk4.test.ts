import { describe, expect, test } from "bun:test";
import { forward64 } from "../helpers/forward64";
import { rk4 } from "./rk4";

const G = 9.80665;

describe("rk4", () => {
    test("returns N samples; anchor preserved exactly", () => {
        const out = rk4(1, 2, 0.3, 12, 8, 0.5, () => 1.0, G);
        expect(out.length).toBe(8);
        expect(out[0]).toEqual([1, 2, 0.3, 12]);
    });

    test("throws when caller leaves the differentiable regime (v → 0)", () => {
        // Vertical launch at low speed: v decays toward 0 before σ = 0.5 lands.
        expect(() =>
            rk4(0, 0, Math.PI / 2, 0.5, 2, 0.5, () => 0, G, { maxSubsteps: 1000 }),
        ).toThrow();
    });

    test("F_n = 1 at θ₀ = 0: straight horizontal line, v constant", () => {
        // (F_n − cos θ) = 0 → dθ/dt = 0; y stays at 0 → v stays at v₀.
        const v0 = 10;
        const ds = 0.5;
        const N = 16;
        const out = rk4(0, 0, 0, v0, N, ds, () => 1.0, G);
        for (let i = 0; i < N; i++) {
            const [x, y, theta, v] = out[i];
            expect(x).toBeCloseTo(i * ds, 10);
            expect(y).toBeCloseTo(0, 10);
            expect(theta).toBeCloseTo(0, 10);
            expect(v).toBeCloseTo(v0, 10);
        }
    });

    test("F_n = cos(θ₀): straight inclined ramp + energy-derived speed", () => {
        // With F_n locked to cos(θ₀), dθ/dt = 0 → θ holds → path is a line at θ₀.
        const theta0 = 0.35;
        const v0 = 20;
        const ds = 0.4;
        const N = 24;
        const out = rk4(0, 0, theta0, v0, N, ds, () => Math.cos(theta0), G);
        for (let i = 0; i < N; i++) {
            const [x, y, theta, v] = out[i];
            const s = i * ds;
            const xExp = s * Math.cos(theta0);
            const yExp = s * Math.sin(theta0);
            const vExp = Math.sqrt(v0 * v0 - 2 * G * yExp);
            expect(x).toBeCloseTo(xExp, 6);
            expect(y).toBeCloseTo(yExp, 6);
            expect(theta).toBeCloseTo(theta0, 9);
            expect(v).toBeCloseTo(vExp, 6);
        }
    });

    test("F_n = 0: trajectory matches analytic projectile parabola", () => {
        // Zero rider-felt normal force = free fall. World-frame trajectory is
        // the analytic parabola; θ tracks the velocity vector.
        const theta0 = 0.6;
        const v0 = 15;
        const vx0 = v0 * Math.cos(theta0);
        const vy0 = v0 * Math.sin(theta0);
        const ds = 0.3;
        const N = 24;
        const out = rk4(0, 0, theta0, v0, N, ds, () => 0, G, { dt: 1e-5 });
        for (let i = 0; i < N; i++) {
            const [x, y, theta, v] = out[i];
            const t = x / vx0;
            const yExp = vy0 * t - 0.5 * G * t * t;
            const vyExp = vy0 - G * t;
            const vExp = Math.hypot(vx0, vyExp);
            const thetaExp = Math.atan2(vyExp, vx0);
            expect(y).toBeCloseTo(yExp, 7);
            expect(v).toBeCloseTo(vExp, 7);
            expect(theta).toBeCloseTo(thetaExp, 7);
        }
    });

    test("½v² + g·y is conserved across all samples (varied F_n)", () => {
        // F_n acts purely normal to the path, does no work — energy is an
        // analytic invariant of the ODE.
        const v0 = 18;
        const ds = 0.3;
        const N = 64;
        const out = rk4(0, 0, 0.1, v0, N, ds, (sigma) => 1.0 + 0.5 * Math.sin(sigma), G);
        const E0 = 0.5 * v0 * v0;
        for (let i = 0; i < N; i++) {
            const [, y, , v] = out[i];
            expect(0.5 * v * v + G * y).toBeCloseTo(E0, 6);
        }
    });

    test("agrees with forward.ts to forward's truncation level; sharpens with Δs", () => {
        // forward.ts is semi-implicit Euler in arclength with global error O(Δs)
        // (θ uses Euler; position uses midpoint). Oracle error is f64 noise.
        // Refining Δs 10× cuts disagreement ≥5× (~linear, slack for F_n
        // coefficient constants).
        const maxErr = (ds: number, N: number): number => {
            const fN = (sigma: number) => 1.0 + 0.3 * Math.sin(sigma);
            const fwd = forward64(0, 0, 0.05, 15, N, ds, fN, G);
            const ora = rk4(0, 0, 0.05, 15, N, ds, fN, G);
            let m = 0;
            for (let i = 0; i < N; i++) {
                for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(fwd[i][k] - ora[i][k]));
            }
            return m;
        };
        const L = 6.0;
        const errCoarse = maxErr(0.5, Math.round(L / 0.5) + 1);
        const errFine = maxErr(0.05, Math.round(L / 0.05) + 1);
        expect(errCoarse).toBeLessThan(0.05);
        expect(errFine).toBeLessThan(0.005);
        expect(errFine).toBeLessThan(errCoarse / 5);
    });
});
