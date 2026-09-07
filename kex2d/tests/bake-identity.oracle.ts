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
import { loadDocument, parseDocument, saveDocument, serializeDocument } from "../src/doc";
import { FORCE_BUDGET, GEO_BUDGET } from "../src/geofit";
import type { LaneSegment } from "../src/lanes";
import { compareBakes } from "../src/pitchfit";
import { resolveStep } from "../src/profile";
import { bakeOut, BakeSystem, MAX_SAMPLES, samples, Track, trackEntity } from "../src/track";
import {
    digestCorpus,
    digestOfChain,
    referenceBake,
    referenceChain,
    referenceDigest,
    referenceInput,
    REFUSAL_WITNESS,
} from "./mint-bake-digests";

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

// ── S2e: the live LANE bake against the frozen digests (spec Validation 2, S2e form) ────────
//
// The store bakes lanes now, so there is no second builder to shadow. What holds the claim is
// the digest file: minted before any store edit, while `v3Payloads` was proven byte-identical to
// the node bake, it is the only surviving record of what the retired path produced.
//
// **The digest is the truth and the reference its witness.** Every arm below first asserts that
// `chain(v3Payloads(input))` still hashes to the recorded digest — so a reference that drifted
// cannot quietly redefine the target — and only then reads it.
//
// The population splits, because the two halves are not the same claim:
//
//  - FORCE-ONLY (16): the lane records carry the same numbers the force runs did, so the live
//    bake is byte-identical and its own hash is compared to the digest directly. Two are
//    excepted from BYTE identity by the Locked decision, never from being the same track.
//  - GEO-BEARING (14): the geo lane is a FIT, so byte identity is the wrong observable. These
//    hold `geofit.ts`'s dual budget through `pitchfit.compareBakes` against the digest-verified
//    reference — position pointwise on absolute arclength, force within one landed edge, corner
//    stations unread — the same helper the migration accepts a fit on.

/** every committed fixture split by whether its geo lane authors anything. */
function laneSplit(): { forceOnly: string[]; geoBearing: string[] } {
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

/** one live bake, as the plain-number shape `compareBakes` and the digest both read. */
function liveBake(text: string) {
    const { t: _t, ...bake } = cycle(text).bake;
    return bake;
}

/** the digest of a live bake — hashed by the SAME rule the reference is
 *  (`mint-bake-digests.digestOfChain`), so the two are comparable at all. */
function liveDigest(bake: ReturnType<typeof liveBake>): string {
    return digestOfChain({
        count: bake.count,
        posX: Float32Array.from(bake.posX),
        posY: Float32Array.from(bake.posY),
        theta: Float32Array.from(bake.theta),
        v: Float32Array.from(bake.v),
        fN: Float32Array.from(bake.fN),
        ds: Float32Array.from(bake.ds),
    });
}

describe("the live lane bake against the frozen digests", () => {
    const digests = require("./fixtures/v3/bake-digests.json") as Record<string, string>;
    const split = laneSplit();

    test("the population is pinned at 16 force-only + 14 geo-bearing", () => {
        // Validation 2's population. A narrowed scan, or a fixture that quietly stopped carrying
        // a geo lane, cannot read as a clean sweep.
        expect(split.forceOnly).toHaveLength(16);
        expect(split.geoBearing).toHaveLength(14);
    });

    /** the force-only fixtures byte identity does NOT apply to, each with the reason. Both are
     *  Locked-decision consequences, not fit residuals. */
    const Except: Record<string, string> = {
        "velocity/past-live-extent.kex":
            "the follow end counts the velocity lane, so the track grows to 46 m and the tail bakes as a force gap dwelling at the last exit",
        "force/adjacent-force-runs.kex":
            "two abutting force records derive as ONE run sharing a key, so a seam that is not a `ds` multiple re-grids under the per-run `resolveStep` — a discretization change, not a fidelity change (spec Locked decision)",
    };

    test("the byte-identity exceptions are exactly the two the Locked decision names", () => {
        expect(Object.keys(Except).sort()).toEqual([
            "force/adjacent-force-runs.kex",
            "velocity/past-live-extent.kex",
        ]);
        for (const name of Object.keys(Except)) expect(split.forceOnly).toContain(name);
    });

    for (const name of split.forceOnly) {
        const why = Except[name];
        if (why === undefined) {
            test(`${name}: the live bake hashes to its frozen digest`, async () => {
                // the reference reproduces the digest, so the digest is what it always was…
                expect(await referenceDigest(name)).toBe(digests[name]);
                // …and the live lane bake is that same bake, byte for byte.
                const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
                expect(liveDigest(liveBake(text))).toBe(digests[name]);
            });
            continue;
        }
        test(`${name}: the live bake holds both budgets against the reference`, async () => {
            expect(await referenceDigest(name)).toBe(digests[name]);
            const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
            const live = liveBake(text);
            const ref = await referenceBake(name);
            const refCount = Math.min(ref.count, MAX_SAMPLES);
            const doc = parseDocument(text);
            const dev = compareBakes(
                {
                    x: Array.from(ref.posX.subarray(0, refCount)),
                    y: Array.from(ref.posY.subarray(0, refCount)),
                    fN: Array.from(ref.fN.subarray(0, Math.max(0, refCount - 1))),
                    ds: Array.from(ref.ds.subarray(0, Math.max(0, refCount - 1))),
                    edges: Math.max(0, refCount - 1),
                },
                {
                    x: live.posX,
                    y: live.posY,
                    fN: live.fN,
                    ds: live.ds,
                    edges: Math.max(0, live.count - 1),
                },
                resolveStep(1, doc.track.ds).ds,
            );
            expect(dev.force, why).toBeLessThanOrEqual(FORCE_BUDGET);
            if (name.endsWith("past-live-extent.kex")) {
                // this one GROWS, so a whole-track position reading would compare the new tail
                // against nothing; what must hold is that the shared stretch agrees.
                expect(live.count).toBeGreaterThan(refCount);
                for (let i = 0; i < refCount; i++) {
                    expect(live.posX[i]!).toBe(ref.posX[i]!);
                    expect(live.posY[i]!).toBe(ref.posY[i]!);
                }
                return;
            }
            expect(dev.position, why).toBeLessThanOrEqual(GEO_BUDGET);
        });
    }

    for (const name of split.geoBearing) {
        test(`${name}: the live bake holds both budgets against the digest-verified reference`, async () => {
            expect(await referenceDigest(name)).toBe(digests[name]);
            const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
            const live = liveBake(text);
            const ref = await referenceBake(name);
            const refCount = Math.min(ref.count, MAX_SAMPLES);
            const doc = parseDocument(text);
            const dev = compareBakes(
                {
                    x: Array.from(ref.posX.subarray(0, refCount)),
                    y: Array.from(ref.posY.subarray(0, refCount)),
                    fN: Array.from(ref.fN.subarray(0, Math.max(0, refCount - 1))),
                    ds: Array.from(ref.ds.subarray(0, Math.max(0, refCount - 1))),
                    edges: Math.max(0, refCount - 1),
                },
                {
                    x: live.posX,
                    y: live.posY,
                    fN: live.fN,
                    ds: live.ds,
                    edges: Math.max(0, live.count - 1),
                },
                resolveStep(1, doc.track.ds).ds,
                cornerStations(doc.lanes.geo),
            );
            expect(dev.position).toBeLessThanOrEqual(GEO_BUDGET);
            expect(dev.force).toBeLessThanOrEqual(FORCE_BUDGET);
            // and a real bake happened on both sides — two empty ones satisfy any budget.
            expect(live.count).toBeGreaterThan(1);
            expect(refCount).toBeGreaterThan(1);
        });
    }
});

describe("the frozen bake digests", () => {
    // Minted by `tests/mint-bake-digests.ts` BEFORE any S2e-i store edit, while `v3Payloads` is
    // byte-identical to the live bake (`doc.test.ts`, "the pure v3 payload builder is the live
    // bake"). After the cutover the node path is gone and these are the only record of what it
    // produced, which is why the digest — not the reference that reproduces it — is the truth.
    const digests = require("./fixtures/v3/bake-digests.json") as Record<string, string>;

    test("the digest file keys the thirty loadable fixtures plus the refusal witness", () => {
        // pin the population at 31: a narrowed mint, or a fixture that quietly stopped being
        // digested, cannot read as a clean sweep.
        expect(Object.keys(digests).sort()).toEqual(digestCorpus());
        expect(Object.keys(digests)).toHaveLength(31);
        expect(digests[REFUSAL_WITNESS]).toBeString();
    });

    test("the reference input of a v4 fixture is its frozen v3 twin, never the v4 file", () => {
        // the reference must stay computable once `segments`/`strips` leave the v4 wire.
        expect(referenceInput("cli/hill-explicit.kex")).toEndWith(
            "fixtures/v3/cli/hill-explicit.kex",
        );
        expect(referenceInput("force/keyless.kex")).toEndWith("fixtures/force/keyless.kex");
    });

    for (const name of digestCorpus()) {
        test(`${name}: the reference bake still hashes to its recorded digest`, async () => {
            expect(await referenceDigest(name)).toBe(digests[name]);
        });
    }
});

// ── the terminal-edge arm (spec Validation 2, S2e form) ──────────────────────────────────────
//
// No corpus fixture puts a velocity prescription over a geo run's FINAL edges, and that is the
// one place `bake.forces` has no edge ahead for its bisector — so the recovered force there
// depends on the grid, and a lane bake and a node bake can disagree by orders of magnitude under
// a prescription. This closes that gap with one inline v3 document rather than a fixture,
// because the shape is a probe, not a corpus member.
//
// The document is the retired `commands.test.ts` template chain: nodes (0, 0), (20, 0), (40, 5);
// a 30 m force run 1.5 → 2.5 g; μ 0.02, c 2·10⁻⁴; v0 22 — with a 40 m/s velocity record over
// [40, 60) covering the geo run's final edges. Both budgets hold against its own node bake, and
// dropping the record from one side goes red.

/** the inline v3 template, optionally without its velocity record. */
function terminalTemplate(withRecord: boolean): string {
    // node thetas follow the authoring reflect rule: θ₀ = 0, θᵢ = 2·chordᵢ − θᵢ₋₁.
    const chord2 = Math.atan2(5, 20);
    return JSON.stringify({
        version: 3,
        track: { ds: 0.5, domain: 0, friction: 0.02, resistance: 2e-4 },
        segments: [
            {
                id: 0,
                order: 0,
                kind: 0,
                run: 0,
                node: 2,
                nodes: [
                    { order: 0, x: 0, y: 0, theta: 0 },
                    { order: 1, x: 20, y: 0, theta: 0 },
                    { order: 2, x: 40, y: 5, theta: 2 * chord2 },
                ],
                points: [],
            },
            {
                id: 1,
                order: 1,
                kind: 1,
                run: 1,
                station: 0,
                extent: 30,
                nodes: [],
                points: [
                    { id: 0, s: 0, boundary: { g: 1.5, ease: 1 } },
                    { id: 1, s: 20, boundary: { g: 2.5, ease: 1 } },
                ],
            },
        ],
        strips: withRecord
            ? [
                  {
                      id: 0,
                      start: 40,
                      end: 60,
                      value: 40,
                      keyframes: [
                          { id: 0, s: 40, v: 40 },
                          { id: 1, s: 60, v: 40 },
                      ],
                  },
              ]
            : [],
        oneShot: [{ id: 0, value: 22 }],
    });
}

describe("the terminal-edge arm", () => {
    /** the dual-budget deviation of the live lane bake against the inline document's node bake. */
    function deviation(referenceText: string, liveText: string) {
        const ref = referenceChain(referenceText);
        const refCount = Math.min(ref.count, MAX_SAMPLES);
        const live = liveBake(serializeDocument(parseDocument(liveText)));
        return compareBakes(
            {
                x: Array.from(ref.posX.subarray(0, refCount)),
                y: Array.from(ref.posY.subarray(0, refCount)),
                fN: Array.from(ref.fN.subarray(0, Math.max(0, refCount - 1))),
                ds: Array.from(ref.ds.subarray(0, Math.max(0, refCount - 1))),
                edges: Math.max(0, refCount - 1),
            },
            {
                x: live.posX,
                y: live.posY,
                fN: live.fN,
                ds: live.ds,
                edges: Math.max(0, live.count - 1),
            },
            resolveStep(1, 0.5).ds,
        );
    }

    test("a velocity record over the geo run's final edges holds both budgets", () => {
        const dev = deviation(terminalTemplate(true), terminalTemplate(true));
        expect(dev.position).toBeLessThanOrEqual(GEO_BUDGET);
        expect(dev.force).toBeLessThanOrEqual(FORCE_BUDGET);
    });

    test("red control: dropping the record from ONE side breaches the force budget", () => {
        // the same comparison with the prescription removed from the reference only — the
        // terminal edge then reads a different force entirely, which is the discrimination this
        // arm needs to be evidence rather than a green pin.
        const dev = deviation(terminalTemplate(false), terminalTemplate(true));
        expect(dev.force).toBeGreaterThan(FORCE_BUDGET);
    });
});
