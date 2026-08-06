import { describe, expect, test } from "bun:test";
import { replay } from "../src/bake";
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
