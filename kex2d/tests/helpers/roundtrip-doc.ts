/** document-layer round-trip sweep helpers (kex2d-provenance stage 4, spec
 *  `kex/specs/kex2d-provenance.md`): the corpus + the hill-seed scenario built through the same
 *  ECS calls the editor authors through (`spawnNode`/`createForcePoint`, not `addNode`'s live
 *  editor walk — every scenario already carries its final `theta`/`tangent`, so seeding is a
 *  direct write, not a replay), then round-tripped through the real document commands
 *  (`geoforce.convertGeo` / `forcegeo.convertForce`) — the ECS + history + convert layer the
 *  spec's universal claim is about, not the pure kernel `roundtrip.lab.ts` measures. */

import { State } from "@dylanebert/shallot";
import { convertForce } from "../../src/forcegeo";
import { convertGeo } from "../../src/geoforce";
import { createHistory } from "../../src/history";
import type { Scenario } from "../../src/scenarios";
import type { Node } from "../../src/spline";
import {
    bakeOut,
    BakeSystem,
    createForcePoint,
    createSection,
    createTrack,
    type SectionSnapshot,
    SectionKind,
    setTrackV0,
    snapshotAll,
    spawnNode,
} from "../../src/track";
import { withThetas } from "./chain";

/** the hand-authored hill (`forcegeo.test.ts`'s `hillTrack`, the same 0/10/20/30 node walk),
 *  wrapped as a `Scenario` so it sweeps through the same document-layer machinery as the
 *  corpus — the symptom's own named oracle (spec Goal: "a hand-authored hill gains nodes on an
 *  untouched geo→force→geo trip"), not a synthetic stand-in. */
export const hillSeed: Scenario = {
    name: "hill-seed",
    nodes: withThetas([
        { x: 0, y: 0 },
        { x: 10, y: 2 },
        { x: 20, y: 4 },
        { x: 30, y: 2 },
    ]),
    ds: 0,
    v0: 18,
};

/** every scenario this sweep must hold the universal claim over: the 10-scenario corpus
 *  (`src/scenarios.ts`) plus the hill seed. */
export function sweepCorpus(scenarios: readonly Scenario[]): Scenario[] {
    return [...scenarios, hillSeed];
}

export interface DocState {
    snap: SectionSnapshot[];
    hash: string;
}

/** the whole authored document plus the bake's own input hash — `forcegeo.test.ts`/
 *  `geoforce.test.ts`'s own `docState`, duplicated here since this is a third consumer sharing
 *  no other import with either. */
export function docState(state: State, eid: number): DocState {
    return { snap: snapshotAll(state), hash: bakeOut.get(eid)?.hash ?? "" };
}

/** seed a single-section geo track from a scenario's (or the hill seed's) node list — the
 *  document-layer twin of `evalGeo(entry, scenario.nodes, scenario.ds)`. `spawnNode` writes each
 *  node's already-computed `theta`/`tangent` directly (node 0 pinned at the local origin, the
 *  rigid entry-frame law), rather than replaying `addNode`'s live-inference walk, since the
 *  corpus's nodes are already in that final, bake-ready form. Every corpus scenario's `ds` is
 *  `DS_NOMINAL` (0.5), so leaving `Section.ds` at its sentinel (0, resolving to `DS_NOMINAL`) —
 *  exactly what every other document-layer test does — reproduces `scenario.ds` exactly; the
 *  hill seed's `ds: 0` is the same sentinel by construction. */
export function buildGeoSection(scenario: Scenario | { name: string; nodes: Node[]; v0: number }): {
    state: State;
    eid: number;
    sec: number;
} {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setTrackV0(eid, scenario.v0);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    scenario.nodes.forEach((n, i) => {
        spawnNode(state, sec, i, n.x, n.y, n.theta, n.tangent);
    });
    state.step(0);
    return { state, eid, sec };
}

/** build a force section from a landed `{s, g}` profile — the document-layer twin of
 *  `evalForce(entry, forceProfile(points, length, ds), ds)`: `createForcePoint` spawns each key
 *  at the default ease with no explicit tangent, exactly what `applyConvert`'s own landing
 *  spawns (kex2d-map.md: "spawn its `{s,g}` keys — all default-Cubic by construction"). */
function buildForceSection(
    points: readonly { s: number; g: number }[],
    length: number,
    ds: number,
    v0: number,
): { state: State; eid: number; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setTrackV0(eid, v0);
    const sec = createSection(state, 0, SectionKind.Force, length, ds);
    for (const p of points) createForcePoint(state, sec, p.s, p.g);
    state.step(0);
    return { state, eid, sec };
}

/** the geo→force→geo leg: land the scenario's geo section as force (a genuine solve — a fresh
 *  section carries no provenance), then convert it back — untouched, so it must restore
 *  content-hash-identical to the pre-trip geo section. Throws (loudly, not a skip) on ANY
 *  fall-through: the forward solve diverging (nothing to restore against), the reverse convert
 *  not reporting `"restored"`, or a restore whose content doesn't match pre-trip bit-for-bit —
 *  every one of those is the defect this sweep exists to catch. */
export async function sweepGeoLeg(scenario: Scenario): Promise<{ scenario: string; ms: number }> {
    const t0 = performance.now();
    const { state, eid, sec } = buildGeoSection(scenario);
    const h = createHistory();
    const before = docState(state, eid);

    const forceResult = await convertGeo(h, state, sec);
    if (forceResult.outcome === "diverged") {
        throw new Error(
            `${scenario.name}: geo→force diverged deriving the forward leg — no landing to round-trip against`,
        );
    }
    state.step(0);

    const geoResult = await convertForce(h, state, sec);
    state.step(0);
    if (geoResult.outcome !== "restored") {
        throw new Error(
            `${scenario.name}: geo→force→geo did NOT restore (outcome "${geoResult.outcome}") — an untouched trip fell through to the fit`,
        );
    }

    const after = docState(state, eid);
    if (after.hash !== before.hash || JSON.stringify(after.snap) !== JSON.stringify(before.snap)) {
        throw new Error(
            `${scenario.name}: geo→force→geo reported "restored" but the section content is NOT identical to the pre-trip state`,
        );
    }
    return { scenario: scenario.name, ms: performance.now() - t0 };
}

/** the force→geo→force leg. The corpus is geo-shaped only (`src/scenarios.ts`), so the
 *  force-authored pre-trip state is DERIVED: `scenario`'s geo section is genuinely converted
 *  once (a throwaway document, never touched again) to harvest a real `{points, length, ds}`
 *  profile, then that profile is landed into an independent, freshly-built force section
 *  (`buildForceSection`) that has never been the target of ANY document solve — so it carries no
 *  provenance stamp of its own, and `convertForce` below is guaranteed to run a genuine fit, not
 *  a restore. That fit stamps the reverse direction (`history.solveGeo`), and the untouched
 *  `convertGeo` that follows must restore back to this force section exactly — a real
 *  force→geo→force trip, per the spec's per-trip claim (both directions "one mechanism, stamped
 *  at both landings," not a single shared stamp). */
export async function sweepForceLeg(scenario: Scenario): Promise<{ scenario: string; ms: number }> {
    const t0 = performance.now();
    const derive = buildGeoSection(scenario);
    const derived = await convertGeo(createHistory(), derive.state, derive.sec);
    if (derived.outcome === "diverged") {
        throw new Error(
            `${scenario.name}: geo→force diverged deriving the force-authored pre-trip state`,
        );
    }

    const { state, eid, sec } = buildForceSection(
        derived.points,
        derived.length,
        derived.ds,
        scenario.v0,
    );
    const h = createHistory();
    const before = docState(state, eid);

    const fitResult = await convertForce(h, state, sec);
    if (fitResult.outcome === "restored") {
        throw new Error(
            `${scenario.name}: the derived force section was NOT provenance-free (fit short-circuited) — the sweep's own construction is broken`,
        );
    }
    if (fitResult.outcome === "diverged" || fitResult.outcome === "dense") {
        throw new Error(
            `${scenario.name}: force→geo diverged deriving the reverse leg's landing (outcome "${fitResult.outcome}") — no landing to round-trip against`,
        );
    }
    state.step(0);

    const forceResult = await convertGeo(h, state, sec);
    state.step(0);
    if (forceResult.outcome !== "restored") {
        throw new Error(
            `${scenario.name}: force→geo→force did NOT restore (outcome "${forceResult.outcome}") — an untouched trip fell through to the solve`,
        );
    }

    const after = docState(state, eid);
    if (after.hash !== before.hash || JSON.stringify(after.snap) !== JSON.stringify(before.snap)) {
        throw new Error(
            `${scenario.name}: force→geo→force reported "restored" but the section content is NOT identical to the pre-trip state`,
        );
    }
    return { scenario: scenario.name, ms: performance.now() - t0 };
}
