import { State } from "@dylanebert/shallot";
import { beforeEach, describe, expect, test } from "bun:test";
import {
    beginLanding,
    beginOptimize,
    editor,
    endOptimize,
    sandbox,
    toggleLockedSet,
} from "../src/editor";
import { beginForceMove, commit, createHistory, redo, undo } from "../src/history";
import {
    computeExit,
    derivedTol,
    MIN_FREE,
    type OptimizeOpts,
    solveOptimize,
} from "../src/optimize";
import optimizeGolden from "./fixtures/optimize-golden.json";
import { liveOptimizeWorkers } from "../src/optimize-async";
import {
    enterOptimize,
    enterOptimizeMode,
    exitOptimizeMode,
    redoRouted,
    runOptimizeSection,
    StaleOptimize,
    undoRouted,
} from "../src/optimizeMode";
import { Easing, type ForcePoint } from "../src/profile";
import { Domain, type Entry } from "../src/section";
import {
    BakeSystem,
    bakeOut,
    createForcePoint,
    createSection,
    createTrack,
    samples,
    sectionForces,
    sectionInfo,
    type SectionSnapshot,
    setForcePoint,
    setTrackV0,
    snapshotAll,
    SectionKind,
} from "../src/track";

// the invariant floor for optimize mode's masked exit-restore solve (`kex2d-optimize-mode` stage
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
                    const floor = derivedTol(stamp, length, DS);
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
        const floor = derivedTol(stamp, length, DS);
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
        const floor = derivedTol(stamp, 400, DS);
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
        for (let k = 0; k < r.points.length; k++) {
            expect(r.points[k].g).toBe(optimizeGolden.g[k]);
            expect(r.deltaG[k]).toBe(optimizeGolden.deltaG[k]);
        }
    });
});

// ── the document seam (optimizeMode.ts / editor.ts) ───────────────────────────────

function forceTrack(): { state: State; eid: number; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setTrackV0(eid, 20);
    const sec = createSection(state, 0, SectionKind.Force, 40);
    createForcePoint(state, sec, 0, 1);
    createForcePoint(state, sec, 10, 1.5);
    createForcePoint(state, sec, 20, 1);
    createForcePoint(state, sec, 30, 0.8);
    createForcePoint(state, sec, 40, 1);
    state.step(0);
    return { state, eid, sec };
}

function docState(state: State, eid: number): { snap: SectionSnapshot[]; hash: string } {
    return { snap: snapshotAll(state), hash: bakeOut.get(eid)?.hash ?? "" };
}

describe("runOptimizeSection — the document seam", () => {
    test("enterOptimize stamps the section's current exit and freezes a ghost", () => {
        const { state, sec } = forceTrack();
        const session = enterOptimize(state, sec);
        expect(session).not.toBeNull();
        if (!session) return;
        expect(session.section).toBe(sec);
        expect(Number.isFinite(session.stamp.x)).toBe(true);
        expect(session.ghost.x.length).toBeGreaterThan(0);
        endOptimize(); // never opened via beginOptimize; just clearing any stray state
    });

    test("a solve lands atomically and undo restores the section byte-identical", async () => {
        const { state, sec } = forceTrack();
        // the mode must actually be OPEN: a landing is only valid for the open session (the
        // review-A invariant), so the bare enterOptimize-without-beginOptimize calling shape
        // this test once used is now rejected by design.
        if (!enterOptimizeMode(state, sec)) throw new Error("no session");
        const session = editor.optimizing;
        if (!session) throw new Error("no session");

        // the author bumps an interior key, locking the first and last (the endpoints stay
        // exactly authored while the interior free keys absorb the correction).
        const rows = sectionForces(state, sec);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.6);
        state.step(0); // rebake the edit so the section has a live bake to solve against
        const locked = new Set([rows[0].id, rows[4].id]);

        const h = createHistory();
        const result = await runOptimizeSection(h, state, session, locked);
        expect(result.outcome).toBe("solved");
        expect(liveOptimizeWorkers()).toBe(0); // the one-shot worker settled with its answer
        state.step(0);

        // the locked endpoints' g are exactly what they were before the solve landed.
        const after = sectionForces(state, sec);
        expect(after.find((r) => r.id === rows[0].id)?.g).toBe(rows[0].g);
        expect(after.find((r) => r.id === rows[4].id)?.g).toBe(rows[4].g);

        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        // undo restores the PRE-SOLVE state, i.e. the author's edited-but-unsolved draft —
        // which itself differs from `before` (the interior key's bump is real authored state
        // from BEFORE the solve ran, never rolled back by undoing the solve alone). the landing
        // entry also carries the mode transition, so this undo RE-ENTERS the mode.
        const rowsAfterUndo = sectionForces(state, sec);
        expect(rowsAfterUndo.find((r) => r.s === rows[2].s)?.g).toBe(rows[2].g + 0.6);
        expect(editor.optimizing).not.toBeNull();
        endOptimize();
    });

    test("Solve on an already-restored draft writes nothing, but still lands the mode close", async () => {
        // stage-5 rewrite of the old "no undo entry" idempotence pin: under the sandbox contract a
        // landed Solve IS the mode close, so even a zero-drift solve records exactly one entry —
        // the transition — while the document stays byte-identical (the `deltaG !== 0` filter
        // still keeps every write out). idempotence holds trivially: the mode closed, so there
        // is no second press. seen failing (doc hash diff) with the write filter removed.
        const { state, eid, sec } = forceTrack();
        if (!enterOptimizeMode(state, sec)) throw new Error("no session");
        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        const before = docState(state, eid);

        const h = createHistory();
        const result = await runOptimizeSection(h, state, session, new Set());
        expect(result.outcome).toBe("solved");
        expect(result.deltaG.every((d) => d === 0)).toBe(true);

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(1); // the mode-close transition, nothing else
        undo(h, state);
        state.step(0);
        expect(docState(state, eid)).toEqual(before); // undoing it changes no document byte
        expect(editor.optimizing).not.toBeNull(); // …but re-enters the mode
        endOptimize();
    });

    test("a cancelled solve leaves the track byte-identical", async () => {
        const { state, eid, sec } = forceTrack();
        const session = enterOptimize(state, sec);
        if (!session) throw new Error("no session");
        const rows = sectionForces(state, sec);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.6);
        state.step(0); // rebake the edit before capturing the "before" the cancel must preserve
        const before = docState(state, eid);

        const h = createHistory();
        const controller = new AbortController();
        const run = runOptimizeSection(h, state, session, new Set(), { signal: controller.signal });
        controller.abort(new Error("cancelled"));
        await expect(run).rejects.toThrow();

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
        expect(liveOptimizeWorkers()).toBe(0); // cancellation is worker termination — no leak
    });

    test("a document change during the solve rejects as StaleOptimize and writes nothing", async () => {
        const { state, eid, sec } = forceTrack();
        const session = enterOptimize(state, sec);
        if (!session) throw new Error("no session");
        const before = docState(state, eid);
        const h = createHistory();

        const run = runOptimizeSection(h, state, session, new Set());
        // mutate the document while the (real, off-thread) solve is in flight.
        const rows = sectionForces(state, sec);
        setForcePoint(state, rows[1].id, rows[1].s, rows[1].g + 0.2);

        let threw: unknown;
        try {
            await run;
        } catch (e) {
            threw = e;
        }
        expect(threw).toBeInstanceOf(StaleOptimize);
        // the only extra change on the document is the mutation this test itself made —
        // the solve wrote nothing else.
        state.step(0);
        const after = docState(state, eid);
        expect(after.snap).not.toEqual(before.snap); // our own edit is there
        expect(h.undo).toHaveLength(0); // but the solve recorded nothing
    });
});

describe("editor.ts — optimize mode + lock toggling", () => {
    test("beginOptimize/endOptimize + lock toggling round-trip", () => {
        const { state, sec } = forceTrack();
        const session = enterOptimize(state, sec);
        if (!session) throw new Error("no session");
        beginOptimize(session);
        expect(editor.optimizing).not.toBeNull();
        expect(editor.locked.size).toBe(0);

        toggleLockedSet([1, 2]);
        expect(editor.locked.has(1)).toBe(true);
        expect(editor.locked.has(2)).toBe(true);
        toggleLockedSet([1, 2]); // all locked -> unlock all
        expect(editor.locked.size).toBe(0);

        endOptimize();
        expect(editor.optimizing).toBeNull();
        expect(editor.locked.size).toBe(0);
    });
});

describe("the sandbox (kex2d-optimize-mode stage 7)", () => {
    // the sandbox contract over the real document + history substrate, orchestrated exactly the
    // way the app does: enter = `enterOptimizeMode` (opens the sandbox — nothing lands outer),
    // in-mode edits record into the sandbox (the `redirectHistory` seam — call sites still pass
    // the OUTER history, which is the point), undo/redo route through
    // `undoRouted`/`redoRouted`, Exit = `exitOptimizeMode` (discard, no trace), a landed Solve =
    // ONE outer entry carrying the frozen experiment. red-first evidence is by mutation probes
    // (the API changed shape, so the stage-6 build can't run these): each load-bearing guard —
    // the record redirect, the exit revert loop, undo-at-start-exits, the landing's sandbox
    // restore, the resumed re-land fall-through — was broken in turn and its pins seen failing
    // for that reason (readings in the working log).

    // failure isolation: a test that dies mid-mode must not strand the NEXT test's entry
    // (enterOptimizeMode refuses while a mode is open, cascading unrelated failures).
    beforeEach(() => {
        if (editor.optimizing !== null) endOptimize();
    });

    // one in-mode edit through the normal idiom (the drag gesture's bracket). deliberately
    // passed the OUTER history — the redirect must route it into the sandbox.
    function bump(h: ReturnType<typeof createHistory>, state: State, sec: number): void {
        const rows = sectionForces(state, sec);
        beginForceMove(state, rows[2].id);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.6);
        commit(h);
        state.step(0);
    }

    test("entering touches outer history not at all; in-mode edits land in the SANDBOX", () => {
        const { state, sec } = forceTrack();
        const h = createHistory();
        bump(h, state, sec); // pre-mode: a normal outer entry
        expect(h.undo).toHaveLength(1);

        expect(enterOptimizeMode(state, sec)).toBe(true);
        expect(h.undo).toHaveLength(1); // entry records NOTHING outer
        expect(sandbox()).not.toBeNull();
        expect(sandbox()?.undo).toHaveLength(0);

        bump(h, state, sec); // called with the OUTER history — the redirect routes it
        expect(h.undo).toHaveLength(1); // outer untouched
        expect(sandbox()?.undo).toHaveLength(1); // the sandbox took it
        exitOptimizeMode(state);
    });

    test("in-mode undo/redo operate over the sandbox only; undo at the start EXITS; pre-mode stays applied", () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        bump(h, state, sec); // pre-mode edit (crest +0.6)
        const preEntry = docState(state, eid);

        enterOptimizeMode(state, sec);
        bump(h, state, sec); // in-mode edit (crest +1.2 now)
        const edited = docState(state, eid);
        expect(edited).not.toEqual(preEntry);

        undoRouted(h, state); // reverts the in-mode edit — sandbox scope, mode stays open
        state.step(0);
        expect(docState(state, eid)).toEqual(preEntry);
        expect(editor.optimizing).not.toBeNull();
        expect(h.undo).toHaveLength(1); // the pre-mode edit was NOT popped (unreachable inside)

        redoRouted(h, state); // the in-mode edit replays — sandbox scope
        state.step(0);
        expect(docState(state, eid)).toEqual(edited);
        undoRouted(h, state); // back off again

        undoRouted(h, state); // at the sandbox's start: acts as EXIT
        state.step(0);
        expect(editor.optimizing).toBeNull();
        expect(docState(state, eid)).toEqual(preEntry); // the pre-mode edit still applied
        expect(h.undo).toHaveLength(1);
        expect(h.redo).toHaveLength(0); // …and no trace on the outer redo

        undoRouted(h, state); // mode closed — the outer path works again
        state.step(0);
        expect(docState(state, eid)).not.toEqual(preEntry); // the pre-mode edit undone now
    });

    test("Exit discards without trace: outer undo AND redo byte-identical, pre-mode redo survives", () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        bump(h, state, sec);
        undo(h, state); // → a live pre-mode redo branch
        state.step(0);
        expect(h.redo).toHaveLength(1);
        const preEntry = docState(state, eid);

        enterOptimizeMode(state, sec);
        expect(h.redo).toHaveLength(1); // entry does NOT clear the outer redo (no outer record)
        bump(h, state, sec);
        bump(h, state, sec);
        exitOptimizeMode(state);
        state.step(0);

        expect(editor.optimizing).toBeNull();
        expect(docState(state, eid)).toEqual(preEntry); // every in-mode edit reverted
        expect(h.undo).toHaveLength(0);
        expect(h.redo).toHaveLength(1); // the pre-mode redo branch survived untouched
        redo(h, state); // …and still replays
        state.step(0);
        expect(docState(state, eid)).not.toEqual(preEntry);
    });

    test("Solve = ONE outer entry; undo REOPENS with the experiment resumed; redo re-lands and closes", async () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        const preEntry = docState(state, eid);

        enterOptimizeMode(state, sec);
        bump(h, state, sec); // edit 1
        bump(h, state, sec); // edit 2
        undoRouted(h, state); // edit 2 undone in-mode — it sits on the SANDBOX redo
        state.step(0);
        const draft = docState(state, eid); // edit 1 applied, edit 2 undone
        const rows = sectionForces(state, sec);
        editor.locked = new Set([rows[0].id]);

        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        const result = await runOptimizeSection(h, state, session, editor.locked);
        expect(result.outcome).toBe("solved");
        expect(editor.optimizing).toBeNull(); // Solve confirmed AND closed
        state.step(0);
        const landed = docState(state, eid);
        expect(h.undo).toHaveLength(1); // ONE outer entry — the whole experiment
        expect(sandbox()).toBeNull();

        undoRouted(h, state); // undo the landing: the experiment RESUMES
        state.step(0);
        expect(editor.optimizing).not.toBeNull();
        expect(docState(state, eid)).toEqual(draft); // the edited-but-unsolved draft
        expect(editor.locked.size).toBe(1); // locks restored
        expect(sandbox()?.undo).toHaveLength(1); // edit 1 undoable again…
        expect(sandbox()?.redo).toHaveLength(1); // …and edit 2 still REDOABLE (full resume)

        redoRouted(h, state); // redo inside the resumed experiment replays edit 2 (sandbox scope)
        state.step(0);
        expect(docState(state, eid)).not.toEqual(draft);
        expect(editor.optimizing).not.toBeNull(); // still in the mode — that was a sandbox redo
        undoRouted(h, state); // back off edit 2 → the sandbox redo holds it again

        // now AT the resumed sandbox's end with nothing left on its redo? no — edit 2 is on the
        // sandbox redo, so redo routes there first; walk the contract's own case instead: the
        // plain undo-then-redo cycle.
        redoRouted(h, state); // edit 2 back (sandbox)
        expect(sandbox()?.redo).toHaveLength(0);
        redoRouted(h, state); // at the sandbox's END, resumed → falls through: RE-LANDS + closes
        state.step(0);
        expect(editor.optimizing).toBeNull();
        expect(docState(state, eid)).toEqual(landed);
        expect(h.undo).toHaveLength(1);

        // reopen again: the frozen redo still carries edit 2, so redo walks the SANDBOX first
        // and only falls through to the re-land at the true end of the resumed experiment.
        undoRouted(h, state); // reopen
        expect(editor.optimizing).not.toBeNull();
        expect(sandbox()?.redo).toHaveLength(1); // edit 2, frozen at solve time
        redoRouted(h, state); // edit 2 (sandbox)
        expect(editor.optimizing).not.toBeNull();
        redoRouted(h, state); // the end → re-land
        state.step(0);
        expect(editor.optimizing).toBeNull();
        expect(docState(state, eid)).toEqual(landed);

        // walking a resumed experiment all the way out exits at its start with no outer trace
        // beyond the landing sitting on the outer redo.
        undoRouted(h, state); // reopen again (sandbox undo: [edit 1], redo: [edit 2])
        undoRouted(h, state); // edit 1 off
        expect(editor.optimizing).not.toBeNull();
        undoRouted(h, state); // at the start → exits
        state.step(0);
        expect(editor.optimizing).toBeNull();
        expect(docState(state, eid)).toEqual(preEntry);
        expect(h.undo).toHaveLength(0);
        redoRouted(h, state); // outer redo still holds the landing → re-lands from pre-entry
        state.step(0);
        expect(docState(state, eid)).toEqual(landed);
    });

    test("the straight cycle: Solve, Ctrl+Z (reopen), Ctrl+Shift+Z (re-land) — no in-mode undos", async () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterOptimizeMode(state, sec);
        bump(h, state, sec);
        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        expect((await runOptimizeSection(h, state, session, editor.locked)).outcome).toBe("solved");
        state.step(0);
        const landed = docState(state, eid);

        undoRouted(h, state); // reopen — frozen sandbox redo is EMPTY here
        expect(editor.optimizing).not.toBeNull();
        expect(sandbox()?.redo).toHaveLength(0);
        redoRouted(h, state); // → falls through to the outer redo: re-lands and closes
        state.step(0);
        expect(editor.optimizing).toBeNull();
        expect(docState(state, eid)).toEqual(landed);
    });

    test("a NEW edit in a resumed experiment forks: redo stays in the sandbox, no accidental re-land", async () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterOptimizeMode(state, sec);
        bump(h, state, sec);
        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        expect((await runOptimizeSection(h, state, session, editor.locked)).outcome).toBe("solved");
        state.step(0);

        undoRouted(h, state); // resume the experiment
        expect(editor.optimizing).not.toBeNull();
        const beforeFork = docState(state, eid);
        bump(h, state, sec); // a NEW in-mode edit — the fork
        redoRouted(h, state); // sandbox redo is empty AND the re-land offer is cleared → no-op
        expect(editor.optimizing).not.toBeNull(); // did NOT re-land over the new edit
        state.step(0);
        expect(docState(state, eid)).not.toEqual(beforeFork); // the new edit survived
        exitOptimizeMode(state);
    });

    test("a Solve resolving AFTER the mode closed writes nothing — the no-trace guarantee is a module invariant", async () => {
        // RED FIRST on 9f3dc41 (review finding A): the only post-await staleness check was
        // `authoredHash`, which detects a changed draft, not a closed mode — a late-resolving
        // Solve landed one outer entry after the user exited expecting no trace. The UI paths
        // that make this hard to reach (inert content, Escape ordering) are accidents, not
        // invariants; the module must enforce it. This is the reviewer's exact probe.
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterOptimizeMode(state, sec);
        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        const before = docState(state, eid);

        const run = runOptimizeSection(h, state, session, editor.locked);
        exitOptimizeMode(state); // synchronous close while the solve is in flight

        let threw: unknown;
        try {
            await run;
        } catch (e) {
            threw = e;
        }
        expect(threw).toBeInstanceOf(StaleOptimize);
        state.step(0);
        expect(docState(state, eid)).toEqual(before); // byte-identical
        expect(h.undo).toHaveLength(0); // the exit's no-trace contract survived the late resolve
        expect(editor.optimizing).toBeNull();
    });

    test("a re-entered session mid-flight is a DIFFERENT session — the stale solve still discards", async () => {
        // the identity check is per-session, not per-mode-openness: exit + re-enter while the
        // old solve is in flight must not let the old result land into the new session.
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterOptimizeMode(state, sec);
        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        const run = runOptimizeSection(h, state, session, editor.locked);
        exitOptimizeMode(state);
        state.step(0);
        expect(enterOptimizeMode(state, sec)).toBe(true); // a NEW session, same section
        const before = docState(state, eid);

        let threw: unknown;
        try {
            await run;
        } catch (e) {
            threw = e;
        }
        expect(threw).toBeInstanceOf(StaleOptimize);
        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
        expect(editor.optimizing).not.toBeNull(); // the new session is untouched
        exitOptimizeMode(state);
    });

    test("the lock ledger freezes AT INVOKE — an in-place clear mid-flight can't empty it", async () => {
        // RED FIRST on 9f3dc41 (review finding B): `relock` was built from the live
        // `editor.locked` AFTER the await, and `endOptimize` clears that Set in place — so any
        // mid-flight clear emptied the landing's ledger and an undo-reopen lost the locks.
        const { state, sec } = forceTrack();
        const h = createHistory();
        enterOptimizeMode(state, sec);
        bump(h, state, sec);
        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        const rows = sectionForces(state, sec);
        editor.locked.add(rows[0].id);

        const run = runOptimizeSection(h, state, session, editor.locked);
        editor.locked.clear(); // the in-place mutation `endOptimize` performs, mid-flight
        const result = await run;
        expect(result.outcome).toBe("solved");
        state.step(0);

        undoRouted(h, state); // reopen — the ledger must be the one frozen at Solve-press time
        expect(editor.optimizing).not.toBeNull();
        expect(editor.locked.size).toBe(1);
        expect(editor.locked.has(rows[0].id)).toBe(true);
        exitOptimizeMode(state);
    });

    test("the sandbox is EXEMPT from MAX_UNDO eviction: Exit stays byte-identical past 256 in-mode edits", () => {
        // RED FIRST on 333aaa7 (architectural pass, item 1): `record` applied the shift-past-256
        // eviction to the redirect target too, so the 257th in-mode entry (every arrow-nudge is
        // one) evicted the FIRST — and Exit, which discards by replaying reverses, left that
        // edit applied with no trace. The stage-4 eviction hazard resurfacing (that fix died
        // with the bracket): the sandbox is bounded by the mode's lifetime, so it grows instead.
        // seen failing here on the byte-compare with the crest stuck at edit 1's value.
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        const preEntry = docState(state, eid);
        enterOptimizeMode(state, sec);
        const rows = sectionForces(state, sec);
        for (let i = 0; i < 257; i++) {
            beginForceMove(state, rows[2].id);
            setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.1 + (i % 2) * 0.1);
            commit(h);
        }
        expect(sandbox()?.undo).toHaveLength(257); // nothing evicted — the sandbox grew
        exitOptimizeMode(state);
        state.step(0);
        expect(editor.optimizing).toBeNull();
        expect(docState(state, eid)).toEqual(preEntry); // every one of the 257 reversed
        expect(h.undo).toHaveLength(0);
    });

    test("the frozen Solve entry carries ALL sandbox entries past 256 — undo-reopen loses none", async () => {
        // the same hazard's other face: the landing froze the (already-evicted) stacks, so an
        // undo-reopen resumed an experiment missing its earliest edit. seen failing on the
        // depth pin (256) before the eviction exemption.
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        const preEntry = docState(state, eid);
        enterOptimizeMode(state, sec);
        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        const rows = sectionForces(state, sec);
        for (let i = 0; i < 257; i++) {
            beginForceMove(state, rows[2].id);
            setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.1 + (i % 2) * 0.1);
            commit(h);
        }
        state.step(0);
        expect((await runOptimizeSection(h, state, session, editor.locked)).outcome).toBe("solved");
        state.step(0);
        undoRouted(h, state); // reopen — the resumed experiment must hold all 257
        expect(sandbox()?.undo).toHaveLength(257);
        exitOptimizeMode(state); // …and the discard walks every one back to pre-entry
        state.step(0);
        expect(docState(state, eid)).toEqual(preEntry);
        expect(h.undo).toHaveLength(0);
    });

    test("Exit skips a live paced landing (history navigation never eases toward erased values)", () => {
        // carried from stage 5's adversarial finding 2 (the exit route): the discard must clear
        // a running landing or its frozen moves keep easing diamonds toward erased values.
        const { state, sec } = forceTrack();
        enterOptimizeMode(state, sec);
        beginLanding([{ id: 1, from: 0, to: 1 }]);
        expect(editor.landing).not.toBeNull();
        exitOptimizeMode(state);
        expect(editor.landing).toBeNull();
    });

    test("a refusal stays in the mode: draft + histories untouched, locks intact", async () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterOptimizeMode(state, sec);
        const session = editor.optimizing;
        if (!session) throw new Error("no session");

        // starve the free set below MIN_FREE — the counting certificate refuses at invoke.
        const rows = sectionForces(state, sec);
        const locked = new Set(rows.slice(0, rows.length - 2).map((r) => r.id));
        for (const id of locked) editor.locked.add(id);
        const before = docState(state, eid);
        const sbDepth = sandbox()?.undo.length ?? -1;

        const result = await runOptimizeSection(h, state, session, editor.locked);
        expect(result.outcome).toBe("unreachable");
        expect(result.reason).toBe("free-count");
        state.step(0);
        expect(docState(state, eid)).toEqual(before); // byte-identical, still in-mode
        expect(h.undo).toHaveLength(0); // refusal records nothing outer…
        expect(sandbox()?.undo.length).toBe(sbDepth); // …nor in the sandbox
        expect(editor.optimizing).not.toBeNull();
        expect(editor.locked.size).toBe(locked.size); // lock persistence across solves in-mode
        exitOptimizeMode(state);
        expect(editor.locked.size).toBe(0); // …and exit discards the locks
    });
});

describe("the downstream freeze (kex2d-optimize-mode stage 7)", () => {
    // two force sections; the mode on the FIRST freezes the second's placement at its
    // mode-entry state — no live repropagation of the wandering exit — and any close unfreezes.

    beforeEach(() => {
        if (editor.optimizing !== null) endOptimize();
    });

    function twoSections(): { state: State; eid: number; sec: number; secB: number } {
        const { state, eid, sec } = forceTrack();
        const secB = createSection(state, 1, SectionKind.Force, 30);
        createForcePoint(state, secB, 0, 1);
        createForcePoint(state, secB, 10, 1.3);
        createForcePoint(state, secB, 20, 1);
        createForcePoint(state, secB, 30, 1);
        state.step(0);
        return { state, eid, sec, secB };
    }

    function bump(h: ReturnType<typeof createHistory>, state: State, sec: number): void {
        const rows = sectionForces(state, sec);
        beginForceMove(state, rows[2].id);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.6);
        commit(h);
        state.step(0);
    }

    test("downstream holds its mode-entry state across an in-mode edit; Exit repropagates", () => {
        const { state, eid, sec, secB } = twoSections();
        const h = createHistory();
        const entryB0 = { ...(sectionInfo.get(secB)?.entry ?? { x: 0, y: 0, theta: 0, v: 0 }) };

        enterOptimizeMode(state, sec);
        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        bump(h, state, sec); // the optimizing section's exit wanders…
        const infoA = sectionInfo.get(sec);
        const infoB = sectionInfo.get(secB);
        const s = samples.get(eid);
        if (!infoA || !infoB || !s) throw new Error("no bake");

        // …but downstream holds its mode-entry entry BIT-IDENTICAL (the freeze).
        expect(infoB.entry.x).toBe(entryB0.x);
        expect(infoB.entry.y).toBe(entryB0.y);
        expect(infoB.entry.theta).toBe(entryB0.theta);
        expect(infoB.entry.v).toBe(entryB0.v);
        // the frozen bake does NOT share the boundary sample — the seam is the visible gap:
        // downstream starts at its own sample, placed at the FROZEN entry (= the stamp), while
        // the live exit sits elsewhere.
        expect(infoB.startSample).toBe(infoA.endSample + 1);
        expect(s.posX[infoB.startSample]).toBeCloseTo(session.stamp.x, 4);
        expect(s.posY[infoB.startSample]).toBeCloseTo(session.stamp.y, 4);
        // positive control: the live exit really moved off the stamp (the gap is real).
        const gapX = Math.abs(s.posX[infoA.endSample] - session.stamp.x);
        const gapY = Math.abs(s.posY[infoA.endSample] - session.stamp.y);
        expect(gapX + gapY).toBeGreaterThan(0.01);

        exitOptimizeMode(state);
        state.step(0);
        // unfrozen: the chain shares the boundary sample again and downstream re-propagates —
        // the draft was restored, so downstream is back at its pre-entry placement.
        const infoA2 = sectionInfo.get(sec);
        const infoB2 = sectionInfo.get(secB);
        if (!infoA2 || !infoB2) throw new Error("no bake after exit");
        expect(infoB2.startSample).toBe(infoA2.endSample);
        expect(infoB2.entry.x).toBe(entryB0.x);
        expect(infoB2.entry.y).toBe(entryB0.y);
    });

    test("a landed Solve unfreezes with downstream where it was (the stamp restored)", async () => {
        const { state, sec, secB } = twoSections();
        const h = createHistory();
        const entryB0 = { ...(sectionInfo.get(secB)?.entry ?? { x: 0, y: 0, theta: 0, v: 0 }) };

        enterOptimizeMode(state, sec);
        const session = editor.optimizing;
        if (!session) throw new Error("no session");
        bump(h, state, sec);
        const result = await runOptimizeSection(h, state, session, editor.locked);
        expect(result.outcome).toBe("solved");
        state.step(0);

        const infoA = sectionInfo.get(sec);
        const infoB = sectionInfo.get(secB);
        if (!infoA || !infoB) throw new Error("no bake after solve");
        expect(infoB.startSample).toBe(infoA.endSample); // unfrozen — shared boundary again
        // downstream lands where it was: the solved exit restored the stamp, so the entry is
        // back within the solve's own floor of its mode-entry value (the mechanisms' own
        // disagreement, not a tuned number — the solver suite pins the floor itself; here the
        // claim is placement-scale identity, asserted at display precision).
        expect(infoB.entry.x).toBeCloseTo(entryB0.x, 3);
        expect(infoB.entry.y).toBeCloseTo(entryB0.y, 3);
        expect(infoB.entry.theta).toBeCloseTo(entryB0.theta, 3);
    });
});
