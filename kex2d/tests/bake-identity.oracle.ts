/** the bake-identity oracle (spec `kex2d-segment-gestures` Validation 2), run by path
 *  (`bun test ./tests/bake-identity.oracle.ts` — `coding.md` Suite speed, `kex2d-map.md`'s
 *  by-path oracle convention).
 *
 *  The claim it holds: re-keying the authored track onto lanes changes what is STORED, never
 *  what is BAKED. So for every committed document that loads, the cycle
 *
 *      load → bake → save → load → bake
 *
 *  must publish byte-identical `bakeOut`/`samples` on both bakes, and the second save must equal
 *  the first (the wire is a fixed point). The save in the middle is the point: it forces the
 *  authored state through the v4 wire, so anything the lane records cannot carry shows up here as
 *  a moved sample rather than as a silently narrowed round-trip.
 *
 *  This reads the LIVE tree only. The cross-tree half of Validation 2 — the same corpus baked on
 *  the pre-cutover tree — is a one-off comparison recorded in the stage's fold, not a standing
 *  check: the retired tree is a commit, not a dependency. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { State } from "@dylanebert/shallot";
import { loadDocument, parseDocument, saveDocument } from "../src/doc";
import { FORCE_BUDGET, GEO_BUDGET } from "../src/geofit";
import { DEFAULT_ORDER, deriveRuns } from "../src/projection";
import { type LaneSegment, laneOrder } from "../src/lanes";
import { compareBakes } from "../src/pitchfit";
import { forceProfile, resolveStep } from "../src/profile";
import { chain, type Section, SectionKind } from "../src/section";
import {
    bakeOut,
    BakeSystem,
    edgeStrips,
    materializeRunForceClamps,
    MAX_SAMPLES,
    samples,
    Track,
    trackEntity,
    V0,
} from "../src/track";
import { digestOf, v3Corpus } from "./mint-bake-digests";

/** every committed `.kex` fixture outside the frozen `v2`/`v3` migration inputs and the
 *  deliberately malformed `invariants/*-red` corpus — the documents that actually load. */
function corpus(): string[] {
    const root = join(import.meta.dir, "fixtures");
    const out: string[] = [];
    for (const dir of ["", "cli", "force", "invariants", "velocity"]) {
        const abs = dir === "" ? root : join(root, dir);
        if (!existsSync(abs)) continue;
        for (const name of readdirSync(abs)) {
            if (!name.endsWith(".kex") || name.endsWith("-red.kex")) continue;
            out.push(dir === "" ? name : `${dir}/${name}`);
        }
    }
    return out.sort();
}

/** the whole published bake of one track as plain numbers — every SoA the display, the cart and
 *  the timeline read, clipped to the published sample count. */
function baked(eid: number) {
    const count = Track.count.get(eid);
    const s = samples.get(eid);
    const out = bakeOut.get(eid);
    if (!s || !out) throw new Error("track buffers missing");
    const edges = Math.max(0, count - 1);
    return {
        count,
        posX: Array.from(s.posX.subarray(0, count)),
        posY: Array.from(s.posY.subarray(0, count)),
        theta: Array.from(s.theta.subarray(0, count)),
        v: Array.from(out.v.subarray(0, count)),
        t: Array.from(out.t.subarray(0, count)),
        fN: Array.from(out.fN.subarray(0, edges)),
        ds: Array.from(out.ds.subarray(0, edges)),
    };
}

/** load `text` into a fresh state, bake it, and return the published bake plus the canonical
 *  save. One `State` per call, read out before the next is built: `samples`/`bakeOut` are
 *  module-level maps keyed by raw entity id and two fresh `State`s both start at 1, so a second
 *  state built first would alias the slot and make the comparison vacuous (`doc.test.ts` names
 *  the same hazard). */
function cycle(text: string): { bake: ReturnType<typeof baked>; save: string } {
    const state = new State();
    state.addSystem(BakeSystem);
    loadDocument(state, text);
    state.step(0);
    const eid = trackEntity(state);
    if (eid === null) throw new Error("no track after load");
    return { bake: baked(eid), save: saveDocument(state) };
}

const names = corpus();

test("the corpus is whole", () => {
    // pin the population: a narrowed or empty scan must not read as a clean sweep.
    expect(names.length).toBeGreaterThanOrEqual(24);
});

for (const name of names) {
    test(`${name}: load → bake → save → load → bake is byte-identical`, () => {
        const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
        const first = cycle(text);
        const second = cycle(first.save);
        expect(second.bake).toEqual(first.bake);
        // the wire is a fixed point, so the identity above is not bought by a save that keeps
        // drifting toward whatever the loader happens to accept.
        expect(second.save).toBe(first.save);
        // and a real bake happened — an empty one would satisfy every equality above.
        expect(first.bake.count).toBeGreaterThan(1);
    });
}

// ── S2d: the LANE-DERIVED bake in the shadow (spec Validation 2, S2d form) ───────────────────
//
// The store still bakes nodes at S2d, so the fixed point above is unchanged. What this half
// holds is the claim S2e cashes in: derive the runs from the AUTHORED LANES instead of from the
// segments, bake those payloads through the same `section.chain`, and the result must still be
// the same track.
//
// The population splits, because the two halves are not the same claim:
//
//  - FORCE-ONLY (16): the lane records carry the same numbers the force runs did, so the bake is
//    byte-identical over the whole SoA. `velocity/past-live-extent.kex` is the standing
//    exception — the follow end counts the velocity lane, so the track grows to 46 m and the
//    tail bakes as a force gap dwelling at the last exit.
//  - GEO-BEARING (14): the geo lane is a FIT, so byte identity is the wrong observable. These
//    hold `geofit.ts`'s dual budget through `pitchfit.compareBakes` — position pointwise on
//    absolute arclength, force within one landed edge, corner stations unread — which is the
//    same helper the migration accepts a fit on.

/** every committed fixture split by whether its chain carries a geo run. */
function shadowSplit(): { forceOnly: string[]; geoBearing: string[] } {
    const forceOnly: string[] = [];
    const geoBearing: string[] = [];
    for (const name of names) {
        const doc = parseDocument(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
        (doc.lanes.geo.length > 0 ? geoBearing : forceOnly).push(name);
    }
    return { forceOnly, geoBearing };
}

/** the stations where the geo lane authors a DISCONTINUITY: a record owning an entry that
 *  differs from its abutting predecessor's exit. These are the corners the fit minted, and the
 *  stations where no pointwise force observable converges at any grid. */
function cornerStations(geo: readonly LaneSegment[]): number[] {
    const rows = [...geo].sort((a, b) => a.start - b.start);
    const out: number[] = [];
    for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!;
        const row = rows[i]!;
        if (row.start === prev.end && row.entry !== undefined && row.entry !== prev.exit)
            out.push(row.start);
    }
    return out;
}

/** the whole bake of one document, derived from its LANES rather than its segments. */
function laneBake(doc: ReturnType<typeof parseDocument>) {
    const ds = doc.track.ds;
    const order = doc.track.order === undefined ? undefined : laneOrder(doc.track.order);
    const runs = deriveRuns(doc.lanes, doc.track.end ?? 0, order ?? DEFAULT_ORDER);
    const strips = doc.strips.slice().sort((a, b) => a.start - b.start || a.id - b.id);
    const sections: Section[] = [];
    let offset = 0;
    for (const run of runs) {
        const step = resolveStep(run.length, ds);
        const grid = new Float32Array(step.edges).fill(step.ds);
        const framed =
            strips.length === 0
                ? undefined
                : edgeStrips(
                      grid,
                      step.edges,
                      strips.map((st) => ({
                          start: st.start - offset,
                          end: st.end - offset,
                          value: st.value,
                          keyframes: st.keyframes
                              .slice()
                              .sort((a, b) => a.s - b.s)
                              .map((k) => ({ s: k.s - offset, v: k.v })),
                      })),
                  );
        sections.push(
            run.kind === SectionKind.Geo
                ? {
                      kind: "pitch",
                      points: run.points,
                      step,
                      openEase: run.openEase,
                      strips: framed,
                  }
                : {
                      kind: "force",
                      fN: forceProfile(materializeRunForceClamps(run.points, run.length), step),
                      step,
                      strips: framed,
                  },
        );
        for (let i = 0; i < step.edges; i++) offset += grid[i]!;
    }
    const entry = { x: 0, y: 0, theta: 0, v: doc.track.v0 ?? V0 };
    return chain(entry, sections, MAX_SAMPLES, doc.track.friction, doc.track.resistance);
}

describe("the lane-derived bake in the shadow", () => {
    const split = shadowSplit();

    test("the population is pinned at 16 force-only + 14 geo-bearing", () => {
        // Validation 2's S2d population. A narrowed scan, or a fixture that quietly stopped
        // carrying a geo run, cannot read as a clean sweep.
        expect(split.forceOnly).toHaveLength(16);
        expect(split.geoBearing).toHaveLength(14);
    });

    /** the force-only fixtures byte identity does NOT apply to, each with the reason it does
     *  not. Both are Locked-decision consequences, not fit residuals. */
    const Except: Record<string, string> = {
        "velocity/past-live-extent.kex":
            "the follow end counts the velocity lane, so the track grows to 46 m and the tail bakes as a force gap dwelling at the last exit",
        "force/adjacent-force-runs.kex":
            "two abutting force records derive as ONE run sharing a key, so a seam that is not a `ds` multiple re-grids under the per-run `resolveStep` — a discretization change, not a fidelity change (spec Locked decision)",
    };

    for (const name of split.forceOnly) {
        test(`${name}: the lane bake is byte-identical to the live bake`, () => {
            const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
            // `t` is the arc-to-time table `chain` does not build; every SoA it does build is
            // compared.
            const { t: _t, ...live } = cycle(text).bake;
            const doc = parseDocument(text);
            const c = laneBake(doc);
            const count = Math.min(c.count, MAX_SAMPLES);
            const why = Except[name];
            if (why !== undefined) {
                // a named exception still holds the dual budget — it is excused from BYTE
                // identity, never from being the same track.
                const dev = compareBakes(
                    {
                        x: live.posX,
                        y: live.posY,
                        fN: live.fN,
                        ds: live.ds,
                        edges: Math.max(0, live.count - 1),
                    },
                    { x: c.posX, y: c.posY, fN: c.fN, ds: c.ds, edges: Math.max(0, count - 1) },
                    resolveStep(1, doc.track.ds).ds,
                );
                expect(dev.force, why).toBeLessThanOrEqual(FORCE_BUDGET);
                if (name.endsWith("past-live-extent.kex")) {
                    // this one GROWS, so a whole-track position reading would compare the new
                    // tail against nothing; what must hold is that the shared stretch agrees.
                    expect(count).toBeGreaterThan(live.count);
                    for (let i = 0; i < live.count; i++) {
                        expect(c.posX[i]!).toBe(live.posX[i]!);
                        expect(c.posY[i]!).toBe(live.posY[i]!);
                    }
                    return;
                }
                expect(dev.position, why).toBeLessThanOrEqual(GEO_BUDGET);
                return;
            }
            expect({
                count,
                posX: Array.from(c.posX.subarray(0, count)),
                posY: Array.from(c.posY.subarray(0, count)),
                theta: Array.from(c.theta.subarray(0, count)),
                v: Array.from(c.v.subarray(0, count)),
                fN: Array.from(c.fN.subarray(0, Math.max(0, count - 1))),
                ds: Array.from(c.ds.subarray(0, Math.max(0, count - 1))),
            }).toEqual(live);
        });
    }

    test("the byte-identity exceptions are exactly the two the Locked decision names", () => {
        // pin the exception set: a fixture quietly added here would turn a byte-identity claim
        // into a budget one without anyone reading it.
        expect(Object.keys(Except).sort()).toEqual([
            "force/adjacent-force-runs.kex",
            "velocity/past-live-extent.kex",
        ]);
        for (const name of Object.keys(Except)) expect(split.forceOnly).toContain(name);
    });

    for (const name of split.geoBearing) {
        test(`${name}: the lane bake holds both budgets against the live bake`, () => {
            const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
            const live = cycle(text).bake;
            const doc = parseDocument(text);
            const c = laneBake(doc);
            const count = Math.min(c.count, MAX_SAMPLES);
            const edges = Math.max(0, count - 1);
            const dev = compareBakes(
                {
                    x: live.posX,
                    y: live.posY,
                    fN: live.fN,
                    ds: live.ds,
                    edges: Math.max(0, live.count - 1),
                },
                {
                    x: c.posX,
                    y: c.posY,
                    fN: c.fN,
                    ds: c.ds,
                    edges,
                },
                resolveStep(1, doc.track.ds).ds,
                cornerStations(doc.lanes.geo),
            );
            expect(dev.position).toBeLessThanOrEqual(GEO_BUDGET);
            expect(dev.force).toBeLessThanOrEqual(FORCE_BUDGET);
            // and a real bake happened on both sides — two empty ones satisfy any budget.
            expect(count).toBeGreaterThan(1);
            expect(live.count).toBeGreaterThan(1);
        });
    }
});

describe("the frozen v3 bake digests", () => {
    // minted by `tests/mint-bake-digests.ts` while `v3Payloads` is byte-identical to the live
    // bake; at S2e the node path is gone and these are the only record of what it produced.
    const digests = require("./fixtures/v3/bake-digests.json") as Record<string, string>;

    test("every frozen v3 fixture has a digest, the refusal witness included", () => {
        expect(Object.keys(digests).sort()).toEqual(v3Corpus().sort());
        expect(digests["cli/loop-explicit.kex"]).toBeString();
    });

    for (const name of v3Corpus()) {
        test(`${name}: the node bake still hashes to its recorded digest`, () => {
            const text = readFileSync(join(import.meta.dir, "fixtures", "v3", name), "utf8");
            expect(digestOf(text)).toBe(digests[name]);
        });
    }
});
