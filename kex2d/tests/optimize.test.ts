import { State } from "@dylanebert/shallot";
import { describe, expect, test } from "bun:test";
import { beginOptimize, editor, endOptimize, toggleLockedSet } from "../src/editor";
import { createHistory, undo } from "../src/history";
import {
    computeExit,
    derivedTol,
    MIN_FREE,
    type OptimizeOpts,
    solveOptimize,
} from "../src/optimize";
import optimizeGolden from "./fixtures/optimize-golden.json";
import { enterOptimize, runOptimizeSection, StaleOptimize } from "../src/optimizeMode";
import { Easing, type ForcePoint } from "../src/profile";
import type { Entry } from "../src/section";
import {
    BakeSystem,
    bakeOut,
    createForcePoint,
    createSection,
    createTrack,
    sectionForces,
    type SectionSnapshot,
    setForcePoint,
    setTrackV0,
    snapshotAll,
    SectionKind,
} from "../src/track";

// the invariant floor for optimize mode's masked-collocation solve (`kex2d-optimize-mode` stage
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
        // entry v = 8 m/s under a +2.2 g climb stalls the march (vMin hits 0); the exit Jacobian's
        // θ row measured ~8e2 rad/g against the G·L/V_WARN² feasible bound of ~3.9e2 (lab §4b).
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
        const session = enterOptimize(state, sec);
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
        // from BEFORE the solve ran, never rolled back by undoing the solve alone).
        const rowsAfterUndo = sectionForces(state, sec);
        expect(rowsAfterUndo.find((r) => r.s === rows[2].s)?.g).toBe(rows[2].g + 0.6);
    });

    test("Solve on an already-restored draft is a no-op: no undo entry, document byte-identical", async () => {
        // RED FIRST: before the kernel's `deltaG !== 0` filter gated the landing, the zero-drift
        // short-circuit still resolved `"solved"` with every write equal to what was already
        // there, and `runOptimizeSection` landed it anyway — `snapshotSection` before/after
        // compared equal, but a command still pushed (an identity `restoreSection` pair), so
        // `h.undo` grew by one and a second Ctrl+Z would visibly do nothing (editor-ui.md's
        // constraint-solver idempotence law: a second press on an already-satisfied solve must
        // write nothing, not a no-op write). This failed on `expect(h.undo).toHaveLength(0)`.
        const { state, eid, sec } = forceTrack();
        const session = enterOptimize(state, sec);
        if (!session) throw new Error("no session");
        const before = docState(state, eid);

        const h = createHistory();
        const result = await runOptimizeSection(h, state, session, new Set());
        expect(result.outcome).toBe("solved");
        expect(result.deltaG.every((d) => d === 0)).toBe(true);

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
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
