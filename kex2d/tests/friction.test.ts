import { describe, expect, test } from "bun:test";
import { forces } from "../src/bake";
import { G, integrate, loss, step, V_FLOOR } from "../src/forward";
import { Domain, evalForce, evalGeo, type Entry } from "../src/section";
import { withThetas } from "./helpers/chain";
import { rk4, rk4Time } from "./oracles/rk4";

// `kex2d-friction` stage 1: the loss law is `2·(μ·g·|fN| + c·v²)·ds`, in v²
// units, landed once in `forward.loss` and consumed by both call sites
// (`forward.step`/`integrate`, `bake.forces`). This file is the Validation
// spine (`fidelity.md`'s standard): independent models converging — four
// closed-form analytic arms, one independent RK4 integrator (convergence
// order), and a frozen Rust cross-check on the one config where the models
// provably coincide. Every tolerance below is DERIVED from the case's own
// constants, never fitted (`coding.md`'s tolerance-discipline law).

const EPS = 2 ** -23; // f32 machine epsilon

/** generous per-step f32-accumulation constant: `step`/`forces` run ~25-30
 *  elementary float ops per edge that touch the v² value (dtheta, midpoint
 *  position, dy, the energy delta, the loss arithmetic, the clamp+sqrt) —
 *  `k = 40` is headroom over that count, not a fitted value; the incline and
 *  flat-drag arms below are EXACT-DISCRETE (their closed form is the discrete
 *  recurrence's own fixed point / geometric series, not a continuum
 *  approximation), so this bound is purely f32 rounding, nothing else. */
const K_F32 = 40;

describe("incline (Coulomb, exact-discrete)", () => {
    test("v² = v0² − 2g·sinα·s − 2μg·cosα·s to the f32 accumulation bound", () => {
        // dθ = (fN − cosθ)·g·ds/vSafe² is exactly 0 when fN = cos(entry.theta) and
        // stays 0 forever (fixed point) — the march traces a perfectly straight
        // incline at angle α, so the discrete recurrence for v² is EXACT in real
        // arithmetic: every step subtracts the SAME 2g·sinα·ds + 2μg·cosα·ds.
        const alpha = 0.2;
        const mu = 0.03;
        const ds = 0.5;
        const N = 60; // s_max = 30 m
        const V0 = 20;
        const fN = Math.cos(alpha);
        const entry: Entry = { x: 0, y: 0, theta: alpha, v: V0 };
        const r = evalForce(
            entry,
            new Float32Array(N).fill(fN),
            { edges: N, ds },
            Domain.Distance,
            undefined,
            mu,
            0,
        );

        const maxVSq = V0 * V0;
        for (let n = 1; n <= N; n++) {
            const s = n * ds;
            const expected =
                V0 * V0 - 2 * G * Math.sin(alpha) * s - 2 * mu * G * Math.cos(alpha) * s;
            const tol = K_F32 * n * EPS * maxVSq;
            expect(Math.abs(r.v[n] * r.v[n] - expected)).toBeLessThan(tol);
        }
        // sanity: friction is really doing something (loss > 0), or the equality
        // above would hold vacuously at μ = 0 too.
        expect(r.exit.v * r.exit.v).toBeLessThan(V0 * V0 - 2 * G * Math.sin(alpha) * N * ds - 1);
    });
});

describe("flat drag (exact-discrete)", () => {
    test("v²ₙ = v0²·(1 − 2c·ds)ⁿ — the discrete geometric series, μ = 0", () => {
        // flat (θ = 0 constant, fN = cos(0) = 1 drives dθ = 0 forever): the only
        // loss is drag, and each step multiplies v² by the SAME factor
        // (1 − 2·c·ds), so the closed form is the discrete recurrence's own
        // geometric series — not a continuum approximation either.
        const c = 0.002;
        const ds = 0.5;
        const N = 100;
        const V0 = 20;
        const entry: Entry = { x: 0, y: 0, theta: 0, v: V0 };
        const r = evalForce(
            entry,
            new Float32Array(N).fill(1),
            { edges: N, ds },
            Domain.Distance,
            undefined,
            0,
            c,
        );

        const factor = 1 - 2 * c * ds;
        const maxVSq = V0 * V0;
        for (let n = 1; n <= N; n++) {
            const expected = V0 * V0 * factor ** n;
            const tol = K_F32 * n * EPS * maxVSq;
            expect(Math.abs(r.v[n] * r.v[n] - expected)).toBeLessThan(tol);
        }
    });
});

describe("terminal velocity (fixed point)", () => {
    test("vertical drop (fN = 0): v² → g/c exactly, μ vanishes (the old-model discriminator)", () => {
        // fN = cos(−π/2) = 0 drives dθ = 0 forever too — a pure vertical drop.
        // With fN = 0 the friction term `μ·g·|fN|` is EXACTLY 0 regardless of μ:
        // this is the discriminator against the old N = mg model, which would
        // still charge friction in a vertical drop. Only drag remains, giving the
        // linear recurrence v²ₙ₊₁ = v²ₙ·(1 − 2c·ds) + 2g·ds, a contraction toward
        // the fixed point v*² = g/c at rate r = 1 − 2c·ds.
        const mu = 0.05; // nonzero, deliberately — must have ZERO effect below
        const c = 0.02;
        const ds = 0.5;
        const V0 = 10;
        const theta0 = -Math.PI / 2;
        const vStarSq = G / c;
        const r0 = 1 - 2 * c * ds;
        const e0 = V0 * V0 - vStarSq;

        // contraction-derived step count: e_n = r0^n · e0, so n·ln(r0) ≤
        // ln(target/|e0|) for a target contraction residual well under the f32
        // floor below.
        const target = 1.0; // v² units
        const N = Math.ceil(Math.log(target / Math.abs(e0)) / Math.log(r0));
        expect(N).toBeGreaterThan(0);

        const entry: Entry = { x: 0, y: 0, theta: theta0, v: V0 };
        const r = evalForce(
            entry,
            new Float32Array(N).fill(0),
            { edges: N, ds },
            Domain.Distance,
            undefined,
            mu,
            c,
        );

        const contraction = r0 ** N * Math.abs(e0);
        const f32term = K_F32 * N * EPS * Math.max(V0 * V0, vStarSq);
        const tol = contraction + f32term;
        expect(Math.abs(r.exit.v * r.exit.v - vStarSq)).toBeLessThan(tol);

        // the discriminator itself: μ = 0 lands the identical answer (fN = 0
        // either way), proving friction had no say in a vertical drop.
        const rZeroMu = evalForce(
            entry,
            new Float32Array(N).fill(0),
            { edges: N, ds },
            Domain.Distance,
            undefined,
            0,
            c,
        );
        expect(r.exit.v).toBe(rZeroMu.exit.v);
    });
});

describe("circular arc (continuum, N varies)", () => {
    test("v²(φ) matches the linear-ODE closed form to the explicit-Euler global bound", () => {
        // exact circular positions (arclength-parameterized, constant curvature
        // 1/R), driven straight into `forces` — NEVER Hermite-sampled, so no
        // spline error confounds the recovery. For an EXACT circular arc the
        // chord-bisector θ recovery is exact too (constant curvature ⇒ chord
        // angle between s_k and s_k+ds is exactly θ at the midpoint, and the
        // bisector of two such midpoints recovers θ(s_k) exactly) — so the ONLY
        // error source left is the v²-recursion's own explicit-Euler
        // discretization of the continuum ODE, which is what this arm measures.
        const R = 15;
        const theta0 = 0;
        const mu = 0.05;
        const V0 = 15;
        const phiMax = 0.8;
        const sMax = R * phiMax;
        const ds = 0.1;
        const N = Math.round(sMax / ds);

        const theta = (s: number) => theta0 + s / R;
        const posX = new Float32Array(N + 1);
        const posY = new Float32Array(N + 1);
        for (let k = 0; k <= N; k++) {
            const s = k * ds;
            posX[k] = R * (Math.sin(theta(s)) - Math.sin(theta0));
            posY[k] = R * (Math.cos(theta0) - Math.cos(theta(s)));
        }
        const dsArr = new Float32Array(N).fill(ds);
        const thetaArr = new Float32Array(N + 1);
        const vArr = new Float32Array(N + 1);
        const fN = new Float32Array(N);
        forces(posX, posY, thetaArr, vArr, fN, dsArr, 0, N, V0, theta0, G, V_FLOOR, mu, 0);

        // continuum closed form: dv²/ds = −L·v² + f(s), L = 2μ/R (c = 0 here),
        // f(s) = −2g·sinθ(s) − 2μg·cosθ(s). Linear ODE ⇒ integrating-factor
        // solution v²(s) = e^{−Ls}[v0² + ∫₀ˢ e^{Lu}f(u)du], the two standard
        // ∫e^{Lu}sin/cos(a+bu)du forms below (a = θ0, b = 1/R).
        const L = (2 * mu) / R;
        const b = 1 / R;
        const denom = L * L + b * b;
        const Isin = (s: number) => {
            const th = theta(s);
            const top = Math.exp(L * s) * (L * Math.sin(th) - b * Math.cos(th));
            const bottom = L * Math.sin(theta0) - b * Math.cos(theta0);
            return (top - bottom) / denom;
        };
        const Icos = (s: number) => {
            const th = theta(s);
            const top = Math.exp(L * s) * (L * Math.cos(th) + b * Math.sin(th));
            const bottom = L * Math.cos(theta0) + b * Math.sin(theta0);
            return (top - bottom) / denom;
        };
        const vSqClosed = (s: number) =>
            Math.exp(-L * s) * (V0 * V0 - 2 * G * Isin(s) - 2 * mu * G * Icos(s));

        // explicit-Euler global bound: |e_n| ≤ (ds/2L)·M·(e^{Ls}−1), M bounding
        // |d²v²/ds²| = |L²v² − L·f(s) + f'(s)|. Every constant below is derived
        // from the case's own g/μ/R/v0, never fitted:
        const Fmax = 2 * G * (1 + mu); // max|f(s)|, |sinθ|,|cosθ| ≤ 1
        const Vmax = V0 * V0 + Fmax / L; // Gronwall-style global bound on v²(s)
        const Fpmax = Fmax / R; // max|f'(s)| — f' carries an extra 1/R from dθ/ds
        const M = L * L * Vmax + L * Fmax + Fpmax;

        for (let k = 1; k <= N; k++) {
            const s = k * ds;
            const eulerBound = (ds / (2 * L)) * M * (Math.exp(L * s) - 1);
            const f32term = K_F32 * k * EPS * Vmax;
            const tol = eulerBound + f32term;
            expect(Math.abs(vArr[k] * vArr[k] - vSqClosed(s))).toBeLessThan(tol);
        }
    });
});

describe("RK4 (independent numerical model, convergence order)", () => {
    test("incline: halving ds shrinks the gap to the RK4 reference by the first-order ratio", () => {
        const alpha = 0.25;
        const mu = 0.04;
        const c = 0.001;
        const V0 = 18;
        const sMax = 20;
        const fN = () => Math.cos(alpha);

        // fN ≡ cos(theta0) makes theta a discrete FIXED POINT (dtheta = (fN −
        // cosθ)·g·ds/v² = 0 exactly, same trick as "incline (Coulomb,
        // exact-discrete)" above), so the kernel's OWN v² recurrence is the
        // exact affine map `u_{n+1} = (1 − 2c·ds)·u_n − F0·ds`, F0 = 2g(sinα +
        // μcosα), whose continuum limit is the linear ODE du/ds = −2c·u − F0,
        // closed form u(s) = (V0² − u*)e^{−2c·s} + u*, u* = −F0/2c. This gives
        // an exact f64 target — no RK4 needed to derive it — which lets the
        // ratio bound be DERIVED rather than fitted: the affine map's Taylor
        // deviation from the closed form (below) is the true O(ds) → O(ds²)
        // structure; comparing it to the SAME recurrence run in f32 isolates
        // f32 rounding noise from that true discretization term.
        const F0 = 2 * G * (Math.sin(alpha) + mu * Math.cos(alpha));
        const uStar = -F0 / (2 * c);
        const vTrue = Math.sqrt((V0 * V0 - uStar) * Math.exp(-2 * c * sMax) + uStar);

        const f64ExitV = (ds: number): number => {
            const N = Math.round(sMax / ds);
            const decay = 1 - 2 * c * ds;
            let u = V0 * V0;
            for (let i = 0; i < N; i++) u = decay * u - F0 * ds;
            return Math.sqrt(u);
        };
        const gapExact = (ds: number): number => Math.abs(f64ExitV(ds) - vTrue);

        const gapAt = (ds: number): number => {
            const N = Math.round(sMax / ds);
            const entry: Entry = { x: 0, y: 0, theta: alpha, v: V0 };
            const kernel = evalForce(
                entry,
                new Float32Array(N).fill(Math.cos(alpha)),
                { edges: N, ds },
                Domain.Distance,
                undefined,
                mu,
                c,
            );
            const ref = rk4(0, 0, alpha, V0, N + 1, ds, fN, G, {}, mu, c);
            return Math.abs(kernel.exit.v - ref[N][3]);
        };
        // f32 noise isolated directly: kernel (f32) minus the same recurrence
        // at f64 — not a bound, a measurement, since the recurrence is exact.
        const f32Noise = (ds: number): number => {
            const N = Math.round(sMax / ds);
            const entry: Entry = { x: 0, y: 0, theta: alpha, v: V0 };
            const kernel = evalForce(
                entry,
                new Float32Array(N).fill(Math.cos(alpha)),
                { edges: N, ds },
                Domain.Distance,
                undefined,
                mu,
                c,
            );
            return kernel.exit.v - f64ExitV(ds);
        };

        const dsCoarse = 0.2;
        const dsFine = dsCoarse / 2;
        const gapCoarse = gapAt(dsCoarse);
        const gapFine = gapAt(dsFine);

        // guard: this arm's premise (ratio tracks the true O(ds) term) holds
        // only while f32 rounding stays a minor fraction of that term — the
        // exact failure the reviewer swept into at ds ≤ 0.025, where the noise
        // and the shrinking signal cross. M = 10 caps the worst-case ratio
        // distortion at (1−1/M)/(1+1/M) ≈ 0.82×, i.e. loud failure margin, not
        // silent nonsense, if a future edit refines ds past this window.
        const M = 10;
        for (const ds of [dsCoarse, dsFine]) {
            expect(Math.abs(f32Noise(ds))).toBeLessThan(gapExact(ds) / M);
        }

        // both the kernel (semi-implicit Euler-ish, midpoint-angle) and the RK4
        // oracle are convergent methods, so as ds → 0 the gap shrinks at the
        // kernel's own first order (ratio → 2). predictedRatio is the TRUE
        // (noise-free) ratio, computed from the exact affine recurrence above;
        // worst-case f32 noise (bounded by the guard just above) can only pull
        // the measured ratio down to predictedRatio·(1−1/M)/(1+1/M).
        expect(gapCoarse).toBeGreaterThan(0);
        const predictedRatio = gapExact(dsCoarse) / gapExact(dsFine);
        const lowerBound = predictedRatio * ((1 - 1 / M) / (1 + 1 / M));
        const ratio = gapCoarse / gapFine;
        expect(ratio).toBeGreaterThan(lowerBound);
    });

    test("Time domain: rk4Time converges at the same first order with friction/drag", () => {
        const V0 = 12;
        const mu = 0.03;
        const c = 5e-4;
        const tMax = 1.2;
        const fN = () => 1; // flat-ish authored force (level entry)

        // theta0 = 0, fN ≡ 1 = cos(0) is the same discrete fixed point as the
        // incline arm above (dtheta = 0 exactly), so dy = 0 always and the
        // continuum ODE reduces to the separable dv/dt = −μg − c·v², solved in
        // closed form (standard arctan integral of a Riccati with no linear
        // term): v(t) = √(μg/c)·tan(atan(V0·√(c/μg)) − t·√(μg·c)). Domain.Time's
        // per-edge step is ds_i = v_i·Δt (variable, not constant, since v
        // changes each edge) so unlike the incline arm the discrete recurrence
        // isn't a closed affine map — f64ExitV below re-runs the SAME per-edge
        // formula (`loss`, dy = 0) at full double precision as a faithful
        // noise-isolation reference, not the pass/fail oracle (rk4Time stays
        // that).
        const k = Math.sqrt(mu * G * c);
        const s = Math.sqrt(c / (mu * G));
        const vTrue = Math.sqrt((mu * G) / c) * Math.tan(Math.atan(V0 * s) - k * tMax);

        const f64ExitV = (dt: number): number => {
            const N = Math.round(tMax / dt);
            let v = V0;
            for (let i = 0; i < N; i++) {
                const vSq = v * v;
                const lossVal = 2 * (mu * G + c * vSq) * (v * dt);
                v = Math.sqrt(Math.max(vSq - lossVal, 0));
            }
            return v;
        };
        const gapExact = (dt: number): number => Math.abs(f64ExitV(dt) - vTrue);

        const gapAt = (dt: number): number => {
            const edges = Math.round(tMax / dt);
            const entry: Entry = { x: 0, y: 0, theta: 0, v: V0 };
            const kernel = evalForce(
                entry,
                new Float32Array(edges).fill(1),
                { edges, ds: dt },
                Domain.Time,
                undefined,
                mu,
                c,
            );
            const ref = rk4Time(0, 0, 0, V0, edges + 1, dt, fN, G, {}, mu, c);
            return Math.abs(kernel.exit.v - ref[edges][3]);
        };
        const f32Noise = (dt: number): number => {
            const edges = Math.round(tMax / dt);
            const entry: Entry = { x: 0, y: 0, theta: 0, v: V0 };
            const kernel = evalForce(
                entry,
                new Float32Array(edges).fill(1),
                { edges, ds: dt },
                Domain.Time,
                undefined,
                mu,
                c,
            );
            return kernel.exit.v - f64ExitV(dt);
        };

        const dtCoarse = 0.02;
        const dtFine = dtCoarse / 2;
        const gapCoarse = gapAt(dtCoarse);
        const gapFine = gapAt(dtFine);

        const M = 10;
        for (const dt of [dtCoarse, dtFine]) {
            expect(Math.abs(f32Noise(dt))).toBeLessThan(gapExact(dt) / M);
        }

        expect(gapCoarse).toBeGreaterThan(0);
        const predictedRatio = gapExact(dtCoarse) / gapExact(dtFine);
        const lowerBound = predictedRatio * ((1 - 1 / M) / (1 + 1 / M));
        const ratio = gapCoarse / gapFine;
        expect(ratio).toBeGreaterThan(lowerBound);
    });
});

describe("Rust cross-check (demoted, coincidence only)", () => {
    test("flat-straight config matches packages/core's own update_velocity trace", () => {
        // frozen from the Rust crate's OWN `update_velocity` (never a TS
        // transliteration, `checks.md`'s one-author agreement trap) — see the
        // fixture's `generatedBy` field for the exact regenerate command. Flat
        // (fN = 1 exactly ⇒ N = mg) and Domain.Time (ds_i = v_i·Δt, matching the
        // Rust core's own fixed-Δt march) are the ONE config where our
        // |fN|-based Coulomb model and the old N = mg model provably coincide —
        // this is a coincidence cross-check, never an authority (`fidelity.md`).
        const fixture = require("./fixtures/friction-rust-cross-check.json") as {
            v0: number;
            friction: number;
            resistance: number;
            dt: number;
            steps: number;
            v: number[];
        };
        const entry: Entry = { x: 0, y: 0, theta: 0, v: fixture.v0 };
        const r = evalForce(
            entry,
            new Float32Array(fixture.steps).fill(1),
            { edges: fixture.steps, ds: fixture.dt },
            Domain.Time,
            undefined,
            fixture.friction,
            fixture.resistance,
        );

        // f32-vs-f64-intermediate rounding: both sides compute in f32 storage,
        // but this kernel's intermediates run in JS f64 before each f32 write,
        // while Rust's are f32 throughout — a per-step operation-order gap, so
        // the bound is relative and grows with step count (n·ε).
        for (let k = 0; k <= fixture.steps; k++) {
            const tol = Math.max(1e-4, k * EPS) * Math.max(1, Math.abs(fixture.v[k]));
            expect(Math.abs(r.v[k] - fixture.v[k])).toBeLessThan(tol);
        }
    });
});

describe("march-vs-recovery exit-v agreement", () => {
    test("the max interior v² gap shrinks at first order in ds", () => {
        // `kex2d-map.md`'s invariant: march-exit v and recovery-exit v now agree
        // to INTEGRATOR TRUNCATION, not exactly — march loss uses the INPUT fN,
        // recovery loss uses the geometry-RECOVERED fN, and those differ by the
        // known O(ds) source-vs-centered convention gap (`fvd.lab.ts` panel 3,
        // `section.test.ts`'s own "recovered display force converges as O(ds)"
        // arm, whose exact authored profile and bound this test reuses).
        const mu = 0.02;
        const c = 5e-4;
        const V0 = 16;
        const sMax = 32;
        const authored = (s: number): number => 1 + 0.5 * Math.sin(s / 8);

        // max interior v² gap over the whole profile (a single exit-point read
        // is noise-prone — the phase of `authored` against the sample grid can
        // put an accidental near-cancellation right at the exit).
        const maxGap = (ds: number): number => {
            const N = Math.round(sMax / ds);
            const fNArr = Float32Array.from({ length: N }, (_, i) => authored(i * ds));
            const entry: Entry = { x: 0, y: 0, theta: 0, v: V0 };

            // the march's OWN v (no re-recovery) — same call `evalForce` makes
            // internally, read out before `forces()` overwrites it.
            const posX = new Float32Array(N + 1);
            const posY = new Float32Array(N + 1);
            const marchTheta = new Float32Array(N + 1);
            const marchV = new Float32Array(N + 1);
            posX[0] = entry.x;
            posY[0] = entry.y;
            marchTheta[0] = entry.theta;
            marchV[0] = entry.v;
            integrate(
                posX,
                posY,
                marchTheta,
                marchV,
                N + 1,
                ds,
                (sigma) => fNArr[Math.round(sigma / ds)],
                G,
                V_FLOOR,
                mu,
                c,
            );

            const r = evalForce(entry, fNArr, { edges: N, ds }, Domain.Distance, undefined, mu, c);
            let mx = 0;
            for (let i = 2; i < N - 2; i++)
                mx = Math.max(mx, Math.abs(marchV[i] * marchV[i] - r.v[i] * r.v[i]));
            return mx;
        };

        const coarse = maxGap(0.5);
        const fine = maxGap(0.25);
        expect(fine).toBeGreaterThan(0);
        expect(fine).toBeLessThan(coarse); // it shrinks
        expect(fine).toBeLessThan(0.65 * coarse); // ~halving → O(ds), section.test.ts's own bound
    });
});

describe("exit-target exactness composes with friction (prescription beats dissipation)", () => {
    test("a speed control still lands exactly on target with μ, c > 0 inside its span", () => {
        const edges = 24;
        const ds = 0.5;
        const mu = 0.03;
        const c = 1e-3;
        const entry: Entry = { x: 0, y: 0, theta: 0.1, v: 12 };
        const fN = new Float32Array(edges).fill(1.05);
        const r = evalForce(entry, fN, { edges, ds }, Domain.Distance, { target: 22 }, mu, c);
        expect(r.exit.v).toBe(22);
    });

    test("evalGeo's arclength ramp lands exactly on target with μ, c > 0 too", () => {
        const nodes = withThetas([
            { x: 0, y: 0 },
            { x: 30, y: -4 },
        ]);
        const r = evalGeo(
            { x: 0, y: 0, theta: 0, v: 10 },
            nodes,
            0.5,
            undefined,
            { target: 18 },
            0.04,
            2e-3,
        );
        expect(r.exit.v).toBe(18);
    });
});

// `loss` itself, directly — the named function `kex2d-friction`'s Locked
// decision requires: `(fMag, vSq, ds, friction, resistance) → loss`.
describe("forward.loss", () => {
    test("zero coefficients, zero ds, or zero fMag+resistance all zero the loss", () => {
        expect(loss(1, 100, 0.5, 0, 0)).toBe(0);
        expect(loss(1, 100, 0, 0.05, 0.01)).toBe(0);
        expect(loss(0, 100, 0.5, 0.05, 0)).toBe(0);
    });

    test("matches the model literally: 2·(μ·g·|fN| + c·v²)·ds", () => {
        const fMag = 1.3;
        const vSq = 225;
        const ds = 0.4;
        const mu = 0.02;
        const c = 3e-4;
        const expected = 2 * (mu * G * Math.abs(fMag) + c * vSq) * ds;
        expect(loss(fMag, vSq, ds, mu, c)).toBeCloseTo(expected, 10);
    });

    test("negative fMag is treated as its magnitude (upstop wheels grip too)", () => {
        expect(loss(-1.3, 225, 0.4, 0.02, 3e-4)).toBeCloseTo(loss(1.3, 225, 0.4, 0.02, 3e-4), 12);
    });
});

// keeps `forward.step`'s own signature honest independent of the section
// substrate above (direct kernel-level check, not just via evalForce).
describe("forward.step friction default", () => {
    test("omitting friction/resistance is byte-identical to explicit 0s", () => {
        const N = 20;
        const posX = new Float32Array(N);
        const posY = new Float32Array(N);
        const theta = new Float32Array(N);
        const v = new Float32Array(N);
        v[0] = 15;
        const posX2 = new Float32Array(N);
        const posY2 = new Float32Array(N);
        const theta2 = new Float32Array(N);
        const v2 = new Float32Array(N);
        v2[0] = 15;

        for (let i = 0; i < N - 1; i++) {
            step(posX, posY, theta, v, i, i + 1, 1.05, 0.5);
            step(posX2, posY2, theta2, v2, i, i + 1, 1.05, 0.5, G, V_FLOOR, 0, 0);
        }
        for (let i = 0; i < N; i++) {
            expect(v[i]).toBe(v2[i]);
            expect(posX[i]).toBe(posX2[i]);
        }
    });
});
