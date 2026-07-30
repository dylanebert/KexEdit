import { State } from "@dylanebert/shallot";
import { describe, expect, test } from "bun:test";
import { convertForce, MAX_LANDED_NODES, StaleConvert } from "../src/forcegeo";
import { convertGeo } from "../src/geoforce";
import { FORCE_BUDGET } from "../src/geofit";
import { liveFitWorkers } from "../src/geofit-async";
import { createHistory, type History, undo } from "../src/history";
import { Domain } from "../src/section";
import { TangentMode } from "../src/spline";
import {
    addNode,
    appendSection,
    BakeSystem,
    bakeOut,
    createForcePoint,
    createSection,
    createTrack,
    Handle,
    handleTangent,
    sectionAt,
    sectionHandles,
    Section,
    SectionKind,
    type SectionSnapshot,
    sectionForces,
    sectionInfo,
    seedTangent,
    setForcePoint,
    setTangent,
    setTrackDomain,
    setTrackV0,
    snapshotAll,
    trackDomain,
} from "../src/track";
import { budgetFit, divergingFit, dyingFit, withFitWorker } from "./helpers/fitworker";
import { drift, type Stations, stations } from "./helpers/stations";

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

/** a track carrying one hand-authored hill (the shape kex2d-provenance's symptom is named
 *  against — an untouched geo→force→geo trip gaining nodes), baked. */
function hillTrack(): { state: State; eid: number; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setTrackV0(eid, 18);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 10, 2);
    addNode(state, sec, 20, 4);
    addNode(state, sec, 30, 2);
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

    test("a budget outcome at the landing ceiling lands", async () => {
        // the guard is `> MAX_LANDED_NODES`, so exactly the ceiling still lands — a chain this
        // size is still the codebase's own worked authoring scale (`MAX_LANDED_NODES`'s
        // derivation), not the pathology the guard exists to refuse.
        const { state, sec } = humpForceTrack();
        const h = createHistory();

        const result = await withFitWorker(budgetFit(MAX_LANDED_NODES), () =>
            convertForce(h, state, sec),
        );

        expect(result.outcome).toBe("budget");
        expect(result.nodes).toHaveLength(MAX_LANDED_NODES);
        const secEid = sectionAt(state, sec);
        if (secEid === null) throw new Error("section missing");
        expect(Section.kind.get(secEid)).toBe(SectionKind.Geo);
        expect(sectionHandles(state, sec)).toHaveLength(MAX_LANDED_NODES);
        expect(h.undo).toHaveLength(1);
    }, 60_000);

    test("a budget outcome over the landing ceiling refuses as dense, writing nothing", async () => {
        const { state, eid, sec } = humpForceTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const result = await withFitWorker(budgetFit(MAX_LANDED_NODES + 1), () =>
            convertForce(h, state, sec),
        );

        expect(result.outcome).toBe("dense");
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

    test("a Time-domain force section fits and lands symmetrically", async () => {
        // the geo→force direction converts its answer at the landing (`domain.convertSolve`);
        // this direction needs no conversion — a fit emits world POSITIONS, and geo is
        // position-authored in either domain. What must hold anyway is that the fit reads a
        // time-marched section correctly (`track.forceBake` threads the domain into `evalForce`)
        // and lands as one byte-identically undoable entry, with the store's seconds restored.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackDomain(state, Domain.Time);
        setTrackV0(eid, 18);
        // `humpForceTrack`'s profile in the time domain: the same hump over the duration a
        // ~18 m/s cart takes to cover its 40 m.
        const sec = createSection(state, 0, SectionKind.Force, 40 / 18);
        createForcePoint(state, sec, 0, 1);
        createForcePoint(state, sec, 20 / 18, 1.4);
        createForcePoint(state, sec, 40 / 18, 1);
        const down = appendSection(state, SectionKind.Geo);
        state.step(0);
        const before = docState(state, eid);
        const forceExit = { ...(sectionInfo.get(down)?.entry ?? { x: Number.NaN, y: Number.NaN }) };
        const h = createHistory();

        const result = await convertAndBake(h, state, sec);

        const secEid = sectionAt(state, sec);
        if (secEid === null) throw new Error("section missing");
        expect(Section.kind.get(secEid)).toBe(SectionKind.Geo);
        expect(Section.length.get(secEid)).toBe(0); // the seconds extent is gone with the store
        expect(Section.ds.get(secEid)).toBe(0);
        expect(sectionForces(state, sec)).toHaveLength(0);
        expect(sectionHandles(state, sec)).toHaveLength(result.nodes.length);
        // the shape the time march produced is what landed — same exit, the geoforce bound.
        const geoExit = sectionInfo.get(down)?.entry;
        if (!geoExit) throw new Error("downstream section lost its bake");
        expect(Math.hypot(geoExit.x - forceExit.x, geoExit.y - forceExit.y)).toBeLessThan(1e-3);

        // one entry, and undo brings the seconds store back byte-identical (`docState`'s
        // whole-track snapshot carries every `Force.s`, so the units come back with it).
        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(trackDomain(state)).toBe(Domain.Time);
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

// ── provenance short-circuit (kex2d-provenance stage 2) ──────────────────────
// `history.solveForce` stamps a section's pre-solve payload (stage 1); `convertForce` consults it
// here BEFORE spawning the worker. An untouched geo→force→geo trip lands the stamp verbatim
// instead of re-fitting — exactness, not a budget, so any edit the token or entry covers falls
// straight through to the fit unchanged.

describe("provenance short-circuit", () => {
    test("an untouched trip restores the geo section content-hash-identical, hill seed included", async () => {
        const { state, eid, sec } = hillTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const forceResult = await convertGeo(h, state, sec);
        expect(forceResult.outcome).not.toBe("diverged");
        state.step(0);

        const geoResult = await convertForce(h, state, sec);
        expect(geoResult.outcome).toBe("restored");
        state.step(0);

        expect(docState(state, eid)).toEqual(before);
    }, 60_000);

    test("an untouched trip restores across the corpus", async () => {
        // a second, differently-shaped scenario (not just the named hill symptom) — the
        // exactness claim isn't a property of one hand-picked shape.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackV0(eid, 22);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 15, -3);
        addNode(state, sec, 30, 0);
        addNode(state, sec, 45, 4);
        state.step(0);
        const h = createHistory();
        const before = docState(state, eid);

        await convertGeo(h, state, sec);
        state.step(0);
        const result = await convertForce(h, state, sec);
        expect(result.outcome).toBe("restored");
        state.step(0);

        expect(docState(state, eid)).toEqual(before);
    }, 60_000);

    test("a force-section edit after the solve falls through to the fit", async () => {
        const { state, sec } = hillTrack();
        const h = createHistory();

        await convertGeo(h, state, sec);
        state.step(0);
        const pts = sectionForces(state, sec);
        setForcePoint(state, pts[0].id, pts[0].s, pts[0].g + 0.3); // an edit to the landed section
        state.step(0);

        const result = await convertForce(h, state, sec);
        expect(result.outcome).not.toBe("restored");
    }, 60_000);

    test("an upstream edit that moves the section's entry falls through to the fit", async () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackV0(eid, 18);
        const upstream = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, upstream, 0, 0);
        addNode(state, upstream, 15, 0);
        const sec = createSection(state, 1, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 10, 2);
        addNode(state, sec, 20, 4);
        state.step(0);
        const h = createHistory();

        await convertGeo(h, state, sec);
        state.step(0);

        // move the upstream tip — the force section's entry (its stamp anchor) shifts under it.
        const handles = sectionHandles(state, upstream);
        Handle.pos.y.set(handles[handles.length - 1], 6);
        state.step(0);

        const result = await convertForce(h, state, sec);
        expect(result.outcome).not.toBe("restored");
    }, 60_000);

    test("undo after a restore returns the force section byte-identically", async () => {
        const { state, eid, sec } = hillTrack();
        const h = createHistory();

        await convertGeo(h, state, sec);
        state.step(0);
        const forceState = docState(state, eid); // the landed force section, pre-restore

        const result = await convertForce(h, state, sec);
        expect(result.outcome).toBe("restored");
        state.step(0);

        undo(h, state);
        state.step(0);
        expect(docState(state, eid)).toEqual(forceState);
    }, 60_000);

    test("re-entrancy and stale-convert guards are unchanged by the short-circuit", async () => {
        // the guard fires on the plain reentrancy check before the short-circuit is ever
        // consulted, whether or not the section carries a valid stamp — a running fit still
        // refuses a second invoke, and an edit mid-fit still rejects as stale (both already
        // pinned above for a section with NO provenance; this pins the same guards hold for one
        // that DOES, once its stamp is invalidated so the call actually reaches the fit).
        const { state, sec } = hillTrack();
        const h = createHistory();

        await convertGeo(h, state, sec);
        state.step(0);
        const pts = sectionForces(state, sec);
        setForcePoint(state, pts[0].id, pts[0].s, pts[0].g + 0.3); // invalidate the stamp
        state.step(0);

        const first = convertForce(h, state, sec);
        await expect(convertForce(h, state, sec)).rejects.toThrow(/already converting/);
        const result = await first;
        expect(result.outcome).not.toBe("restored");
        state.step(0);
    }, 60_000);

    test("an explicit tangent survives the restore — the fit path emits Auto-only", async () => {
        const { state, eid, sec } = hillTrack();
        const tan = seedTangent(state, sec, 1, TangentMode.Mirror);
        if (!tan) throw new Error("no tangent seed");
        setTangent(state, sec, 1, tan);
        state.step(0);
        // the AUTHORED (post-write, f32-quantized) tangent, not the raw seed — `setTangent`
        // writes the seed's double-precision components into f32 storage, so comparing against
        // the seed itself would fail on the write's own rounding, unrelated to the restore.
        const authoredTan = handleTangent(state, sec, 1);
        const before = docState(state, eid);
        const h = createHistory();

        await convertGeo(h, state, sec);
        state.step(0);
        const result = await convertForce(h, state, sec);
        expect(result.outcome).toBe("restored");
        state.step(0);

        expect(docState(state, eid)).toEqual(before);
        expect(handleTangent(state, sec, 1)).toEqual(authoredTan);
    }, 60_000);
});

// ── the document-layer fidelity oracle ───────────────────────────────────────
// the layer the AUTHOR sees. `geofit.ts` scores its own candidates; this asserts on the track's
// own bake before and after the convert, which is independently captured truth — the fit could
// hold its internal budget perfectly and still blow the displayed one if it scored a sampling
// the document never bakes (it did: the reviewer's hard case read 0.45 g reported vs 5.94 g
// displayed), or scored it on a coordinate the timeline doesn't draw (it did: span-normalized
// alignment divides out the fitted chain's corner-cutting shortfall, reading 0.48 g against
// 1.57 g displayed on valley-explicit). The station-axis alignment lives in
// `helpers/stations.ts`; the corpus-wide gate over the same metric is `forcegeo.oracle.ts`
// (full tier).

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
