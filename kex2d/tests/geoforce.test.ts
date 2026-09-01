import type { State } from "@dylanebert/shallot";
import { describe, expect, test } from "bun:test";
import { liveWorkers } from "../src/convert";
import { convertForce } from "../src/forcegeo";
import { convertGeo, StaleConvert } from "../src/geoforce";
import { createHistory, type History, undo } from "../src/history";
import { Easing } from "../src/profile";
import { Domain } from "../src/section";
import {
    bakeOut,
    Handle,
    handleAt,
    Section,
    sectionAt,
    sectionForces,
    sectionHandles,
    sectionInfo,
    SectionKind,
    type TrackSnapshot,
    setTrackDomain,
    setTrackFriction,
    setTrackResistance,
    snapshotAll,
    trackDomain,
} from "../src/track";
import { build, type Build } from "./helpers/build";
import { divergingPool, withWorker } from "./helpers/pool";

// the invoked geo→force command (kex2d-geoforce-editor stage 2): the conversion tier solved
// off-thread, landed on the document as ONE undo entry. the solve itself is oracled in
// `convert.test.ts` against the frozen golden; what's pinned here is the document seam —
// atomicity, byte-identical undo, downstream continuity, and that a conversion which does not
// finish writes nothing at all.

/** a track carrying one geo hump (the shape a conversion is invoked on), baked — authored
 *  through the shared `Build` (`tests/helpers/build.ts`). `bd` rides along on the return for the two
 *  callers below that append a downstream section through the command layer too. */
function humpTrack(): { state: State; eid: number; sec: number; bd: Build } {
    const bd = build();
    const sec = bd.appendSection(SectionKind.Geo);
    bd.moveNode(sec, 1, 12, 4);
    bd.addNode(sec, 24, 0);
    bd.startSpeed(18);
    bd.bake();
    return { state: bd.ecs, eid: bd.trackEid, sec, bd };
}

/** a track carrying one hand-authored force hill — a non-default easing tag on one keyframe, so
 *  a restore that dropped it would be caught — baked. kex2d-provenance stage 3's own oracle
 *  for the reverse trip (force→geo→force), the twin of `forcegeo.test.ts`'s `hillTrack`. This
 *  shape genuinely needs its 18 m/s (a shallower launch diverges the force→geo fit outright) —
 *  `setStartSpeed` authors the track-start one-shot (S3, its own point kind) once, here; a
 *  section kind-flip never touches it, so it carries through the round trip below with no
 *  special-case code (`preserveEntrySpeedAcrossConvert`, the pre-S3 mechanism this needed,
 *  retired at S2). Authored through `Build` (`tests/helpers/build.ts`): `appendSection` seeds two
 *  continuation keyframes on a Force section, cleared before the three exact ones
 *  (`acts.test.ts`'s `fiveKeyframeForceSection` gotcha). The easing tag has a command-layer
 *  op (`force-ease`, reached through `Build`'s generic `.op()` escape hatch — no dedicated
 *  convenience method exists for it). Explicit per-keyframe force handles left with
 *  `kex2d-segment-removal` S3; this fixture used to also author one to prove a restore couldn't
 *  drop it either. */
function hillForceTrack(): { state: State; eid: number; sec: number } {
    const bd = build();
    const sec = bd.appendSection(SectionKind.Force);
    bd.deleteForces(sectionForces(bd.ecs, sec).map((r) => r.id));
    bd.sectionLength(sec, 40);
    bd.addForce(sec, 0, 1);
    const b = bd.addForce(sec, 20, 1.4);
    bd.addForce(sec, 40, 1);
    bd.op({ type: "force-ease", ids: [b], ease: Easing.Linear });
    bd.startSpeed(18);
    bd.bake();
    return { state: bd.ecs, eid: bd.trackEid, sec };
}

/** the whole authored document plus the bake's own input hash — the two readings that
 *  together say "byte-identical": every stored value back where it was, and the bake gate
 *  agreeing nothing about its input moved. */
function docState(state: State, eid: number): { snap: TrackSnapshot; hash: string } {
    return { snap: snapshotAll(state), hash: bakeOut.get(eid)?.hash ?? "" };
}

/** convert `sec` and settle the bake, asserting the solve actually converged (every pin below
 *  is about the document, not about the solver having a good day). */
async function convertAndBake(h: History, state: State, sec: number) {
    const result = await convertGeo(h, state, sec);
    expect(result.outcome).toBe("floor");
    state.step(0);
    return result;
}

describe("convertGeo", () => {
    test("the solve lands atomically and undo restores the geo section byte-identical", async () => {
        const { state, eid, sec } = humpTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const result = await convertAndBake(h, state, sec);

        const secEid = sectionAt(state, sec);
        if (secEid === null) throw new Error("section missing");
        expect(Section.kind.get(secEid)).toBe(SectionKind.Force);
        // the solve's realized extent, exactly — not the destructive convert's default extent.
        expect(Section.length.get(secEid)).toBe(result.length);
        // the shape nodes are gone and the answer's keyframes are all that's there.
        expect(sectionHandles(state, sec)).toHaveLength(0);
        expect(sectionForces(state, sec).map(({ s, g }) => ({ s, g }))).toEqual(result.points);

        // one entry, and undoing it puts the track back exactly as authored.
        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        expect(docState(state, eid)).toEqual(before);
    }, 60_000);

    test("the converted section joins the chain where the geo shape exited", async () => {
        // continuity is the whole point of a shape-preserving conversion: the downstream
        // section is placed rigidly at this one's exit, so an exit that moved re-frames the
        // rest of the track. the bound is stage 1's exit-miss oracle, at the document layer:
        // the realized step spans the solve exactly and closes the pinned exit to ~1e-5 m,
        // while replaying the same profile at the nominal quantum stops ~0.2 m short. 1e-3
        // separates the two by orders of magnitude — the solve's own ~0.5 m floor is far too
        // loose to tell them apart.
        const { state, sec, bd } = humpTrack();
        const down = bd.appendSection(SectionKind.Geo);
        state.step(0);
        const geoExit = { ...(sectionInfo.get(down)?.entry ?? { x: Number.NaN, y: Number.NaN }) };

        await convertAndBake(createHistory(), state, sec);

        const forceExit = sectionInfo.get(down)?.entry;
        if (!forceExit) throw new Error("downstream section lost its bake");
        const miss = Math.hypot(forceExit.x - geoExit.x, forceExit.y - geoExit.y);
        expect(miss).toBeLessThan(1e-3);
    }, 60_000);

    test("a cancelled conversion leaves the track byte-identical", async () => {
        // the façade writes nothing and the apply happens once at resolution, so there is no
        // rollback path to get wrong — this pins that there is nothing TO roll back.
        const { state, eid, sec } = humpTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const controller = new AbortController();
        const solving = convertGeo(h, state, sec, { signal: controller.signal });
        controller.abort(new Error("cancelled from the modal"));
        // the caller's own reason comes back, not a generic failure — that is what lets a UI
        // tell a cancel apart from a conversion that broke.
        await expect(solving).rejects.toThrow(/cancelled from the modal/);

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
        expect(liveWorkers()).toBe(0);
    }, 60_000);

    test("a diverged conversion leaves the track byte-identical", async () => {
        // a diverged answer still resolves — the caller surfaces it — but it is not an
        // authored section, so nothing of it reaches the document (its NaN deviation above
        // all, which is why nothing but points/length/ds is ever stored).
        const { state, eid, sec } = humpTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const result = await withWorker(divergingPool(), () =>
            convertGeo(h, state, sec, { workers: 4 }),
        );
        expect(result.outcome).toBe("diverged");

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
    }, 60_000);

    test("an edit during the solve rejects the answer instead of landing it stale", async () => {
        // the solve targets the shape it was handed. if the document moves under it — a node
        // drag, a delete, another op — its answer describes a shape that is no longer there, and
        // landing it would silently replace what the author just did. the caller blocks input
        // for the duration; this is the backstop for when something gets through anyway.
        const { state, eid, sec } = humpTrack();
        const h = createHistory();

        const solving = convertGeo(h, state, sec);
        const crest = handleAt(state, sec, 1);
        if (crest === null) throw new Error("node missing");
        Handle.pos.set(crest, 12, 9); // a mid-solve reshape
        state.step(0);
        const edited = docState(state, eid);

        await expect(solving).rejects.toThrow(StaleConvert);
        state.step(0);
        expect(docState(state, eid)).toEqual(edited); // the edit stands, the answer is dropped
        expect(h.undo).toHaveLength(0);
    }, 60_000);

    test("a second invoke while one is running is refused", async () => {
        // two solves landing on one section would each snapshot the other's output as their
        // "before", so the second undo would restore the first solve rather than the geo shape.
        const { state, sec } = humpTrack();
        const h = createHistory();

        const first = convertGeo(h, state, sec);
        await expect(convertGeo(h, state, sec)).rejects.toThrow(/already converting/);
        await first;
        state.step(0);

        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        expect(sectionHandles(state, sec)).toHaveLength(3); // one entry took it all the way back
        // and the section is free again once the first invoke settled.
        await expect(convertGeo(h, state, sec)).resolves.toMatchObject({ outcome: "floor" });
    }, 60_000);

    test("landing on a Time-domain track still stores METERS (S6: domain is a display lens)", async () => {
        // the solve is distance-internal (its golden is frozen in meters), and the store never
        // varies by `Track.domain` (S6 retired `domain.convertSolve` entirely) — so the landing
        // is the solve's own answer, unconverted, whatever the ruler is showing.
        const { state, eid, sec } = humpTrack();
        setTrackDomain(state, Domain.Time);
        state.step(0);
        const before = docState(state, eid);
        const h = createHistory();

        const result = await convertAndBake(h, state, sec);
        const secEid = sectionAt(state, sec);
        if (secEid === null) throw new Error("section missing");

        const landed = Section.length.get(secEid);
        expect(landed).toBe(result.length);
        const stored = sectionForces(state, sec).map((p) => p.s);
        expect(stored).toEqual(result.points.map((p) => p.s));

        // still ONE entry, and undoing it puts the geo shape back byte-identical.
        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(trackDomain(state)).toBe(Domain.Time); // a landing never flips the domain itself
    }, 60_000);

    test("a convert-fit on a track with friction targets the dissipative force curve", async () => {
        // the solve's target is `evalGeo`'s own recovered force curve. geometry is unchanged
        // between the two tracks below, but the RECOVERED v (and so fN = κ·v²/g + cosθ) differs
        // once the march dissipates energy along an identical path. Before threading,
        // `convertGeo` called `evalGeo` with friction/resistance defaulted to 0 regardless of the
        // track's own authored coefficients — so authoring `Track.friction` had NO effect on what
        // the fit targeted. Run the identical geo shape
        // twice, coefficients zero vs a physically-plausible nonzero pair, and the landed fits
        // must differ: a threaded caller sees a different target; an unthreaded one always sees
        // the same frictionless one regardless of what's authored.
        const frictionless = humpTrack();
        setTrackFriction(frictionless.eid, 0);
        setTrackResistance(frictionless.eid, 0);
        frictionless.state.step(0);
        const zero = await convertAndBake(createHistory(), frictionless.state, frictionless.sec);
        expect(zero.outcome).not.toBe("diverged");

        const dissipative = humpTrack();
        setTrackFriction(dissipative.eid, 0.1);
        setTrackResistance(dissipative.eid, 0.002);
        dissipative.state.step(0);
        const lossy = await convertAndBake(createHistory(), dissipative.state, dissipative.sec);
        expect(lossy.outcome).not.toBe("diverged");

        expect(lossy.points).not.toEqual(zero.points);
    }, 60_000);

    test("a section that isn't geo is refused", async () => {
        const { state, sec, bd } = humpTrack();
        const force = bd.appendSection(SectionKind.Force);
        state.step(0);
        await expect(convertGeo(createHistory(), state, force)).rejects.toThrow(/not geo/);
        await expect(convertGeo(createHistory(), state, sec + 999)).rejects.toThrow(/no section/);
    });
});

// ── provenance short-circuit, reverse direction (kex2d-provenance stage 3) ────────────────────
// `history.solveGeo` stamps a section's pre-fit FORCE payload (the force→geo landing,
// `forcegeo.convertForce`); `convertGeo` consults it here BEFORE spawning the worker pool. An
// untouched force→geo→force trip lands the stamp verbatim instead of re-converting — exactness,
// not a budget, so any edit the token or entry covers falls straight through to the solve
// unchanged. Mirrors `forcegeo.test.ts`'s "provenance short-circuit" describe (stage 2), the
// other direction.

describe("provenance short-circuit (reverse)", () => {
    test("an untouched trip restores the force section content-hash-identical, easing + extent included", async () => {
        const { state, eid, sec } = hillForceTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const geoResult = await convertForce(h, state, sec);
        expect(geoResult.outcome).not.toBe("diverged");
        state.step(0);

        const forceResult = await convertGeo(h, state, sec);
        expect(forceResult.outcome).toBe("restored");
        state.step(0);

        expect(docState(state, eid)).toEqual(before);
    }, 60_000);

    test("a geo-node edit after the fit falls through to the solve", async () => {
        const { state, sec } = hillForceTrack();
        const h = createHistory();

        await convertForce(h, state, sec);
        state.step(0);
        const tip = handleAt(state, sec, 1);
        if (tip === null) throw new Error("no node");
        Handle.pos.set(tip, Handle.pos.x.get(tip) + 1, Handle.pos.y.get(tip)); // an edit to the landed section

        state.step(0);
        const result = await convertGeo(h, state, sec);
        expect(result.outcome).not.toBe("restored");
    }, 60_000);

    test("an upstream edit that moves the section's entry falls through to the solve", async () => {
        const bd = build();
        const upstream = bd.appendSection(SectionKind.Geo);
        bd.moveNode(upstream, 1, 15, 0);
        const sec = bd.appendSection(SectionKind.Force);
        bd.deleteForces(sectionForces(bd.ecs, sec).map((r) => r.id));
        bd.sectionLength(sec, 40);
        bd.addForce(sec, 0, 1);
        bd.addForce(sec, 20, 1.4);
        bd.addForce(sec, 40, 1);
        bd.startSpeed(18);
        bd.bake();
        const state = bd.ecs;
        const h = createHistory();

        await convertForce(h, state, sec);
        state.step(0);

        // move the upstream tip — the force section's entry (its stamp anchor) shifts under it.
        // a raw component write, not `moveNode`: `node-move` also recomputes the node's
        // auto-tangent (measured — its `theta` moved from 0 to ~0.76 rad on an identical
        // position edit), which would change what geometry the downstream solve reads, not
        // just its entry point.
        const handles = sectionHandles(state, upstream);
        Handle.pos.y.set(handles[handles.length - 1], 6);
        state.step(0);

        const result = await convertGeo(h, state, sec);
        expect(result.outcome).not.toBe("restored");
    }, 60_000);

    test("a Track.domain flip after the fit still short-circuits (S6: domain is a display lens)", async () => {
        // `Track.domain` used to ride the token because a flip converted the section's own
        // stored numbers — S6 retired that conversion entirely, so a flip changes no authored
        // component and the stamp still certifies.
        const { state, sec } = hillForceTrack();
        const h = createHistory();

        await convertForce(h, state, sec);
        state.step(0);

        setTrackDomain(state, Domain.Time);
        state.step(0);
        const result = await convertGeo(h, state, sec);
        expect(result.outcome).toBe("restored");
    }, 60_000);

    test("undo after a restore returns the geo section byte-identically", async () => {
        const { state, eid, sec } = hillForceTrack();
        const h = createHistory();

        await convertForce(h, state, sec);
        state.step(0);
        const geoState = docState(state, eid); // the landed geo section, pre-restore

        const result = await convertGeo(h, state, sec);
        expect(result.outcome).toBe("restored");
        state.step(0);

        undo(h, state);
        state.step(0);
        expect(docState(state, eid)).toEqual(geoState);
    }, 60_000);

    test("re-entrancy and stale-convert guards are unchanged by the short-circuit", async () => {
        // mirrors `forcegeo.test.ts`'s equivalent pin: the reentrancy guard fires before the
        // short-circuit is ever consulted, whether or not the section carries a valid stamp.
        const { state, sec } = hillForceTrack();
        const h = createHistory();

        await convertForce(h, state, sec);
        state.step(0);
        const tip = handleAt(state, sec, 1);
        if (tip === null) throw new Error("no node");
        Handle.pos.set(tip, Handle.pos.x.get(tip) + 1, Handle.pos.y.get(tip)); // invalidate the stamp
        state.step(0);

        const first = convertGeo(h, state, sec);
        await expect(convertGeo(h, state, sec)).rejects.toThrow(/already converting/);
        const result = await first;
        expect(result.outcome).not.toBe("restored");
        state.step(0);
    }, 60_000);
});
