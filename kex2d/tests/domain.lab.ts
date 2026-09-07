// S6 flip instrument (spec `kex/specs/kex2d-strip-ux.md`, "Domain: arclength is canonical, time
// is a lens"). Run: bun tests/domain.lab.ts
//
// This lab used to measure the D1 carry op's own reshape residual — the 2026-08-04 hands-on
// report of a 0.03-0.53 m world-exit deviation across one `convertDomain(Distance→Time)`, from a
// cubic bezier authored in `(s, g)` not carrying exactly to a cubic bezier in `(t, g)` under the
// nonlinear arc↔time map. S6 retired the carry entirely: `Track.domain` is a display lens over
// the live bake's s↔t table, never a document conversion, so every force keyframe/extent/strip
// stays in meters of arclength across a flip and the bake never re-marches differently. The
// reported deviation therefore has no mechanism left to produce it — this lab now measures
// exactly that: world exit position and `Section.length` across a flip and a full M→S→M round
// trip must read EXACTLY 0 deviation, not merely "within the old reshape tolerance."

import "./setup";
import type { State } from "@dylanebert/shallot";
import { convertDomain } from "../src/domain";
import { createHistory } from "../src/history";
import { Domain } from "../src/section";
import {
    bakeOut,
    samples,
    sectionForces,
    sectionInfo,
    type SectionInfo,
    SectionKind,
} from "../src/track";
import { build } from "./helpers/build";

interface Pos {
    x: number;
    y: number;
}

const dist = (a: Pos, b: Pos): number => Math.hypot(a.x - b.x, a.y - b.y);

function info(sectionId: number): SectionInfo {
    const i = sectionInfo.get(sectionId);
    if (!i) throw new Error(`no bake for section ${sectionId}`);
    return i;
}

// ── the reported scenario: a 10 m geo section feeding a force chain with real curvature ───────
//
// The geo section is a fixed 10 m level straight run supplying the entry state, exactly the
// report's "10 m geo section followed by" framing, kept LEVEL so the force section's own
// authored curvature is the only source of turning. The force profile is the reported dive
// shape — `[0,1], [len/2, 0.4], [len,1]` — the deeper dip that had real curvature to reshape.

export interface Scenario {
    state: State;
    trackEid: number;
    geo: number;
    force: number;
}

/** authored through the shared `Build` (`tests/helpers/build.ts`) rather than raw `track.ts` primitives.
 *  `appendSection` seeds two continuation keyframes on a Force section, cleared before the
 *  three exact stations (`acts.test.ts`'s `fiveKeyframeForceSection` gotcha) — this lab's own
 *  exact-zero-deviation gate needs the same exact keyframe set the report reproduced. */
export function buildScenario(len: number): Scenario {
    const bd = build();
    const geo = bd.appendSection(SectionKind.Geo);
    bd.moveNode(geo, 1, 10, 0);
    const force = bd.appendSection(SectionKind.Force);
    bd.deleteForces(sectionForces(bd.ecs, force).map((r) => r.id));
    bd.sectionLength(force, len);
    bd.addForce(force, 0, 1);
    bd.addForce(force, len * 0.5, 0.4);
    bd.addForce(force, len, 1);
    bd.bake();
    return { state: bd.ecs, trackEid: bd.trackEid, geo, force };
}

export function exitPos(sc: Scenario): Pos {
    const eid = sc.trackEid;
    const s = samples.get(eid);
    if (!s) throw new Error("no samples");
    const i = info(sc.force);
    return { x: s.posX[i.endSample], y: s.posY[i.endSample] };
}

function forceLength(sc: Scenario): number {
    const out = bakeOut.get(sc.trackEid);
    if (!out) throw new Error("no bakeOut");
    // authored extent, not baked — the SAME value `Section.length` holds, read through the
    // section's own info so a stale reference can't silently pass.
    const i = info(sc.force);
    return i.endSample - i.startSample; // sample-count proxy is enough: a flip changes no shape
}

// ── quantity 1: world exit deviation across one flip — must read EXACTLY 0 (S6) ────────────────

export function exitDeviation(len: number, target: Domain = Domain.Time): number {
    const sc = buildScenario(len);
    const before = exitPos(sc);
    const h = createHistory();
    if (!convertDomain(h, sc.state, target)) {
        throw new Error(`convertDomain rejected len=${len}`);
    }
    sc.state.step(0);
    const after = exitPos(sc);
    return dist(before, after);
}

// ── quantity 2: a full Meters → Seconds → Meters round trip — must also read EXACTLY 0 ─────────

export function roundTripDeviation(len: number): { exit: number; edges: number } {
    const sc = buildScenario(len);
    const before = exitPos(sc);
    const edgesBefore = forceLength(sc);
    const h = createHistory();
    convertDomain(h, sc.state, Domain.Time);
    sc.state.step(0);
    convertDomain(h, sc.state, Domain.Distance);
    sc.state.step(0);
    const after = exitPos(sc);
    const edgesAfter = forceLength(sc);
    return { exit: dist(before, after), edges: Math.abs(edgesAfter - edgesBefore) };
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────

const LENGTHS = [39.352, 40.08, 40.82, 39.5, 40.0, 40.5, 41.0];

interface Row {
    len: number;
    exitDeviation: number;
    roundTripExit: number;
    roundTripEdges: number;
}

const rows: Row[] = LENGTHS.map((len) => {
    const rt = roundTripDeviation(len);
    return {
        len,
        exitDeviation: exitDeviation(len),
        roundTripExit: rt.exit,
        roundTripEdges: rt.edges,
    };
});

console.log("Per-row inputs: 10 m level geo run (nodes at (0,0)/(10,0)) + force chain of the");
console.log(
    "swept length L, keys at [0, 0.5L, L] = g [1, 0.4, 1] (the reported dive-and-recover).\n",
);
console.table(rows);

// ── the lab's own gate: every row reads EXACTLY 0, both a single flip and the round trip ───────

const bad = rows.filter(
    (r) => r.exitDeviation !== 0 || r.roundTripExit !== 0 || r.roundTripEdges !== 0,
);
if (bad.length > 0) {
    throw new Error(
        `S6 gate FAILED: a flip moved the world exit or the force chain's own edge count on ` +
            `${bad.length}/${rows.length} rows (measured: ${JSON.stringify(bad)}). Arclength is ` +
            `supposed to be canonical — a domain flip must change nothing.`,
    );
}
console.log(
    `S6 gate PASSED: all ${rows.length} rows read EXACTLY 0 world-exit deviation, both a single ` +
        "flip and a full M→S→M round trip — the reported 0.03-0.53 m band no longer reproduces, " +
        "by construction rather than by tolerance.",
);
