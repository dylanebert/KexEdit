import { describe, expect, test } from "bun:test";
import { replay } from "../src/bake";
import {
    chain,
    type Entry,
    evalForce,
    evalGeo,
    localize,
    place,
    type Section,
} from "../src/section";
import type { Node } from "../src/spline";
import { withThetas } from "./helpers/chain";

// the section substrate (kex/specs/kex2d-sections.md §2): entry → sampled points
// → exit, chained by anchor propagation. the two atoms wrap the oracle-gated
// integrator (`forward.integrate`) and the display recovery (`bake.forces`), so
// physics carries from those gates; these tests pin the CONTRACT the substrate
// adds — rigid placement (§4), the geometry-recovered display force (§2), and
// chain continuity. device-free (canvas2D + pure math, no GPU).

const G = 9.80665;
const V0 = 10;

describe("localize", () => {
    test("is the exact inverse of place: place(entry, localize(entry, p)) === p (§4)", () => {
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

    test("places the local shape rigidly at the entry frame (§4)", () => {
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
        const r = evalForce(entry, fN, ds);

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
        // §2: a force section re-recovers its display force from the swept geometry.
        // the recovery (chord-bisector centering) sits O(ds) off the authored input
        // — the source-vs-centered convention gap. derived, not tuned: halving ds
        // must roughly halve the max interior gap (O(ds), not O(1)).
        const entry: Entry = { x: 0, y: 0, theta: 0, v: 16 };
        const authored = (s: number): number => 1 + 0.5 * Math.sin(s / 8);
        const gap = (ds: number): number => {
            const len = 32;
            const edges = Math.round(len / ds);
            const fN = Float32Array.from({ length: edges }, (_, i) => authored(i * ds));
            const r = evalForce(entry, fN, ds);
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
            { kind: "force", fN: force, ds: 0.5 },
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
});
