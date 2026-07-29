import { State } from "@dylanebert/shallot";
import { describe, expect, test } from "bun:test";
import { convertForce, StaleConvert } from "../src/forcegeo";
import { FORCE_BUDGET, GEO_BUDGET, geofit, type GeofitBake } from "../src/geofit";
import { liveFitWorkers } from "../src/geofit-async";
import { createHistory, type History, undo } from "../src/history";
import { forceProfile } from "../src/profile";
import { scenarios } from "../src/scenarios";
import { evalForce, evalGeo } from "../src/section";
import { sampleChain } from "../src/spline";
import golden from "./fixtures/convert-golden.json";
import {
    addNode,
    appendSection,
    BakeSystem,
    bakeOut,
    createForcePoint,
    createSection,
    createTrack,
    DS_NOMINAL,
    Handle,
    MAX_SAMPLES,
    sectionAt,
    sectionHandles,
    Section,
    SectionKind,
    type SectionSnapshot,
    sectionForces,
    sectionInfo,
    setForcePoint,
    setTrackV0,
    snapshotAll,
} from "../src/track";
import { divergingFit, dyingFit, withFitWorker } from "./helpers/fitworker";

// the invoked force→geo command (kex2d-forcegeo stage 3): the conversion tier fitted off-thread,
// landed on the document as ONE undo entry — the observation-space twin of `geoforce.test.ts`.
// the fit itself is oracled in `geofit.test.ts` against the corpus; what's pinned here is the
// document seam — atomicity, byte-identical undo, downstream continuity, and that a fit which
// does not finish writes nothing at all.

/** a track carrying one force hump (the shape a fit is invoked on), baked. */
function humpForceTrack(): { state: State; eid: number; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setTrackV0(eid, 18);
    const sec = createSection(state, 0, SectionKind.Force, 40);
    createForcePoint(state, sec, 0, 1);
    createForcePoint(state, sec, 20, 1.4);
    createForcePoint(state, sec, 40, 1);
    state.step(0);
    return { state, eid, sec };
}

/** the whole authored document plus the bake's own input hash — the two readings that together
 *  say "byte-identical": every stored value back where it was, and the bake gate agreeing
 *  nothing about its input moved. */
function docState(state: State, eid: number): { snap: SectionSnapshot[]; hash: string } {
    return { snap: snapshotAll(state), hash: bakeOut.get(eid)?.hash ?? "" };
}

/** fit `sec` and settle the bake, asserting the fit actually converged (every pin below is about
 *  the document, not about the solver having a good day). */
async function convertAndBake(h: History, state: State, sec: number) {
    const result = await convertForce(h, state, sec);
    expect(result.outcome).toBe("floor");
    state.step(0);
    return result;
}

describe("convertForce", () => {
    test("the fit lands atomically and undo restores the force section byte-identical", async () => {
        const { state, eid, sec } = humpForceTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const result = await convertAndBake(h, state, sec);

        const secEid = sectionAt(state, sec);
        if (secEid === null) throw new Error("section missing");
        expect(Section.kind.get(secEid)).toBe(SectionKind.Geo);
        // the destructive-convert sentinels: no realized step carries over in this direction.
        expect(Section.ds.get(secEid)).toBe(0);
        expect(Section.length.get(secEid)).toBe(0);
        // the force points are gone and the fit's node chain is all that's there.
        expect(sectionForces(state, sec)).toHaveLength(0);
        expect(sectionHandles(state, sec)).toHaveLength(result.nodes.length);
        // node 0 is the fixed local flat anchor, EXACTLY — never the fit's own recovered residual.
        const node0 = sectionHandles(state, sec)[0];
        expect(Handle.pos.x.get(node0)).toBe(0);
        expect(Handle.pos.y.get(node0)).toBe(0);
        expect(Handle.theta.get(node0)).toBe(0);

        // one entry, and undoing it puts the track back exactly as authored.
        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        expect(docState(state, eid)).toEqual(before);
    }, 60_000);

    test("the converted section joins the chain where the force shape exited", async () => {
        // continuity is the whole point of a shape-preserving fit: the downstream section is
        // placed rigidly at this one's exit, so an exit that moved re-frames the rest of the
        // track. unlike geo→force (which solves its own discretization), the fit's tail node is
        // a literal pick of the target's own last dense sample, so the miss should be at f32
        // round-off, not a solver residual — 1e-3 is the geoforce precedent's bound, loose by
        // comparison.
        const { state, sec } = humpForceTrack();
        const down = appendSection(state, SectionKind.Geo);
        state.step(0);
        const forceExit = { ...(sectionInfo.get(down)?.entry ?? { x: Number.NaN, y: Number.NaN }) };

        await convertAndBake(createHistory(), state, sec);

        const geoExit = sectionInfo.get(down)?.entry;
        if (!geoExit) throw new Error("downstream section lost its bake");
        const miss = Math.hypot(geoExit.x - forceExit.x, geoExit.y - forceExit.y);
        expect(miss).toBeLessThan(1e-3);
    }, 60_000);

    test("a cancelled fit leaves the track byte-identical", async () => {
        // the façade writes nothing and the apply happens once at resolution, so there is no
        // rollback path to get wrong — this pins that there is nothing TO roll back.
        const { state, eid, sec } = humpForceTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const controller = new AbortController();
        const solving = convertForce(h, state, sec, { signal: controller.signal });
        controller.abort(new Error("cancelled from the modal"));
        await expect(solving).rejects.toThrow(/cancelled from the modal/);

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
        expect(liveFitWorkers()).toBe(0);
    }, 60_000);

    test("a diverged fit leaves the track byte-identical", async () => {
        // a diverged answer still resolves — the caller surfaces it — but it is not an authored
        // section, so nothing of it reaches the document.
        const { state, eid, sec } = humpForceTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const result = await withFitWorker(divergingFit(), () => convertForce(h, state, sec));
        expect(result.outcome).toBe("diverged");

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
    }, 60_000);

    test("a worker that dies mid-fit surfaces as a rejection, writing nothing", async () => {
        const { state, eid, sec } = humpForceTrack();
        const h = createHistory();
        const before = docState(state, eid);

        await expect(withFitWorker(dyingFit(), () => convertForce(h, state, sec))).rejects.toThrow(
            /geofit worker/,
        );

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
    }, 60_000);

    test("an edit during the fit rejects the answer instead of landing it stale", async () => {
        const { state, eid, sec } = humpForceTrack();
        const h = createHistory();

        const solving = convertForce(h, state, sec);
        const mid = sectionForces(state, sec).find((p) => p.s === 20);
        if (!mid) throw new Error("keyframe missing");
        setForcePoint(state, mid.id, mid.s, 2.2); // a mid-solve reshape
        state.step(0);
        const edited = docState(state, eid);

        await expect(solving).rejects.toThrow(StaleConvert);
        state.step(0);
        expect(docState(state, eid)).toEqual(edited); // the edit stands, the answer is dropped
        expect(h.undo).toHaveLength(0);
    }, 60_000);

    test("a second invoke while one is running is refused", async () => {
        const { state, sec } = humpForceTrack();
        const h = createHistory();

        const first = convertForce(h, state, sec);
        await expect(convertForce(h, state, sec)).rejects.toThrow(/already converting/);
        await first;
        state.step(0);

        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        expect(sectionForces(state, sec)).toHaveLength(3); // one entry took it all the way back
        // and the section is free again once the first invoke settled.
        await expect(convertForce(h, state, sec)).resolves.toMatchObject({ outcome: "floor" });
    }, 60_000);

    test("a section that isn't force is refused", async () => {
        const { state, sec } = humpForceTrack();
        const geo = appendSection(state, SectionKind.Geo);
        state.step(0);
        await expect(convertForce(createHistory(), state, geo)).rejects.toThrow(/not force/);
        await expect(convertForce(createHistory(), state, sec + 999)).rejects.toThrow(/no section/);
    });
});

// ── the document-layer fidelity oracle ───────────────────────────────────────
// the layer the AUTHOR sees. `geofit.ts` scores its own candidates; this asserts on the track's
// own bake before and after the convert, which is independently captured truth — the fit could
// hold its internal budget perfectly and still blow the displayed one if it scored a sampling
// the document never bakes (it did: the reviewer's hard case read 0.45 g reported vs 5.94 g
// displayed), or scored it on a coordinate the timeline doesn't draw (it did: span-normalized
// alignment divides out the fitted chain's corner-cutting shortfall, reading 0.48 g against
// 1.57 g displayed on valley-explicit).
//
// the two bakes have DIFFERENT edge counts and edge lengths, so the comparison is aligned on
// ABSOLUTE ARCLENGTH FROM THE SECTION ENTRY — the timeline's own station axis. Each curve's
// per-edge force is a value at its LEFT sample's arclength, the convention `bake.forces` computes
// it under (`fN[i]` from `theta[i]`, `theta[i+1]`, `ds[i]`); attributing it to the edge midpoint
// instead shifts each curve by its own half-edge, and the two half-edges differ, so a force
// gradient reads a bias of |dF/ds|·|ds_t − ds_c|/2 that belongs to neither curve. The drift is the
// max over BOTH curves' stations of the gap to the other curve linearly interpolated there;
// evaluating at only one curve's stations would step over exactly the extremes the other one
// carries.

interface Stations {
    s: number[];
    g: number[];
}

/** per-edge force as values at the edge's LEFT sample arclength, measured from the section
 *  entry — `bake.forces`'s own attribution. */
function stations(fN: ArrayLike<number>, ds: ArrayLike<number>, edges: number): Stations {
    const s: number[] = [];
    const g: number[] = [];
    let at = 0;
    for (let k = 0; k < edges; k++) {
        s.push(at);
        g.push(fN[k]);
        at += ds[k];
    }
    return { s, g };
}

/** per-sample position as values at the sample's own arclength from the section entry — the
 *  geometric budget's half of the same station axis. */
function posStations(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    ds: ArrayLike<number>,
    edges: number,
): { s: number[]; x: number[]; y: number[]; total: number } {
    const s: number[] = [];
    const px: number[] = [];
    const py: number[] = [];
    let at = 0;
    for (let i = 0; i <= edges; i++) {
        s.push(at);
        px.push(x[i]);
        py.push(y[i]);
        if (i < edges) at += ds[i];
    }
    return { s, x: px, y: py, total: at };
}

/** linear interpolation of `st` at arclength `at`, held flat beyond either end. */
function at(st: Stations, s: number): number {
    if (st.s.length === 0) return Number.NaN;
    if (s <= st.s[0]) return st.g[0];
    const last = st.s.length - 1;
    if (s >= st.s[last]) return st.g[last];
    let i = 0;
    while (i + 1 <= last && st.s[i + 1] < s) i++;
    const u = (s - st.s[i]) / (st.s[i + 1] - st.s[i]);
    return st.g[i] + u * (st.g[i + 1] - st.g[i]);
}

/** the arclength-aligned max force gap between two bakes of the same section. symmetric: every
 *  station of either curve is scored against the other. */
function drift(a: Stations, b: Stations): number {
    let worst = 0;
    for (let i = 0; i < a.s.length; i++) worst = Math.max(worst, Math.abs(a.g[i] - at(b, a.s[i])));
    for (let i = 0; i < b.s.length; i++) worst = Math.max(worst, Math.abs(b.g[i] - at(a, b.s[i])));
    return worst;
}

type Positions = ReturnType<typeof posStations>;

/** the arclength-aligned max positional gap between two bakes of the same section, the same
 *  symmetric union-of-stations reading `drift` takes on force. */
function posDrift(a: Positions, b: Positions): number {
    const near = (p: Positions, s: number): [number, number] => {
        const last = p.s.length - 1;
        if (s <= p.s[0]) return [p.x[0], p.y[0]];
        if (s >= p.s[last]) return [p.x[last], p.y[last]];
        let i = 0;
        while (i + 1 <= last && p.s[i + 1] < s) i++;
        const u = (s - p.s[i]) / (p.s[i + 1] - p.s[i]);
        return [p.x[i] + u * (p.x[i + 1] - p.x[i]), p.y[i] + u * (p.y[i + 1] - p.y[i])];
    };
    let worst = 0;
    for (const [p, q] of [
        [a, b],
        [b, a],
    ] as const) {
        for (let i = 0; i < p.s.length; i++) {
            const [x, y] = near(q, p.s[i]);
            worst = Math.max(worst, Math.hypot(p.x[i] - x, p.y[i] - y));
        }
    }
    return worst;
}

/** the section's force stations off the track's live bake — what the timeline draws. */
function sectionStations(eid: number, id: number): Stations {
    const out = bakeOut.get(eid);
    const info = sectionInfo.get(id);
    if (!out || !info) throw new Error("no bake for the section");
    const start = info.startSample;
    const edges = info.endSample - start;
    return stations(
        out.fN.subarray(start, start + edges),
        out.ds.subarray(start, start + edges),
        edges,
    );
}

describe("document-layer fidelity", () => {
    test("the landed geo section's baked force holds the budget against the pre-convert bake", async () => {
        // the hard case's shape: an upstream geo hill hands the force section a curved, rising,
        // non-axis-aligned entry frame, and the force section then sweeps 2.2 g → 0.4 g over a
        // long extent at a modest entry speed. the fitted chain's own adaptive re-bake lands
        // DENSER than the 180-edge target (183 edges), and those extra edges are exactly the
        // ones a frozen target-matched scan never looks at: that scoring read 0.40 g while the
        // document displayed 1.19 g.
        //
        // the sweep was 2.2 g → −0.6 g while the kernel aligned on a span-normalized
        // coordinate, where it reported `"floor"` at 0.45 g. On absolute arclength the same
        // input saturates honestly at `"budget"` / 0.58 g — the pure-Auto C1 dialect cannot hold
        // 0.5 g through that gradient, and the old reading was the corner-cutting shortfall
        // being divided out. 0.4 g keeps every property this case is here for (curved entry
        // frame, long extent, denser-than-target re-bake) on a shape the dialect does hold.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackV0(eid, 18);
        const hill = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, hill, 0, 0);
        addNode(state, hill, 10, 2);
        addNode(state, hill, 20, 4);
        const sec = createSection(state, 1, SectionKind.Force, 90);
        createForcePoint(state, sec, 0, 2.2);
        createForcePoint(state, sec, 90, 0.4);
        state.step(0);

        const before = sectionStations(eid, sec);
        const result = await convertForce(createHistory(), state, sec);
        expect(result.outcome).toBe("floor");
        state.step(0);
        const after = sectionStations(eid, sec);

        // the displayed error and the kernel's own reading are the SAME quantity now — pinning
        // both catches a regression that silently re-opens the gap in either direction.
        expect(drift(before, after)).toBeLessThanOrEqual(FORCE_BUDGET);
        expect(result.forceError).toBeLessThanOrEqual(FORCE_BUDGET);
    }, 60_000);

    test("a shape the dialect cannot hold is reported as such, not as a floor", async () => {
        // the reviewer's literal geometry — a 24 m force section entered at ~11 m/s after an
        // 18 m climb. the physics there is near-infeasible (the recovered force is hypersensitive
        // as v falls), so NO node count in the pure-Auto dialect holds the force budget: the
        // honest answer is the saturated `"budget"` outcome, which the readout tags. under the
        // frozen-count scoring this same input reported `"floor"` at 0.39 g while the document
        // displayed 6.06 g — a claim of success on a shape that isn't reproduced.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackV0(eid, 22);
        const hill = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, hill, 0, 0);
        addNode(state, hill, 10, 9);
        addNode(state, hill, 20, 18);
        const sec = createSection(state, 1, SectionKind.Force, 24);
        createForcePoint(state, sec, 0, 2.2);
        createForcePoint(state, sec, 24, -0.6);
        state.step(0);

        const before = sectionStations(eid, sec);
        const result = await convertForce(createHistory(), state, sec);
        expect(result.outcome).toBe("budget");
        state.step(0);

        // and the DOCUMENT agrees the budget is blown — the honest positive assertion. (an
        // earlier version bounded |drift − forceError| by a tuned `1`, which held only because
        // the alignment defect happened to sit under it on this one input.)
        expect(result.forceError).toBeGreaterThan(FORCE_BUDGET);
        expect(drift(before, sectionStations(eid, sec))).toBeGreaterThan(FORCE_BUDGET);
    }, 60_000);
});

// ── the corpus-wide document-metric oracle ───────────────────────────────────
// the gate. Two hand-picked ECS cases above prove the seam end to end; this drives the WHOLE
// 10-scenario corpus through the same metric, because a single case can land where the kernel's
// alignment and the document's coincide (the previous fidelity case did: kernel 0.466 vs
// document 0.452, so the span-normalization defect was invisible to it while four corpus
// scenarios were over budget — valley-explicit at 1.57 g against a reported 0.48 g).
//
// Device-free by construction: `applyConvertGeo` localizes the fit's world nodes into the
// section's own entry frame and `BakeSystem` bakes them through `chain`, which for a section at
// the track start is exactly `evalGeo(entry, nodes, DS_NOMINAL, MAX_SAMPLES)` — the same call,
// without ten worker spawns. The ECS pins above are what tie that equality to the real path.
describe("document-layer fidelity: the whole corpus", () => {
    const Golden = golden as Record<
        string,
        { points: { s: number; g: number }[]; length: number; ds: number }
    >;

    for (const scenario of scenarios) {
        test(scenario.name, () => {
            const g = Golden[scenario.name];
            const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
            const bake = evalForce(entry, forceProfile(g.points, g.length, g.ds), g.ds);
            const target: GeofitBake = {
                x: bake.posX,
                y: bake.posY,
                fN: bake.fN,
                ds: bake.ds,
                edges: bake.fN.length,
            };

            const fit = geofit(target, entry.v, {
                dsNominal: DS_NOMINAL,
                maxSamples: MAX_SAMPLES,
            });
            expect(fit.outcome).toBe("floor");
            const landed = evalGeo(entry, fit.nodes, DS_NOMINAL, MAX_SAMPLES);

            // both budgets, read the way the document reads them.
            expect(
                drift(
                    stations(target.fN, target.ds, target.edges),
                    stations(landed.fN, landed.ds, landed.edges),
                ),
            ).toBeLessThanOrEqual(FORCE_BUDGET);
            expect(
                posDrift(
                    posStations(target.x, target.y, target.ds, target.edges),
                    posStations(landed.posX, landed.posY, landed.ds, landed.edges),
                ),
            ).toBeLessThanOrEqual(GEO_BUDGET);

            // and the kernel's self-report IS that reading — same metric, same sampling, so the
            // two are the same number and any future divergence is a regression in the
            // alignment, not a tolerance to widen.
            expect(fit.forceError).toBeLessThanOrEqual(FORCE_BUDGET);
            expect(fit.deviation).toBeLessThanOrEqual(GEO_BUDGET);
        });
    }
});

// the Validation round-trip oracle: a geo scenario → the SHIPPED geo→force convert (the frozen
// golden, `convert-golden.json`) → this fit → back to the ORIGINAL scenario's own sampled
// geometry. bit-identical device-free, no ECS/history needed (the pure kernel atoms this command
// wraps). the point is that the trip closes on the shape it started from, which means actually
// sampling that shape and comparing against it — a check that never looks at the original
// geometry measures no round trip at all.
//
// the bound is derived from the two directions' own geometric floors, by the triangle
// inequality:
//
//   |fit − original| ≤ |fit − forceBake| + |forceBake − original| ≤ GEO_BUDGET + floor
//
// where `floor` is the geo→force direction's OWN shipping constraint for this scenario
// (`chordDeficit(spine) + 0.5·CONVERT_STEP`, `refine.ts`), read per-scenario off the frozen
// golden rather than assumed — it is not the same number for every scenario, and it is not
// `GEO_BUDGET` (that the two happen to sit near 0.5 m is arithmetic, not a derivation).
//
// the metric is symmetric nearest-point distance (discrete Hausdorff over the two sample sets).
// that is the quantity both floors bound: each direction's own reported deviation is a
// correspondence distance, which is ≥ the nearest-point distance to the same curve, so using the
// nearest-point metric here keeps the triangle bound conservative rather than mixing two
// alignments that were never defined against each other.
function hausdorff(
    a: { x: ArrayLike<number>; y: ArrayLike<number>; n: number },
    b: { x: ArrayLike<number>; y: ArrayLike<number>; n: number },
): number {
    const oneWay = (p: typeof a, q: typeof b): number => {
        let worst = 0;
        for (let i = 0; i < p.n; i++) {
            let near = Number.POSITIVE_INFINITY;
            for (let j = 0; j < q.n; j++) {
                const d = Math.hypot(p.x[i] - q.x[j], p.y[i] - q.y[j]);
                if (d < near) near = d;
            }
            if (near > worst) worst = near;
        }
        return worst;
    };
    return Math.max(oneWay(a, b), oneWay(b, a));
}

describe("round-trip: geo scenario → shipped geo→force convert → this fit → the scenario's shape", () => {
    const Golden = golden as Record<
        string,
        { points: { s: number; g: number }[]; length: number; ds: number; floor: number }
    >;
    for (const scenario of scenarios) {
        test(scenario.name, () => {
            const g = Golden[scenario.name];
            const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };

            // leg 0 — the original shape, the trip's own reference.
            const origin = evalGeo(entry, scenario.nodes, scenario.ds);

            // leg 1 — the shipped geo→force convert, replayed off its frozen golden.
            const bake = evalForce(entry, forceProfile(g.points, g.length, g.ds), g.ds);
            const target: GeofitBake = {
                x: bake.posX,
                y: bake.posY,
                fN: bake.fN,
                ds: bake.ds,
                edges: bake.fN.length,
            };

            // leg 2 — this fit, then the geometry the LANDED section bakes from its nodes (the
            // fit emits nodes, not samples; the shape only exists once they are sampled).
            const fit = geofit(target, entry.v);
            expect(fit.outcome).toBe("floor");
            const posX = new Float32Array(MAX_SAMPLES);
            const posY = new Float32Array(MAX_SAMPLES);
            const dsArr = new Float32Array(MAX_SAMPLES - 1);
            const landed = sampleChain(fit.nodes, DS_NOMINAL, posX, posY, dsArr, MAX_SAMPLES);
            expect(landed.valid).toBe(true);

            const drift = hausdorff(
                { x: origin.posX, y: origin.posY, n: origin.edges + 1 },
                { x: posX, y: posY, n: landed.edges + 1 },
            );
            expect(drift).toBeLessThanOrEqual(g.floor + GEO_BUDGET);
        });
    }
});
