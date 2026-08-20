import { describe, expect, test } from "bun:test";
import {
    computeExit,
    derivedTol,
    injectionTol,
    MIN_FREE,
    type OptimizeOpts,
    solveOptimize,
} from "../src/optimize";
import optimizeGolden from "./fixtures/optimize-golden.json";
import { G } from "../src/forward";
import { Easing, type ForcePoint, forceProfile, resolveStep } from "../src/profile";
import { Domain, type Entry, evalForce } from "../src/section";

// the invariant floor for pin mode's masked exit-restore solve (`kex2d-optimize-mode` stage
// 1, `optimize.ts`): zero-drift identity, the masking invariants (as a property test over
// randomized lock subsets and a small scenario corpus), and byte-identical refusal/cancel — all
// red-first (see each test's own note on how it was seen failing before the fix).

/** deterministic pseudo-random in [0, 1) from an integer seed — no `Math.random` (forbidden;
 *  it would break reproducibility), mirrors `tests/banded.test.ts`'s `rand`. */
function rand(seed: number): number {
    const s = Math.sin(seed * 12.9898) * 43758.5453;
    return s - Math.floor(s);
}

const ENTRY: Entry = { x: 0, y: 0, theta: 0, v: 20 };
const DS = 0.5;

/** a small force-keyframe corpus: plain named-ease hills, a big-swing profile, and one carrying
 *  an explicit handle + mixed easing (so the mask is checked against every shaping vocabulary the
 *  document actually authors, not just plain Cubic keys). */
function corpus(): { name: string; points: ForcePoint[]; length: number }[] {
    return [
        {
            name: "gentle hill",
            length: 40,
            points: [
                { s: 0, g: 1 },
                { s: 10, g: 1.5 },
                { s: 20, g: 1 },
                { s: 30, g: 0.8 },
                { s: 40, g: 1 },
            ],
        },
        {
            name: "big swing",
            length: 25,
            points: [
                { s: 0, g: 1 },
                { s: 5, g: 3 },
                { s: 10, g: -1 },
                { s: 15, g: 3 },
                { s: 20, g: 1 },
                { s: 25, g: 1 },
            ],
        },
        {
            name: "explicit handle + mixed easing",
            length: 30,
            points: [
                { s: 0, g: 1, ease: Easing.Linear },
                { s: 10, g: 2, ease: Easing.Quintic, in: { ds: -2, dg: 0.3 } },
                { s: 20, g: 1.2, ease: Easing.Cubic },
                { s: 30, g: 1 },
            ],
        },
    ];
}

function opts(points: ForcePoint[], length: number, locked: ReadonlySet<number>): OptimizeOpts {
    const stamp = computeExit(ENTRY, points, length, DS);
    return { entry: ENTRY, points, locked, length, ds: DS, stamp };
}

describe("solveOptimize — zero-drift identity", () => {
    // RED FIRST: before the top-of-function bit-exact residual check existed, an untouched draft
    // still ran the SQP loop, and a finite-difference Jacobian step on an exactly-zero residual
    // landed a nonzero floating Δg (the loop doesn't know "already there" from "converged to
    // there") — this failed with `deltaG` off by ~1e-9 rather than exactly 0. The exact `c0 ===
    // 0` short-circuit is what makes it exact.
    for (const { name, points, length } of corpus()) {
        test(`${name}: an untouched draft solves to Δg = 0 exactly`, () => {
            const locked = new Set<number>(); // all free — the strongest form of "untouched"
            const r = solveOptimize(opts(points, length, locked));
            expect(r.outcome).toBe("solved");
            expect(r.iters).toBe(0);
            expect(r.residual).toBe(0);
            expect(r.angleResidual).toBe(0);
            // the injection gate (`kex2d-friction` stage 3) never DOWNGRADES this path: same
            // g-vector, same march, so its own injection is whatever the untouched draft
            // already carries — reported, not gated. On this corpus it's 0 (no key touches the
            // sqrt clamp), matching every other exact-zero field above.
            expect(r.injection).toBe(0);
            expect(r.deltaG).toEqual(new Array(points.length).fill(0));
            expect(r.points).toEqual(points);
        });
    }
});

describe("solveOptimize — Time-domain coverage (kex2d-optimize-mode close, item 5)", () => {
    // the kernel takes `domain` and the stall certificate interacts with the Time march
    // (`ds_i = v_i·Δt` can be genuinely 0), but no committed case ran it — the invariant floor's
    // two anchors on a Time-domain profile: seconds for s/length, a Δt step for ds.
    const timePoints: ForcePoint[] = [
        { s: 0, g: 1 },
        { s: 1, g: 1.4 },
        { s: 2, g: 1 },
        { s: 3, g: 0.9 },
        { s: 4, g: 1 },
    ];
    const TLen = 4;
    const Dt = 0.02;

    function timeOpts(points: ForcePoint[], locked: ReadonlySet<number>): OptimizeOpts {
        const stamp = computeExit(ENTRY, points, TLen, Dt, Domain.Time);
        return { entry: ENTRY, points, locked, length: TLen, ds: Dt, domain: Domain.Time, stamp };
    }

    test("zero-drift identity holds on a Time-domain draft", () => {
        const r = solveOptimize(timeOpts(timePoints, new Set()));
        expect(r.outcome).toBe("solved");
        expect(r.iters).toBe(0);
        expect(r.deltaG).toEqual(new Array(timePoints.length).fill(0));
        expect(r.points).toEqual(timePoints);
    });

    test("masking invariants hold on a Time-domain solve (locked g / every s byte-identical)", () => {
        const locked = new Set([0, 4]); // pin the endpoints, perturb an interior free key
        const perturbed = timePoints.map((p) => ({ ...p }));
        perturbed[1].g += 0.3;
        // the stamp comes from the ORIGINAL draft, so the perturbed one carries real drift to
        // correct (stamping the perturbed draft's own exit is zero drift by construction).
        const stamp = computeExit(ENTRY, timePoints, TLen, Dt, Domain.Time);
        const r = solveOptimize({
            entry: ENTRY,
            points: perturbed,
            locked,
            length: TLen,
            ds: Dt,
            domain: Domain.Time,
            stamp,
        });
        expect(r.outcome).toBe("solved");
        for (let k = 0; k < perturbed.length; k++) {
            expect(r.points[k].s).toBe(perturbed[k].s); // s never moves — seconds included
            if (locked.has(k)) {
                expect(r.points[k].g).toBe(perturbed[k].g);
                expect(r.deltaG[k]).toBe(0);
            }
        }
        // and the solve really restored the stamped exit on the Time march (not a no-op).
        expect(r.deltaG.some((d) => d !== 0)).toBe(true);
    });
});

describe("solveOptimize — masking invariants (property test)", () => {
    // RED FIRST: an earlier draft of the kernel scattered the solved vector by rebuilding the
    // FULL point array from `freeIdx` in solved order rather than re-scattering onto the
    // original index, which silently rewrote a locked key's `g` whenever the free/locked split
    // didn't fall on a prefix — caught by asserting locked-key equality per index, not just
    // array length, over randomized subsets.
    for (const { name, points, length } of corpus()) {
        for (let trial = 0; trial < 20; trial++) {
            test(`${name}: trial ${trial} — locked g/s/structure byte-identical across any solve`, () => {
                const K = points.length;
                // a random lock subset, keeping at least MIN_FREE free so most trials actually
                // invoke the solver rather than the free-count refusal (still legal either way —
                // the invariant must hold on the refusal path too).
                const lockCount = Math.floor(rand(trial * 97 + name.length) * (K - MIN_FREE + 1));
                const order = [...points.keys()].sort(
                    (a, b) => rand(trial * 31 + a) - rand(trial * 31 + b),
                );
                const locked = new Set(order.slice(0, Math.max(0, lockCount)));

                // perturb a FREE key (simulating the author's in-mode edit) so there is real
                // drift to correct — a solve on an untouched draft would trivially pass masking.
                const freeIdx = [...points.keys()].filter((k) => !locked.has(k));
                const perturbed = points.map((p) => ({ ...p }));
                if (freeIdx.length > 0) {
                    const target = freeIdx[Math.floor(rand(trial * 53) * freeIdx.length)];
                    perturbed[target].g += 0.4 * (rand(trial * 71) - 0.5);
                }

                const r = solveOptimize(opts(perturbed, length, locked));

                expect(r.points).toHaveLength(K);
                for (let k = 0; k < K; k++) {
                    expect(r.points[k].s).toBe(perturbed[k].s); // s never moves
                    expect(r.points[k].ease).toBe(perturbed[k].ease); // structure/shaping frozen
                    expect(r.points[k].in).toEqual(perturbed[k].in);
                    expect(r.points[k].out).toEqual(perturbed[k].out);
                    if (locked.has(k)) {
                        expect(r.points[k].g).toBe(perturbed[k].g); // locked g byte-identical
                        expect(r.deltaG[k]).toBe(0);
                    }
                }
                expect(r.points).toHaveLength(perturbed.length); // "length" (key count/structure)
            });
        }
    }
});

describe("solveOptimize — refusal", () => {
    // RED FIRST: before the `P < MIN_FREE` check ran ahead of any solving, a starved free set
    // (0, 1, or 2 free keys) fell into the SQP loop, which either divided by a singular 3×3
    // system silently or spun to `maxIters` — this test failed by returning `"diverged"` (or
    // hanging on a bad Cholesky) instead of the honest `"unreachable"` the necessary condition
    // demands.
    test("fewer than MIN_FREE free keys refuses as unreachable, document-shaped input untouched", () => {
        const { points, length } = corpus()[0];
        const locked = new Set([0, 1, 2, 3]); // only 1 free of 5 keys
        const r = solveOptimize(opts(points, length, locked));
        expect(r.outcome).toBe("unreachable");
        expect(r.points).toEqual(points);
        expect(r.deltaG).toEqual(new Array(points.length).fill(0));
    });

    test("a starved free set exactly at MIN_FREE − 1 still refuses", () => {
        const { points, length } = corpus()[1]; // 6 keys
        const locked = new Set([0, 1, 2, 3]); // 2 free
        const r = solveOptimize(opts(points, length, locked));
        expect(r.outcome).toBe("unreachable");
    });
});

describe("solveOptimize — actually restores the stamped exit", () => {
    test("a genuine drift converges within the derived floor", () => {
        const { points, length } = corpus()[0];
        const stamp = computeExit(ENTRY, points, length, DS);
        const edited = points.map((p) => ({ ...p }));
        edited[2].g += 0.6; // the author bumps an interior key — real drift
        const locked = new Set([0]); // lock the entry key, leave the rest free (>= MIN_FREE)
        const r = solveOptimize({ entry: ENTRY, points: edited, locked, length, ds: DS, stamp });
        expect(r.outcome).toBe("solved");
        expect(r.residual).toBeLessThan(1e-3);
        expect(r.angleResidual).toBeLessThan(1e-3);
        // the locked key really did stay put, and the edited key's own bump is still there —
        // the solve redistributes the CORRECTION across the other free keys, not this one.
        expect(r.points[0].g).toBe(edited[0].g);
    });

    // RED FIRST (the live-dogfood failure: "the solve did not converge, nothing changed" on
    // basic edits). With `JAC_H = 1e-4` the central difference amplified the f32 exit's
    // quantization by 1/2h — the ∂x/∂g row measured 10% off a Richardson reference at that step
    // — so the SQP loop converged to ~1e-3 and then random-walked above `TOL_POS` until
    // `MAX_ITERS`. This sweep failed on 6 of its 30 cases (`"diverged"` at residual 2e-4…2e-3),
    // and the ones that DID pass took 6–28 iterations rather than the 2–4 a sound Jacobian
    // needs. Deriving `JAC_H` from the forward map's own f32 accuracy is what fixes it.
    //
    // The assert is at the layer the author sees: re-integrate the SOLVED points through the
    // production integrator (`computeExit`, the same call the stamp came from) and demand the
    // replayed exit meet the kernel's own declared floor — not merely the residual the solve
    // reports about itself.
    for (const { name, points, length } of corpus()) {
        test(`${name}: a modest single-key tweak converges and restores the stamp, every key`, () => {
            const stamp = computeExit(ENTRY, points, length, DS);
            for (let k = 0; k < points.length; k++) {
                for (const sign of [1, -1]) {
                    const edited = points.map((p) => ({ ...p }));
                    edited[k].g += sign * 0.2; // a small ordinate tweak — the dogfood gesture
                    const r = solveOptimize({
                        entry: ENTRY,
                        points: edited,
                        locked: new Set(),
                        length,
                        ds: DS,
                        stamp,
                    });
                    const where = `key ${k} ${sign > 0 ? "+" : "−"}0.2 g`;
                    expect(`${where}: ${r.outcome}`).toBe(`${where}: solved`);
                    // the floor-tolerance assert (Validation): replay the SOLVED points through
                    // the production integrator and demand the exit meet the DERIVED floor —
                    // the two mechanisms' own disagreement (f32 replay noise over the section's
                    // step count), never an absolute number.
                    const floor = derivedTol(stamp, length, resolveStep(length, DS));
                    const back = computeExit(ENTRY, r.points, length, DS);
                    expect(Math.abs(back.x - stamp.x)).toBeLessThan(floor.pos);
                    expect(Math.abs(back.y - stamp.y)).toBeLessThan(floor.pos);
                    expect(Math.abs(back.theta - stamp.theta)).toBeLessThan(floor.angle);
                }
            }
        });
    }
});

describe("solveOptimize — stage-3 refusal taxonomy + continuation (kex2d-optimize-mode)", () => {
    // RED FIRST (all four, observed 2026-07-30 against the stage-1 kernel before any stage-3
    // change, via a scratch probe over the same inputs):
    //   large drift  → `"diverged"` iters=30 (converges at 51 with maxIters=200 — slow, not a
    //                  fold; the continuation ladder is what brings it inside the budget)
    //   stalled draft → `"diverged"` iters=30 res=1.12 (the vSafe-floor chaotic regime burned
    //                  the whole budget; the θ-row certificate refuses it at invoke)
    //   flattened    → `"diverged"` iters=0 (the interior A3 Cholesky failed — rank-deficient,
    //                  but reported as non-convergence; the at-invoke conditioning check is what
    //                  certifies it as `"unreachable"`)
    //   hill×10 drift → `"diverged"` res=18 m (large drift at scale; continuation)

    test("large drift solves through the continuation ladder (was: diverged at MAX_ITERS)", () => {
        const { points, length } = corpus()[0];
        const stamp = computeExit(ENTRY, points, length, DS);
        const edited = points.map((p, i) => ({ ...p, g: i === 1 ? p.g + 3 : p.g }));
        const r = solveOptimize({
            entry: ENTRY,
            points: edited,
            locked: new Set(),
            length,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("solved");
    });

    test("a stalled draft (vSafe floor active) refuses as unreachable at invoke, reason stall", () => {
        // entry v = 8 m/s under a +2.2 g climb stalls the march (vMin hits 0). the certificate is
        // the θ-row ONE-SIDED SIGN OPPOSITION read off the invoke's own FD pass (a smooth map's
        // one-sided slopes stay same-signed; the vSafe-clamp cliff flips them) — measured to
        // separate every floor-touching corpus draft from every smooth one, threshold-free
        // (conditioning lab, stage-3 rebuild; the old closed-form G·L/V_WARN² bound was removed
        // as unboundedly loose).
        const climb: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 2.2 },
            { s: 20, g: 0.4 },
            { s: 30, g: 1 },
            { s: 40, g: 1 },
        ];
        const entry: Entry = { x: 0, y: 0, theta: 0, v: 8 };
        const stamp = computeExit(entry, climb, 40, DS);
        const edited = climb.map((p, i) => ({ ...p, g: i === 2 ? p.g + 0.2 : p.g }));
        const r = solveOptimize({
            entry,
            points: edited,
            locked: new Set(),
            length: 40,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("unreachable");
        expect(r.reason).toBe("stall");
        expect(r.iters).toBe(0); // certified at invoke, no budget burned
        expect(r.points).toEqual(edited);
        expect(r.deltaG).toEqual(new Array(edited.length).fill(0));
    });

    test("a rank-deficient draft (flattened in-mode) refuses as unreachable, reason conditioning", () => {
        // the author enters the mode on the gentle hill, then flattens every key to 1 g: the
        // draft is exactly straight, its exit-Jacobian x row vanishes at first order (σmin/σmax
        // measured 0.0 in lab §4), and the stamped x is unreachable along the remaining rows.
        const { points, length } = corpus()[0];
        const stamp = computeExit(ENTRY, points, length, DS);
        const flattened = points.map((p) => ({ ...p, g: 1 }));
        const r = solveOptimize({
            entry: ENTRY,
            points: flattened,
            locked: new Set(),
            length,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("unreachable");
        expect(r.reason).toBe("conditioning");
        expect(r.points).toEqual(flattened);
        expect(r.deltaG).toEqual(new Array(flattened.length).fill(0));
    });

    test("a near-stall but SMOOTH draft solves (the stall certificate must not over-fire)", () => {
        // The stall certificate's over-fire boundary, pinned from the smooth side (adversarial
        // pass on e6e9dfe, finding 1 + finding 3): the same climb at entry v = 10 dips to
        // vMin 2.77 m/s — deep in slow territory — but never touches the vSafe floor, so its
        // exit map is smooth (one-sided θ derivatives same-signed, ratio ≤ 0.18) and the solve
        // lands in 2 iterations. The removed draft-read (vMin) and the removed closed-form
        // θ-row cap (G·L/V_WARN², which assumed v ≥ V_WARN on every edge) were both blind to
        // this distinction's real line: the CLAMP, not slow speed, is what destroys the map.
        const climb: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 2.2 },
            { s: 20, g: 0.4 },
            { s: 30, g: 1 },
            { s: 40, g: 1 },
        ];
        const entry: Entry = { x: 0, y: 0, theta: 0, v: 10 };
        const stamp = computeExit(entry, climb, 40, DS);
        const edited = climb.map((p, i) => ({ ...p, g: i === 2 ? p.g + 0.05 : p.g }));
        const r = solveOptimize({
            entry,
            points: edited,
            locked: new Set(),
            length: 40,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("solved");
    });

    test("a floor-touching draft with a smooth solution branch still SOLVES (no draft-property refusal)", () => {
        // RED FIRST (the pin on finding 1's fix): gentle hill +2 g at key 1 drives the march
        // onto the vSafe floor (vMin = 0.00) — the removed vMin-on-draft certificate refused it
        // at 0 iters — yet its exit Jacobian is sign-consistent and the solve navigates off the
        // cliff to the smooth solution near the feasible baseline, replaying within the derived
        // floor. Seen failing (`unreachable/stall`) with the vMin read temporarily restored;
        // solves under the Jacobian-consistency read. THE case proving the draft's vMin is not
        // the honest boundary in either direction.
        const { points, length } = corpus()[0];
        const stamp = computeExit(ENTRY, points, length, DS);
        const edited = points.map((p, i) => ({ ...p, g: i === 1 ? p.g + 2 : p.g }));
        const r = solveOptimize({
            entry: ENTRY,
            points: edited,
            locked: new Set(),
            length,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("solved");
        const floor = derivedTol(stamp, length, resolveStep(length, DS));
        const back = computeExit(ENTRY, r.points, length, DS);
        expect(Math.abs(back.x - stamp.x)).toBeLessThan(floor.pos);
        expect(Math.abs(back.y - stamp.y)).toBeLessThan(floor.pos);
        expect(Math.abs(back.theta - stamp.theta)).toBeLessThan(floor.angle);
    });

    test("a floor-grazing draft certifies unreachable/stall by the Jacobian read, at invoke", () => {
        // The v = 8 climb's unedited baseline kisses the vSafe floor at exactly one sample
        // (index 29 of 81; v recovers the next sample). The adversarial pass conjectured a tiny
        // edit must stay solvable (the reverting solution is adjacent) — MEASURED FALSE: with
        // every certificate bypassed, +0.01/+0.05/+0.2 g all diverge (residual 1.4–3.8 m, 200-
        // iteration budget), because a floor-touched step kicks dθ by ~±10⁴ rad and the exit
        // map across it has genuinely opposite-signed one-sided derivatives (k0: fwd −8.1e2 vs
        // bwd +6.4e4) — the reverting solution sits ON that cliff, unreachable by any
        // derivative-based method. The honest fix is the certificate's DERIVATION: it now reads
        // the Jacobian's sign consistency (fires here), never the draft's vMin (review removed
        // that draft-property read).
        const climb: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 2.2 },
            { s: 20, g: 0.4 },
            { s: 30, g: 1 },
            { s: 40, g: 1 },
        ];
        const entry: Entry = { x: 0, y: 0, theta: 0, v: 8 };
        const stamp = computeExit(entry, climb, 40, DS);
        const edited = climb.map((p, i) => ({ ...p, g: i === 2 ? p.g + 0.05 : p.g }));
        const r = solveOptimize({
            entry,
            points: edited,
            locked: new Set(),
            length: 40,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("unreachable");
        expect(r.reason).toBe("stall");
        expect(r.iters).toBe(0);
    });

    test("a near-straight draft with a small in-mode edit still solves (the certificate must not over-fire)", () => {
        // measured σmin/σmax ≈ 5e-5 at a ±0.01 g wiggle (lab §4) — above the 2^-16 FD-noise
        // certification line, so this goes to the solver, which handles it (probe: solved,
        // res 7e-6). Guards the conditioning threshold's derivation from creeping upward.
        const flat: ForcePoint[] = [0, 10, 20, 30, 40].map((s) => ({ s, g: 1 }));
        const stamp = computeExit(ENTRY, flat, 40, DS);
        const edited = flat.map((p, i) => ({ ...p, g: i === 2 ? p.g + 0.05 : p.g }));
        const r = solveOptimize({
            entry: ENTRY,
            points: edited,
            locked: new Set(),
            length: 40,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("solved");
    });

    test("hill×10 (exit ≈ 400 m): a modest drift solves under the relative floor (was: fixed 1e-4 refused)", () => {
        // at this scale the derived floor (~2e-3) sits far ABOVE the stage-1 fixed 1e-4
        // (≈0.4σ of the replay noise over 800 steps), which refused honest solves — the
        // relative-floor law's own worked case (lab §3).
        const hill10: ForcePoint[] = [0, 100, 200, 300, 400].map((s, i) => ({
            s,
            g: [1, 1.5, 1, 0.8, 1][i],
        }));
        const entry: Entry = { x: 0, y: 0, theta: 0, v: 40 };
        const stamp = computeExit(entry, hill10, 400, DS);
        const edited = hill10.map((p, i) => ({ ...p, g: i === 3 ? p.g - 0.2 : p.g }));
        const r = solveOptimize({
            entry,
            points: edited,
            locked: new Set(),
            length: 400,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("solved");
        const floor = derivedTol(stamp, 400, resolveStep(400, DS));
        const back = computeExit(entry, r.points, 400, DS);
        expect(Math.abs(back.x - stamp.x)).toBeLessThan(floor.pos);
        expect(Math.abs(back.y - stamp.y)).toBeLessThan(floor.pos);
        expect(Math.abs(back.theta - stamp.theta)).toBeLessThan(floor.angle);
    });

    test("hill×10: an edit that stalls the march refuses as unreachable/stall, not diverged", () => {
        // +0.2 g over a 100 m span extends the climb until v hits the floor (vMin = 0.00) —
        // the long-section localized stall the march certificate catches where the L-scaled
        // θ-row bound (G·L/V_WARN² ≈ 3.9e3 at L = 400) is too loose to see it.
        const hill10: ForcePoint[] = [0, 100, 200, 300, 400].map((s, i) => ({
            s,
            g: [1, 1.5, 1, 0.8, 1][i],
        }));
        const entry: Entry = { x: 0, y: 0, theta: 0, v: 40 };
        const stamp = computeExit(entry, hill10, 400, DS);
        const edited = hill10.map((p, i) => ({ ...p, g: i === 3 ? p.g + 0.2 : p.g }));
        const r = solveOptimize({
            entry,
            points: edited,
            locked: new Set(),
            length: 400,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("unreachable");
        expect(r.reason).toBe("stall");
        expect(r.iters).toBe(0);
    });

    test("free-count refusal carries its reason", () => {
        const { points, length } = corpus()[0];
        const r = solveOptimize(opts(points, length, new Set([0, 1, 2, 3])));
        expect(r.outcome).toBe("unreachable");
        expect(r.reason).toBe("free-count");
    });

    test("a diverged result never reads worse than the drift it started from", () => {
        // the honest-backtrack law: with the t < 1e-3 acceptance removed, every accepted step
        // strictly improves the scaled residual, and a refused solve reports its best-known
        // reading — so "diverged" can never hand the caller a diagnosis worse than doing nothing.
        const { points, length } = corpus()[1];
        const stamp = computeExit(ENTRY, points, length, DS);
        const edited = points.map((p, i) => ({ ...p, g: i === 1 ? p.g + 8 : p.g }));
        const e0 = computeExit(ENTRY, edited, length, DS);
        const init = Math.max(Math.abs(e0.x - stamp.x), Math.abs(e0.y - stamp.y));
        const r = solveOptimize({
            entry: ENTRY,
            points: edited,
            locked: new Set(),
            length,
            ds: DS,
            stamp,
        });
        if (r.outcome !== "solved") expect(r.residual).toBeLessThanOrEqual(init);
    });
});

describe("solveOptimize — golden fixture (bit identity)", () => {
    // the frozen contract on any change claiming to leave the solve alone (a perf change above
    // all): the gentle-hill lock-and-solve case's exact output, compared with `toBe` — a one-ulp
    // drift re-opens the human check (`convert-golden.json`'s precedent). Trip-by-design PROVEN:
    // run with `JAC_H` mutated one octave (2^-9) the test fails (deltaG diverges from the 8th
    // decimal). NOT tripped by a tolerance mutation — this case's converging iterate already
    // sits below a 1σ floor, so the floor law is pinned by the hill×10 relative-floor test
    // below, not by this fixture.
    test("gentle hill, key 2 +0.6 g, key 0 locked — output bit-identical to the fixture", () => {
        const hill: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 1.5 },
            { s: 20, g: 1 },
            { s: 30, g: 0.8 },
            { s: 40, g: 1 },
        ];
        const stamp = computeExit(ENTRY, hill, 40, DS);
        expect(stamp.x).toBe(optimizeGolden.stamp.x);
        expect(stamp.y).toBe(optimizeGolden.stamp.y);
        expect(stamp.theta).toBe(optimizeGolden.stamp.theta);
        const edited = hill.map((p, i) => ({ ...p, g: i === 2 ? p.g + 0.6 : p.g }));
        const r = solveOptimize({
            entry: ENTRY,
            points: edited,
            locked: new Set([0]),
            length: 40,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe(optimizeGolden.outcome as "solved");
        expect(r.iters).toBe(optimizeGolden.iters);
        expect(r.residual).toBe(optimizeGolden.residual);
        expect(r.angleResidual).toBe(optimizeGolden.angleResidual);
        expect(r.injection).toBe(optimizeGolden.injection);
        for (let k = 0; k < r.points.length; k++) {
            expect(r.points[k].g).toBe(optimizeGolden.g[k]);
            expect(r.deltaG[k]).toBe(optimizeGolden.deltaG[k]);
        }
    });
});

describe("solveOptimize — injection gate (kex2d-friction stage 3)", () => {
    // The path-energy pin consequence (`kex2d-map.md`): once a pin's own march runs coefficients
    // away from 0, a stamped `v` is no longer implied by the converged (x, y, θ) rows, so the old
    // `exitTol`/`vSqResidual` stamp comparison retires. The gate now reads the defect at its own
    // site — `SectionResult.injection` (`bake.forces`'s `Σ −min(v²_pre-clamp, 0)`), surfaced as
    // `OptimizeResult.injection` — and downgrades a `"solved"` outcome whose landed injection
    // exceeds `injectionTol` to `"diverged"`.

    // the additive-substrate law (`kex2d-friction`'s Locked decision): an unauthored track
    // (μ = c = 0, the kernel's own default) must stay byte-identical to before friction/resistance
    // existed as OptimizeOpts fields at all — no injection anywhere on the ordinary optimize
    // corpus, and passing the defaults explicitly must change nothing.
    test("injection is 0 across the optimize corpus at μ = c = 0, and explicit zero coefficients are inert", () => {
        for (const { points, length } of corpus()) {
            const stamp = computeExit(ENTRY, points, length, DS);
            const bare: OptimizeOpts = {
                entry: ENTRY,
                points,
                locked: new Set(),
                length,
                ds: DS,
                stamp,
            };
            const rBare = solveOptimize(bare);
            expect(rBare.outcome).toBe("solved");
            expect(rBare.injection).toBe(0);

            // explicit μ = c = 0 must reproduce the bare (coefficient-less) call bit-for-bit —
            // the byte-identity floor the substrate's additive law promises.
            const rExplicit = solveOptimize({ ...bare, friction: 0, resistance: 0 });
            expect(rExplicit).toEqual(rBare);
        }
    });

    // RED FIRST, by construction: a caller-loosened `opts.tol`/`opts.angleTol` lets the SQP accept
    // a geometrically-converged-enough (x, y, θ) that sits at a real, physical march stall — the
    // exact scenario the gate exists to catch, since the three residual rows never read `v` at
    // all (module header) and so cannot see it on their own. Before the gate existed this asserted
    // `outcome === "diverged"` and failed with `"solved"`: the loosened tolerance alone accepted
    // the iterate. Found by sweeping a climb profile's stall neighborhood (`tests/optimize.lab.ts`
    // §6) for a case whose (x, y, θ) residual clears a realistic caller tolerance while its landed
    // march still injects — v0 = 12 m/s under a steep climb, key 1 bumped by 1.525 g.
    test("a caller-loosened tolerance that accepts a march-stalled landing refuses as diverged, not solved", () => {
        const climb: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 2.2 },
            { s: 20, g: 0.4 },
            { s: 30, g: 1 },
            { s: 40, g: 1 },
        ];
        const entry: Entry = { x: 0, y: 0, theta: 0, v: 12 };
        const stamp = computeExit(entry, climb, 40, DS);
        const edited = climb.map((p, i) => (i === 1 ? { ...p, g: p.g + 1.525 } : p));
        const tol = 1;
        const angleTol = 1;
        const r = solveOptimize({
            entry,
            points: edited,
            locked: new Set(),
            length: 40,
            ds: DS,
            stamp,
            tol,
            angleTol,
        });
        // the (x, y, θ) rows really did converge inside the caller's own (loosened) tolerance —
        // the certificate that fires is the injection alone, never a fourth residual row.
        expect(r.residual).toBeLessThan(tol);
        expect(r.angleResidual).toBeLessThan(angleTol);
        const bound = injectionTol(entry.v, 40, resolveStep(40, DS).edges);
        expect(r.injection).toBeGreaterThan(bound);
        expect(r.outcome).toBe("diverged");
        // a landing read is a state read, not a Jacobian-read certificate — never "unreachable".
        expect(r.reason).toBeUndefined();
    });

    test("a stamp whose (x, y, θ) converges cleanly with no stall solves normally (the gate isn't trigger-happy)", () => {
        const { points, length } = corpus()[0];
        const stamp = computeExit(ENTRY, points, length, DS);
        const edited = points.map((p, i) => ({ ...p, g: i === 2 ? p.g + 0.6 : p.g }));
        const r = solveOptimize({
            entry: ENTRY,
            points: edited,
            locked: new Set(),
            length,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("solved");
        expect(r.injection).toBe(0);
    });

    // the tolerance's own valid-window guard (`injectionTol`'s docblock; `Residue`'s derived-
    // tolerance shape): construct a march that grazes v² = 0 EXACTLY in exact arithmetic (a
    // straight incline at μ = c = 0, so the recurrence is the closed affine form
    // `v²_{i+1} = v²_i − F0·ds`, `F0 = 2·G·sin(alpha)` — the same closed form
    // `friction.test.ts`'s incline arm derives) — chosen so `F0·edges·ds = V0²` exactly, i.e. the
    // TRUE injection is 0. What the f32 kernel reads back is pure rounding noise around that
    // true 0; the model's own regime assumption is that this noise stays a minor fraction of
    // `scale` — measured directly here, never asserted by fiat.
    test("a true (analytic) graze reads back within the tolerance's own noise model", () => {
        const V0 = 10;
        const ds = 0.5;
        const edges = 100; // measured to land on the negative side of the true 0 (a nonzero
        // f32 noise reading, not a vacuous 0 < anything check — 40 edges reads exactly 0)
        const length = edges * ds;
        const F0 = (V0 * V0) / (edges * ds); // exact: F0·edges·ds = V0²
        const alpha = Math.asin(F0 / (2 * G));
        const entry: Entry = { x: 0, y: 0, theta: alpha, v: V0 };
        const fN = new Float32Array(edges).fill(Math.cos(alpha));
        const r = evalForce(entry, fN, { edges, ds }, Domain.Distance, undefined, 0, 0);
        const scale = Math.max(V0 * V0, 2 * G * length);
        // the measured f32 noise (the kernel's own injection reading, since the true value is 0
        // by construction) stays a small fraction of `scale` — the regime `injectionTol` assumes.
        expect(r.injection).toBeGreaterThan(0); // a real (if tiny) noise reading, not a vacuous 0
        expect(r.injection).toBeLessThan(scale / 1e3);
        // and it clears the production tolerance itself: a genuine graze reads "no stall".
        expect(r.injection).toBeLessThanOrEqual(injectionTol(V0, length, edges));
    });
});

describe("computeExit/solveOptimize conform ds at an off-grid length (kex2d-section-extent stage 4)", () => {
    // every case above, and every case in optimize.oracle.ts, uses length 40 or 400 at
    // DS = 0.5 — grid-aligned, so `resolveStep` is a no-op and can't expose a caller marching
    // on the raw, unconformed `ds` instead of the seam's conformed pair. 12.345 is the locked
    // decision's own worked example (edges = 25, realized 12.5, a +0.155 m gap against the
    // document's own conformed bake — four orders above `derivedTol.pos`).
    const OffLength = 12.345;
    const offPoints: ForcePoint[] = [
        { s: 0, g: 1 },
        { s: OffLength / 2, g: 1.4 },
        { s: OffLength, g: 1.1 },
    ];

    test("computeExit matches the document's own conformed bake, not a raw-ds march", () => {
        // RED FIRST (seen failing pre-fix, off by ~0.155 m on x): computeExit handed
        // forceProfile/evalForce the caller's raw ds (0.5) directly (`:255`/`:256`); the
        // document's own bake (profile.ts's ONE seam, `resolveStep`) marches at the conformed
        // step instead.
        const conformed = resolveStep(OffLength, DS);
        const documentBake = forceProfile(offPoints, conformed);
        const exit = evalForce(ENTRY, documentBake, conformed, undefined).exit;
        const stamp = computeExit(ENTRY, offPoints, OffLength, DS);
        expect(stamp.x).toBeCloseTo(exit.x, 12);
        expect(stamp.y).toBeCloseTo(exit.y, 12);
        expect(stamp.theta).toBeCloseTo(exit.theta, 12);
    });

    test("solveOptimize's own march conforms ds too (zero-drift identity against the document bake)", () => {
        // RED FIRST: the target stamp is built directly off the document-conformed march,
        // never through computeExit, so this is independent of the test above. Pre-fix,
        // `exitAt`'s own march (`:357`/`:358`) still used the raw ds, so `e0` disagreed with
        // `stamp` and the exact `c0 === 0` short-circuit missed, falling through into the
        // Gram-matrix build (`:371`/`:375`/`:385`) at the raw, unconformed step too — this
        // failed with a nonzero iters/residual rather than the exact zero-drift identity.
        const conformed = resolveStep(OffLength, DS);
        const documentBake = forceProfile(offPoints, conformed);
        const exit = evalForce(ENTRY, documentBake, conformed, undefined).exit;
        const stamp = { x: exit.x, y: exit.y, theta: exit.theta, v: exit.v };
        const r = solveOptimize({
            entry: ENTRY,
            points: offPoints,
            locked: new Set(),
            length: OffLength,
            ds: DS,
            stamp,
        });
        expect(r.outcome).toBe("solved");
        expect(r.iters).toBe(0);
        expect(r.residual).toBe(0);
        expect(r.angleResidual).toBe(0);
        expect(r.deltaG).toEqual(new Array(offPoints.length).fill(0));
    });
});
