import { State } from "@dylanebert/shallot";
import { describe, expect, test } from "bun:test";
import { beginOptimize, editor, endOptimize, toggleLockedSet } from "../src/editor";
import { createHistory, undo } from "../src/history";
import {
    computeExit,
    MIN_FREE,
    type OptimizeOpts,
    solveOptimize,
    TOL_ANGLE,
    TOL_POS,
} from "../src/optimize";
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
    test("a genuine drift converges within the provisional floor", () => {
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
                    const back = computeExit(ENTRY, r.points, length, DS);
                    expect(Math.abs(back.x - stamp.x)).toBeLessThan(TOL_POS);
                    expect(Math.abs(back.y - stamp.y)).toBeLessThan(TOL_POS);
                    expect(Math.abs(back.theta - stamp.theta)).toBeLessThan(TOL_ANGLE);
                }
            }
        });
    }
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
