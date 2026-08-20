import { describe, expect, test } from "bun:test";
import { forces, replay } from "../src/bake";
import { loss } from "../src/forward";
import {
    chain,
    Domain,
    type Entry,
    evalForce,
    evalGeo,
    localize,
    place,
    type Section,
} from "../src/section";
import type { Node } from "../src/spline";
import { withThetas } from "./helpers/chain";
import { rk4Time } from "./oracles/rk4";

// the section substrate (kex2d/AGENTS.md, the section substrate): entry → sampled points
// → exit, chained by anchor propagation. the two atoms wrap the oracle-gated
// integrator (`forward.integrate`) and the display recovery (`bake.forces`), so
// physics carries from those gates; these tests pin the CONTRACT the substrate
// adds — rigid placement, the geometry-recovered display force, and
// chain continuity. device-free (canvas2D + pure math, no GPU).

const G = 9.80665;
const V0 = 10;

describe("localize", () => {
    test("is the exact inverse of place: place(entry, localize(entry, p)) === p", () => {
        // the ECS layer authors handles in world space; the bake localizes them into
        // the section entry frame before evalGeo places them back. a non-identity
        // entry (rotated + translated) exercises the full rigid transform.
        const entry: Entry = { x: 17, y: -9, theta: 0.7, v: 12 };
        for (const p of [
            { x: 17, y: -9, theta: 0.7 }, // the entry itself → local origin
            { x: 40, y: 3, theta: -0.2 },
            { x: -8, y: 21, theta: 1.4 },
        ]) {
            const local = localize(entry, p);
            const back = place(entry, local);
            expect(back.x).toBeCloseTo(p.x, 4);
            expect(back.y).toBeCloseTo(p.y, 4);
            expect(back.theta).toBeCloseTo(p.theta, 6);
        }
        // the entry maps to the local origin, heading 0 — node 0 IS the entry.
        const origin = localize(entry, { x: entry.x, y: entry.y, theta: entry.theta });
        expect(origin.x).toBeCloseTo(0, 6);
        expect(origin.y).toBeCloseTo(0, 6);
        expect(origin.theta).toBeCloseTo(0, 6);
    });
});

describe("evalGeo", () => {
    test("a flat geo section holds ~1g and conserves launch speed", () => {
        const local = withThetas([
            { x: 0, y: 0 },
            { x: 24, y: 0 },
        ]);
        const r = evalGeo({ x: 0, y: 0, theta: 0, v: V0 }, local, 0.5);
        for (let i = 0; i < r.edges; i++) expect(r.fN[i]).toBeCloseTo(1, 3);
        expect(r.exit.v).toBeCloseTo(V0, 4);
        expect(r.exit.y).toBeCloseTo(0, 4);
    });

    test("places the local shape rigidly at the entry frame", () => {
        // node 0 at the local origin, heading 0 (withThetas gives node 0 θ = 0).
        const local: Node[] = withThetas([
            { x: 0, y: 0 },
            { x: 20, y: 4 },
            { x: 44, y: 0 },
        ]);
        const a: Entry = { x: 0, y: 0, theta: 0, v: V0 }; // identity placement
        const b: Entry = { x: 17, y: -9, theta: 0.7, v: V0 };
        const ra = evalGeo(a, local, 0.5);
        const rb = evalGeo(b, local, 0.5);
        expect(ra.edges).toBe(rb.edges);
        // un-transform B's world samples by B's frame → the identity-placed local
        // curve, which A's samples already are. the geometry is rigidly equivariant
        // (Hermite sampling is affine), exact to f32 — physics (fN) is NOT invariant
        // (gravity picks a world frame), so this pins positions only.
        const c = Math.cos(b.theta);
        const s = Math.sin(b.theta);
        for (let i = 0; i <= ra.edges; i++) {
            const dx = rb.posX[i] - b.x;
            const dy = rb.posY[i] - b.y;
            const lx = c * dx + s * dy;
            const ly = -s * dx + c * dy;
            expect(lx).toBeCloseTo(ra.posX[i], 2);
            expect(ly).toBeCloseTo(ra.posY[i], 2);
        }
    });

    test("offsets are the sample index of each authored node (the Handle.sample map)", () => {
        const local = withThetas([
            { x: 0, y: 0 },
            { x: 20, y: 4 },
            { x: 44, y: 0 },
        ]);
        const r = evalGeo({ x: 0, y: 0, theta: 0, v: V0 }, local, 0.5);
        expect(r.offsets.length).toBe(local.length);
        expect(r.offsets[0]).toBe(0);
        expect(r.offsets[r.offsets.length - 1]).toBe(r.edges); // last node = last sample
        for (let k = 0; k < local.length; k++) {
            expect(r.posX[r.offsets[k]]).toBeCloseTo(local[k].x, 4);
            expect(r.posY[r.offsets[k]]).toBeCloseTo(local[k].y, 4);
        }
    });
});

describe("evalForce", () => {
    test("is the oracle-gated forward integrator (carries)", () => {
        // the force→geometry map IS `forward.integrate` (round-trip-gated against
        // RK4 in forward.test / rk4.test). evalForce must reproduce `bake.replay`
        // from the same seed exactly — the atom is the integrator, not a re-impl.
        const entry: Entry = { x: 3, y: 1, theta: 0.2, v: 12 };
        const ds = 0.5;
        const edges = 30;
        const fN = Float32Array.from({ length: edges }, (_, i) => 1 + 0.4 * Math.sin(i / 5));
        const r = evalForce(entry, fN, { edges, ds });

        const n = edges + 1;
        const rx = new Float32Array(n);
        const ry = new Float32Array(n);
        const rt = new Float32Array(n);
        const rv = new Float32Array(n);
        const dsArr = new Float32Array(edges).fill(ds);
        replay(rx, ry, rt, rv, fN, dsArr, entry.x, entry.y, entry.theta, entry.v, n);
        for (let i = 0; i < n; i++) {
            expect(r.posX[i]).toBe(rx[i]);
            expect(r.posY[i]).toBe(ry[i]);
        }
    });

    test("the recovered display force converges to the authored force as O(ds)", () => {
        // a force section re-recovers its display force from the swept geometry.
        // the recovery (chord-bisector centering) sits O(ds) off the authored input
        // — the source-vs-centered convention gap. derived, not tuned: halving ds
        // must roughly halve the max interior gap (O(ds), not O(1)).
        const entry: Entry = { x: 0, y: 0, theta: 0, v: 16 };
        const authored = (s: number): number => 1 + 0.5 * Math.sin(s / 8);
        const gap = (ds: number): number => {
            const len = 32;
            const edges = Math.round(len / ds);
            const fN = Float32Array.from({ length: edges }, (_, i) => authored(i * ds));
            const r = evalForce(entry, fN, { edges, ds });
            let mx = 0;
            for (let i = 2; i < edges - 2; i++)
                mx = Math.max(mx, Math.abs(r.fN[i] - authored(i * ds)));
            return mx;
        };
        const coarse = gap(0.5);
        const fine = gap(0.25);
        expect(fine).toBeLessThan(coarse); // it shrinks
        expect(fine).toBeLessThan(0.65 * coarse); // ~halving → O(ds)
    });
});

describe("evalForce — time domain", () => {
    test("distance-domain callers are untouched (default Domain.Distance, no 4th arg)", () => {
        // the domain param must default to Distance so every existing call site
        // (3 positional args, this file's own prior tests included) stays on the
        // exact prior code path — no drive-by refactor of the distance branch.
        const entry: Entry = { x: 3, y: 1, theta: 0.2, v: 12 };
        const ds = 0.5;
        const fN = Float32Array.from({ length: 20 }, (_, i) => 1 + 0.3 * Math.sin(i / 4));
        const step = { edges: fN.length, ds };
        const withDefault = evalForce(entry, fN, step);
        const withExplicit = evalForce(entry, fN, step, Domain.Distance);
        for (let i = 0; i <= 20; i++) {
            expect(withDefault.posX[i]).toBe(withExplicit.posX[i]);
            expect(withDefault.posY[i]).toBe(withExplicit.posY[i]);
        }
    });

    test("positions match the time-parameterized RK4 oracle, gap shrinking with Δt", () => {
        // rk4Time is an independent scheme in the SAME parameterization as the new
        // path (time), so it's the strongest oracle for it — mirrors the
        // collocate.test.ts "forward64 and rk4 agree" shape: gap at two step
        // sizes, an absolute cap, and a ratio proving the gap actually shrinks
        // with the step (derived from the scheme, not tuned).
        const entry: Entry = { x: 2, y: -1, theta: 0.15, v: 14 };
        const authored = (t: number): number => 1 + 0.3 * Math.sin(t * 2);
        const duration = 2; // seconds

        const gap = (dt: number): number => {
            const edges = Math.round(duration / dt);
            const fN = Float32Array.from({ length: edges }, (_, i) => authored(i * dt));
            const r = evalForce(entry, fN, { edges, ds: dt }, Domain.Time);
            const ref = rk4Time(entry.x, entry.y, entry.theta, entry.v, edges + 1, dt, authored);
            const last = ref[edges];
            return Math.hypot(r.posX[edges] - last[0], r.posY[edges] - last[1]);
        };

        const g0 = gap(0.02);
        const g1 = gap(0.01);
        expect(g0).toBeLessThan(0.5); // coarse absolute cap over a 2 s / ~28 m run
        expect(g0 / g1).toBeGreaterThan(1.8); // shrinks with Δt (at least first order)
    });

    test("constant force: time domain converges to the distance domain's swept exit", () => {
        // for a force authored as a constant (domain-agnostic: the same number
        // regardless of whether it's indexed by σ or by t), both domains
        // discretize the identical continuous arclength ODE, so they must
        // converge to the SAME exit — but only over the SAME physical
        // trajectory. duration and length aren't freely interchangeable via the
        // entry speed alone: v drifts with height (energy), so `duration =
        // length / v_entry` does NOT correspond to `length` meters once the
        // climb bends v away from v_entry (measured: fixing both independently
        // left an O(1) gap that never shrank — the wrong equivalence). the
        // right correspondence is the trajectory's OWN elapsed time, so a fine
        // distance-domain reference supplies it (midpoint-v quadrature over its
        // own realized ds/v — the same energy-conservation form the atom
        // itself uses), and time domain runs that exact duration.
        const entry: Entry = { x: 0, y: 0, theta: 0, v: 12 };
        const F = 1.2;
        const length = 20; // meters

        const dsFine = 0.01;
        const edgesFine = Math.round(length / dsFine);
        const fNFine = new Float32Array(edgesFine).fill(F);
        const refFine = evalForce(entry, fNFine, { edges: edgesFine, ds: dsFine });
        let duration = 0;
        for (let i = 0; i < refFine.edges; i++) {
            const vMid = 0.5 * (refFine.v[i] + refFine.v[i + 1]);
            duration += refFine.ds[i] / vMid;
        }

        const gap = (ds: number): number => {
            const edges = Math.round(length / ds);
            const fND = new Float32Array(edges).fill(F);
            const rD = evalForce(entry, fND, { edges, ds });

            const dt = duration / edges;
            const fNT = new Float32Array(edges).fill(F);
            const rT = evalForce(entry, fNT, { edges, ds: dt }, Domain.Time);

            return Math.hypot(rD.exit.x - rT.exit.x, rD.exit.y - rT.exit.y);
        };

        const g0 = gap(0.5);
        const g1 = gap(0.25);
        expect(g0).toBeLessThan(0.2); // coarse absolute cap over a 20 m run
        expect(g0 / g1).toBeGreaterThan(1.8); // shrinks with the step (at least O(step))
    });

    test("O(Δt) convergence: halving Δt roughly halves the gap to a fine-Δt reference", () => {
        // self-convergence, independent of the RK4 oracle: a much finer time
        // step stands in for the continuum limit, and the gap from a coarser
        // step to it should shrink at the scheme's own order as Δt halves
        // (mirrors the "recovered display force converges as O(ds)" distance
        // test's shape — halving, not quartering, since this measures the
        // exit position of the SAME semi-implicit step rule applied on the
        // time grid, whose F_n resampling — piecewise-constant per Δt — caps
        // the observable order at first, same as the distance path's σ
        // resampling).
        const entry: Entry = { x: 0, y: 0, theta: 0.1, v: 15 };
        const authored = (t: number): number => 1 + 0.4 * Math.sin(t * 1.5);
        const duration = 3;

        const fine = 0.001;
        const edgesFine = Math.round(duration / fine);
        const fNFine = Float32Array.from({ length: edgesFine }, (_, i) => authored(i * fine));
        const ref = evalForce(entry, fNFine, { edges: edgesFine, ds: fine }, Domain.Time);
        const refExit = { x: ref.exit.x, y: ref.exit.y };

        const gap = (dt: number): number => {
            const edges = Math.round(duration / dt);
            const fN = Float32Array.from({ length: edges }, (_, i) => authored(i * dt));
            const r = evalForce(entry, fN, { edges, ds: dt }, Domain.Time);
            return Math.hypot(r.exit.x - refExit.x, r.exit.y - refExit.y);
        };

        const coarse = gap(0.04);
        const finer = gap(0.02);
        expect(finer).toBeLessThan(coarse); // it shrinks
        expect(finer).toBeLessThan(0.65 * coarse); // ~halving → O(Δt)
    });
});

describe("chain", () => {
    test("threads exit → entry with C0/C1 continuity and contiguous ranges", () => {
        const geo: Node[] = withThetas([
            { x: 0, y: 0 },
            { x: 20, y: 3 },
            { x: 44, y: 0 },
        ]);
        const force = Float32Array.from({ length: 30 }, () => 1.2);
        const sections: Section[] = [
            { kind: "geo", nodes: geo, ds: 0.5 },
            { kind: "force", fN: force, step: { edges: force.length, ds: 0.5 } },
            { kind: "geo", nodes: geo, ds: 0.5 },
        ];
        const c = chain({ x: 0, y: 0, theta: 0, v: V0 }, sections);

        // ranges are contiguous, sharing the boundary sample; the last range ends
        // at the final point.
        expect(c.ranges[0].start).toBe(0);
        for (let k = 1; k < c.ranges.length; k++)
            expect(c.ranges[k].start).toBe(c.ranges[k - 1].end);
        expect(c.ranges[c.ranges.length - 1].end).toBe(c.count - 1);

        // exit ≡ the shared boundary sample ≡ the next section's entry (C0 + C1,
        // no tolerance — the boundary point is literally shared, and the next
        // section is placed from this exact state).
        for (let k = 0; k < c.exits.length; k++) {
            const i = c.ranges[k].end;
            expect(c.exits[k].x).toBe(c.posX[i]);
            expect(c.exits[k].y).toBe(c.posY[i]);
            expect(c.exits[k].theta).toBe(c.theta[i]);
            expect(c.exits[k].v).toBe(c.v[i]);
        }

        // cumulative arclength is monotone across the boundaries (no gap/overlap).
        let acc = 0;
        for (let i = 0; i < c.count - 1; i++) {
            expect(c.ds[i]).toBeGreaterThan(0);
            acc += c.ds[i];
        }
        expect(acc).toBeGreaterThan(0);

        // per-section results carry the metadata the flat SoA drops; each section's
        // local offsets translate to global via ranges[k].start.
        expect(c.results.length).toBe(sections.length);
        for (let k = 0; k < c.results.length; k++) {
            const res = c.results[k];
            expect(res.offsets[0]).toBe(0);
            expect(res.offsets[res.offsets.length - 1]).toBe(res.edges);
            const globalStart = c.ranges[k].start + res.offsets[0];
            const globalEnd = c.ranges[k].start + res.offsets[res.offsets.length - 1];
            expect(globalStart).toBe(c.ranges[k].start);
            expect(globalEnd).toBe(c.ranges[k].end);
        }
    });

    test("energy is conserved across section boundaries (v² = v0² − 2gΔy)", () => {
        // a gentle climb that stays feasible (peak well under the ~5.1 m energy
        // budget at V0=10), so no v-floor clamp fires and the energy telescopes
        // exactly to the net height across BOTH sections.
        const lead = withThetas([
            { x: 0, y: 0 },
            { x: 24, y: 1.5 },
        ]);
        const hill = withThetas([
            { x: 0, y: 0 },
            { x: 20, y: 1 },
            { x: 44, y: 2 },
        ]);
        const c = chain({ x: 0, y: 0, theta: 0, v: V0 }, [
            { kind: "geo", nodes: lead, ds: 0.5 },
            { kind: "geo", nodes: hill, ds: 0.5 },
        ]);
        const last = c.count - 1;
        const expected = Math.sqrt(Math.max(0, V0 * V0 - 2 * G * c.posY[last]));
        expect(c.v[last]).toBeCloseTo(expected, 3);
    });

    test("threads a force section's domain to evalForce (a time section's ds means Δt)", () => {
        // an omitted `domain` (the geo/distance-force sections above) must stay
        // on the Distance branch; a `domain: Domain.Time` section's `ds` field
        // is consumed as Δt, so its per-edge ds is the variable v·Δt, not a
        // fixed step — chain must pass the field through, not silently drop it.
        const dt = 0.02;
        const edges = 40;
        const fN = new Float32Array(edges).fill(1.2);
        const sections: Section[] = [
            { kind: "force", fN, step: { edges, ds: dt }, domain: Domain.Time },
        ];
        const c = chain({ x: 0, y: 0, theta: 0, v: V0 }, sections);

        const direct = evalForce(
            { x: 0, y: 0, theta: 0, v: V0 },
            fN,
            { edges, ds: dt },
            Domain.Time,
        );
        for (let i = 0; i <= edges; i++) {
            expect(c.posX[i]).toBe(direct.posX[i]);
            expect(c.posY[i]).toBe(direct.posY[i]);
        }
        // the time path's per-edge ds is v·Δt, not the fixed Δt — distinguishing
        // it from a distance section threaded the same way.
        expect(c.ds[0]).toBeCloseTo(V0 * dt, 5);
        expect(c.ds[0]).not.toBeCloseTo(dt, 3);
    });

    test("clips a force section's copy at the sample budget, never writing past the flat SoA", () => {
        // `evalForce` has no budget parameter — its `fN`/`step` pair is already dense and
        // must match `step.edges` exactly (the pairing invariant), so a force section's realized
        // edge count can outrun the room `chain` has left. Unlike `evalGeo` (handed its own
        // budget), `chain` must clip the COPY itself (the locked decision, stage 2c). A
        // `maxSamples` far smaller than the section's edges forces the overflow.
        const maxSamples = 20;
        const edges = 50;
        const fN = new Float32Array(edges).fill(1.2);
        const sections: Section[] = [{ kind: "force", fN, step: { edges, ds: 0.5 } }];
        const c = chain({ x: 0, y: 0, theta: 0, v: V0 }, sections, maxSamples);

        // the range must describe exactly what got written into the flat buffers — never a
        // sample index the buffer doesn't have room for.
        expect(c.ranges[0].end).toBeLessThanOrEqual(maxSamples - 1);
        expect(c.count).toBeLessThanOrEqual(maxSamples);
        expect(c.results[0].edges).toBe(c.ranges[0].end);
        expect(c.results[0].truncated).toBe(true);

        // every written sample is the real march, not a zero-filled gap from an OOB write that
        // silently dropped.
        for (let i = 1; i <= c.ranges[0].end; i++) {
            expect(c.posX[i]).not.toBe(0);
        }
    });

    test("a clipped result's arrays match its own edge count", () => {
        // the clipped `SectionResult` is re-sliced, not re-stamped: `{...r, edges: copy}` would
        // hand a consumer an edge count disagreeing with the arrays beside it — the same
        // split-value shape the `Step` pairing closes at the other seam.
        const maxSamples = 20;
        const edges = 50;
        const fN = new Float32Array(edges).fill(1.2);
        const sections: Section[] = [{ kind: "force", fN, step: { edges, ds: 0.5 } }];
        const r = chain({ x: 0, y: 0, theta: 0, v: V0 }, sections, maxSamples).results[0];

        expect(r.truncated).toBe(true);
        expect(r.edges).toBeLessThan(edges);
        expect(r.posX.length).toBe(r.edges + 1);
        expect(r.posY.length).toBe(r.edges + 1);
        expect(r.theta.length).toBe(r.edges + 1);
        expect(r.v.length).toBe(r.edges + 1);
        expect(r.fN.length).toBe(r.edges);
        expect(r.ds.length).toBe(r.edges);
        // the exit is the last sample the clip actually kept, and every offset addresses a
        // sample the sliced arrays still have.
        expect(r.exit.x).toBe(r.posX[r.edges]);
        expect(r.exit.y).toBe(r.posY[r.edges]);
        for (const o of r.offsets) expect(o).toBeLessThanOrEqual(r.edges);
    });

    test("a force section within budget stays untruncated (positive control)", () => {
        const maxSamples = 4096;
        const edges = 50;
        const fN = new Float32Array(edges).fill(1.2);
        const sections: Section[] = [{ kind: "force", fN, step: { edges, ds: 0.5 } }];
        const c = chain({ x: 0, y: 0, theta: 0, v: V0 }, sections, maxSamples);
        expect(c.ranges[0].end).toBe(edges);
        expect(c.results[0].truncated).toBe(false);
    });
});

describe("the v²-modification channel — additive-consumer capability", () => {
    // the Locked decision names this per-edge channel as the seam a future
    // friction/drag consumer rides, and friction is ADDITIVE and path-dependent
    // (`v²_new = v²_natural − loss`), not a bare replace. `natural − k` (a
    // constant per-edge loss, a pure-substitution stand-in — no friction
    // semantics landed here) pins that the callback receives the naturally-
    // conserved v², not just an edge index: a REPLACE-only signature can't
    // express this consumer at all.
    test("an additive override (natural − k) lands natural − k, not a bare replace", () => {
        const N = 6;
        const posX = new Float32Array(N);
        const posY = new Float32Array(N); // flat: Δy = 0 every edge, so natural v² = v[i]²
        for (let i = 0; i < N; i++) posX[i] = i * 0.5;
        const theta = new Float32Array(N);
        const v = new Float32Array(N);
        const fN = new Float32Array(N - 1);
        const dsArr = new Float32Array(N - 1).fill(0.5);
        const v0 = 10;
        const k = 3;

        forces(
            posX,
            posY,
            theta,
            v,
            fN,
            dsArr,
            0,
            N - 1,
            v0,
            0,
            G,
            undefined,
            0,
            0,
            (_i, natural) => natural - k,
        );

        let expected = v0 * v0;
        for (let i = 0; i < N - 1; i++) {
            expected -= k;
            expect(v[i + 1] * v[i + 1]).toBeCloseTo(expected, 4);
        }
    });
});

describe("byte-identity floor", () => {
    test("the flat SoA matches the frozen pre-substrate golden", () => {
        // proves the additive-substrate law: friction/resistance defaulted to 0
        // (or omitted) leaves the flat SoA untouched.
        const geo: Node[] = withThetas([
            { x: 0, y: 0 },
            { x: 20, y: 3 },
            { x: 44, y: 0 },
        ]);
        const force = Float32Array.from({ length: 30 }, () => 1.2);
        const sections: Section[] = [
            { kind: "geo", nodes: geo, ds: 0.5 },
            { kind: "force", fN: force, step: { edges: force.length, ds: 0.5 } },
        ];
        const c = chain({ x: 0, y: 0, theta: 0, v: V0 }, sections);
        const golden = require("./fixtures/speed-absent-golden.json") as {
            posX: number[];
            posY: number[];
            theta: number[];
            v: number[];
        };
        for (let i = 0; i < c.count; i++) {
            expect(c.posX[i]).toBe(golden.posX[i]);
            expect(c.posY[i]).toBe(golden.posY[i]);
            expect(c.theta[i]).toBe(golden.theta[i]);
            expect(c.v[i]).toBe(golden.v[i]);
        }

        // `kex2d-friction` stage 1: extends the SAME golden rather than duplicating it —
        // explicit 0s for `friction`/`resistance` must be byte-identical to omitting them
        // entirely (the additive-substrate law holds at the zero-coefficient boundary too).
        const explicit = chain({ x: 0, y: 0, theta: 0, v: V0 }, sections, undefined, 0, 0);
        for (let i = 0; i < explicit.count; i++) {
            expect(explicit.posX[i]).toBe(golden.posX[i]);
            expect(explicit.posY[i]).toBe(golden.posY[i]);
            expect(explicit.theta[i]).toBe(golden.theta[i]);
            expect(explicit.v[i]).toBe(golden.v[i]);
        }
    });
});

describe("energy propagation into a downstream force section", () => {
    // The property an author meets as "resizing a section upstream doesn't reshape what follows."
    // Frictionless, this was the conservative-energy law's emergent form (`kex2d-map.md`, now the
    // path-energy law): the integrator advances `v² −= 2g·Δy` per edge, which telescopes, so exit
    // `v` depended on the entry, the exit HEIGHT, and nothing else — not on the arclength travelled.
    //
    // These arms were this stage's red-first signal: with `μ > 0` the loss integrates ALONG the
    // path (`2·(μ·g·|fN| + c·v²)·ds` per edge, `forward.loss`), so exit v is no longer a strict
    // function of height alone — a longer route between the same two points now genuinely costs
    // more speed. Converted to their dissipative form below: the exact discrete identity
    // `v²_exit = v0² − 2g·Δy − Σ loss_i` (the recursion's own telescoping sum, true for ANY route)
    // replaces the frictionless equality, and the third arm (originally an inert length change) now
    // asserts the user's originating symptom directly — a pure ΔL costs `2μg·cosθ·ΔL` downstream.

    /** the force section's samples in its own entry frame — translation-invariant, so a pure
     *  placement change reads as congruent and a real reshape reads as moved. NOT rotation-
     *  invariant, deliberately: force integration is not frame-invariant (gravity picks a world
     *  frame, `kex2d-map.md` rigid-placement law), so a differing entry θ SHOULD read as moved. */
    function shapeOf(c: ReturnType<typeof chain>, k: number): number[] {
        const r = c.ranges[k];
        const out: number[] = [];
        for (let i = r.start; i <= r.end; i++)
            out.push(c.posX[i] - c.posX[r.start], c.posY[i] - c.posY[r.start]);
        return out;
    }

    function arclen(c: ReturnType<typeof chain>, k: number): number {
        let acc = 0;
        for (let i = c.ranges[k].start; i < c.ranges[k].end; i++) acc += c.ds[i];
        return acc;
    }

    function maxDelta(a: number[], b: number[]): number {
        let m = 0;
        for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(b[i] - a[i]));
        return m;
    }

    /** the exact discrete identity `forward.step`'s recursion telescopes to, for ANY route: each
     *  edge subtracts `2g·Δy_i` (gravity) and `loss(fN_i, v_i², ds_i, μ, c)` (`forward.loss`) from
     *  the running v², so summing the per-edge losses off the chain's OWN recorded `fN`/`ds`/`v`
     *  reproduces the section's exit v² exactly (to f32 accumulation) regardless of path shape. */
    function sumLoss(c: ReturnType<typeof chain>, k: number, mu: number, resistance = 0): number {
        let s = 0;
        const r = c.ranges[k];
        for (let i = r.start; i < r.end; i++)
            s += loss(c.fN[i], c.v[i] * c.v[i], c.ds[i], mu, resistance);
        return s;
    }

    const Eps = 2 ** -23;
    const Kf32 = 40; // same generous f32-accumulation constant `friction.test.ts` derives

    const forceCurve = Float32Array.from({ length: 30 }, () => 1.2);
    const forceSection: Section = {
        kind: "force",
        fN: forceCurve,
        step: { edges: forceCurve.length, ds: 0.5 },
    };
    const entry0: Entry = { x: 0, y: 0, theta: 0, v: V0 };
    const Mu = 0.03; // ~ the incumbent core's own default (`packages/core/track/dispatch.rs`)

    test("exit v is no longer path-independent: the exact loss identity holds on both routes", () => {
        const direct = withThetas([
            { x: 0, y: 0 },
            { x: 44, y: -8 },
        ]);
        // the detour dips rather than humps: at V0 = 10 m/s the cart carries v² = 100 m²/s², so a
        // hump above y ≈ +5 exceeds the budget and STALLS (v² clamps at 0), which would compare two
        // physically different rides rather than two routes to one endpoint.
        const detour = withThetas([
            { x: 0, y: 0 },
            { x: 10, y: -16 },
            { x: 34, y: -16 },
            { x: 44, y: -8 },
        ]);
        const a = chain(
            entry0,
            [{ kind: "geo", nodes: direct, ds: 0.5 }, forceSection],
            undefined,
            Mu,
        );
        const b = chain(
            entry0,
            [{ kind: "geo", nodes: detour, ds: 0.5 }, forceSection],
            undefined,
            Mu,
        );

        expect(arclen(b, 0) - arclen(a, 0)).toBeGreaterThan(10);
        expect(b.exits[0].y).toBeCloseTo(a.exits[0].y, 4); // …still the same height (friction drains speed, not position)

        // the exact telescoping identity, both routes, section 0 (the geo section):
        for (const c of [a, b]) {
            const expected = V0 * V0 - 2 * G * (c.exits[0].y - entry0.y) - sumLoss(c, 0, Mu);
            const tol = Kf32 * c.ranges[0].end * Eps * (V0 * V0);
            expect(Math.abs(c.exits[0].v * c.exits[0].v - expected)).toBeLessThan(tol);
        }

        // the longer, more-dissipative route now measurably trails: the equality this arm asserted
        // frictionless is exactly what breaks — deliberately.
        expect(b.exits[0].v).toBeLessThan(a.exits[0].v - 0.05);
    });

    test("a pure LENGTH change upstream now costs downstream entry v² by 2μg·cosθ·ΔL", () => {
        // the user's originating symptom, flipped from inert to predicted (Goal, `kex2d-friction`):
        // entry y and θ are preserved (level, straight — θ = 0 throughout, so cos θ = 1 exactly),
        // but a longer run now genuinely dissipates more, so downstream entry v² drops measurably —
        // and the force section that follows, whose own curvature depends on entry v, reshapes.
        const short = withThetas([
            { x: 0, y: 0 },
            { x: 44, y: 0 },
        ]);
        const long = withThetas([
            { x: 0, y: 0 },
            { x: 64, y: 0 },
        ]);
        const a = chain(
            entry0,
            [{ kind: "geo", nodes: short, ds: 0.5 }, forceSection],
            undefined,
            Mu,
        );
        const b = chain(
            entry0,
            [{ kind: "geo", nodes: long, ds: 0.5 }, forceSection],
            undefined,
            Mu,
        );

        const deltaL = arclen(b, 0) - arclen(a, 0);
        expect(deltaL).toBeGreaterThan(10); // control: really longer
        expect(b.exits[0].x - a.exits[0].x).toBeGreaterThan(10); // …and really displaced
        expect(b.exits[0].y).toBeCloseTo(a.exits[0].y, 5); // level — friction never moves y
        expect(b.exits[0].theta).toBeCloseTo(a.exits[0].theta, 5);

        // the closed form named in `kex2d-friction`'s Validation: ΔL · 2μg·cosθ (θ = 0 here).
        const predicted = 2 * Mu * G * 1 * deltaL;
        const actual = a.exits[0].v * a.exits[0].v - b.exits[0].v * b.exits[0].v;
        const tol = Kf32 * b.ranges[0].end * Eps * (V0 * V0);
        expect(Math.abs(actual - predicted)).toBeLessThan(tol);

        // downstream (the force section) now reshapes: entry v differs, and the force march's own
        // curvature depends on v (`dθ = (fN − cosθ)·g·ds/vSafe²`) — the exact inertness this arm
        // used to pin is what friction breaks.
        expect(maxDelta(shapeOf(a, 1), shapeOf(b, 1))).toBeGreaterThan(0.01);
    });

    test("exit v IS height-dependent, and downstream reshapes when it moves (dissipative form)", () => {
        const shallow = withThetas([
            { x: 0, y: 0 },
            { x: 44, y: -8 },
        ]);
        const deep = withThetas([
            { x: 0, y: 0 },
            { x: 44, y: -20 },
        ]);
        const a = chain(
            entry0,
            [{ kind: "geo", nodes: shallow, ds: 0.5 }, forceSection],
            undefined,
            Mu,
        );
        const b = chain(
            entry0,
            [{ kind: "geo", nodes: deep, ds: 0.5 }, forceSection],
            undefined,
            Mu,
        );

        // the marched exit matches the exact discrete loss identity — the numerical integrator
        // against its own telescoping sum, not a restatement of the per-edge update in isolation.
        for (const c of [a, b]) {
            const expected = V0 * V0 - 2 * G * (c.exits[0].y - entry0.y) - sumLoss(c, 0, Mu);
            const tol = Kf32 * c.ranges[0].end * Eps * (V0 * V0);
            expect(Math.abs(c.exits[0].v * c.exits[0].v - expected)).toBeLessThan(tol);
        }
        expect(b.exits[0].v).toBeGreaterThan(a.exits[0].v + 3);

        // a real energy change reshapes downstream: higher entry v at the same fN means a larger
        // radius, so the arc flattens measurably in its own frame.
        expect(maxDelta(shapeOf(a, 1), shapeOf(b, 1))).toBeGreaterThan(0.1);
    });
});
