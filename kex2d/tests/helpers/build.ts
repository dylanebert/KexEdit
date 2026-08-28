// Shared test authoring builder: every test that needs a fixture track
// authors it through `commands.ts`'s op vocabulary — the SAME dispatch layer the CLI
// and the UI (via `track.ts` setters inside `history` gestures) share — rather than
// poking `track.ts`'s raw entity-creation primitives (`createSection`, `addNode`,
// `createForcePoint`, …) directly. Two things a raw-ECS fixture still legitimately does,
// which this builder does too, because they aren't edits: `new State()` and
// `createTrack(ecs)` (the bare Track entity — the CLI's `new` verb bootstraps the same
// way, just via `TrackPlugin.initialize`'s richer default-section seed; a bare `createTrack`
// with zero sections is what most existing fixtures actually want, since they build their
// own section shape from there).
//
// A file testing `track.ts`'s setters or `commands.ts` itself directly (differential arms,
// structural-op arms) is testing THIS layer, not authoring through it — those stay on raw
// calls by design (`commands.test.ts`, `history.test.ts`, `ops.test.ts`, `track.test.ts`).

import { State } from "@dylanebert/shallot";
import { applyOp, type Op, type OpResult } from "../../src/commands";
import { createHistory, type History } from "../../src/history";
import type { Domain } from "../../src/section";
import { BakeSystem, createTrack, Handle, type SectionKind, trackEntity } from "../../src/track";

/** thrown when a builder convenience call's op is refused and the caller didn't opt into
 *  reading the refusal itself (`.op` for that) — a fixture author almost always wants a
 *  refused setup call to fail loud rather than silently build a track that isn't what the
 *  test thinks it is. */
export class BuildRefused extends Error {
    constructor(
        public readonly op: Op,
        public readonly result: OpResult,
    ) {
        super(`build: ${op.type} refused — ${JSON.stringify(result.refusals)}`);
    }
}

/** a headless fixture track, authored entirely through `applyOp` — one `history` instance,
 *  one `BakeSystem`-equipped `State`. Every convenience method applies one or more ops and
 *  returns the id a caller needs to keep authoring (a section id, a node's `Handle` eid, a
 *  force/strip/strip-keyframe/one-shot id) — the same stable ids `doc.ts` round-trips. */
export class Build {
    readonly ecs: State;
    readonly history: History;
    /** the most recent op's result — read after `.op()` for a refusal-tolerant call. */
    result: OpResult | undefined;

    constructor() {
        this.ecs = new State();
        this.history = createHistory();
        this.ecs.addSystem(BakeSystem);
        createTrack(this.ecs);
    }

    /** apply one op, recording the result; throws `BuildRefused` if it refused with nothing
     *  applied (a per-axis partial refusal, `applied: true` alongside a `refusals` entry,
     *  does NOT throw — that shape is itself part of what some tests assert). */
    op(op: Op): OpResult {
        this.result = applyOp(this.ecs, this.history, op);
        if (!this.result.applied && this.result.refusals.length > 0)
            throw new BuildRefused(op, this.result);
        return this.result;
    }

    /** the track entity id — `trackEntity` never returns null once `createTrack` ran in the
     *  constructor, so this narrows the nullable read every caller would otherwise repeat. */
    get trackEid(): number {
        const eid = trackEntity(this.ecs);
        if (eid === null) throw new Error("build: no track entity (unreachable post-constructor)");
        return eid;
    }

    /** run the bake so `bakeOut`/`samples`/`sectionInfo` reflect the authored state so far —
     *  every existing raw-ECS fixture's own `state.step(0)` call after building. */
    bake(): this {
        this.ecs.step(0);
        return this;
    }

    // ── sections ───────────────────────────────────────────────────────────────────────

    /** append a new section (geo's default two-node flat seed, or force's two-keyframe
     *  continuation seed) — `Timeline.svelte`'s own append gesture. */
    appendSection(kind: SectionKind): number {
        const id = this.op({ type: "append-section", kind }).id;
        if (id === undefined) throw new Error("build: append-section returned no id");
        return id;
    }

    deleteSection(section: number): void {
        this.op({ type: "delete-section", section });
    }

    convertSection(section: number): void {
        this.op({ type: "convert-section", section });
    }

    sectionLength(section: number, length: number): void {
        this.op({ type: "section-length", section, length });
    }

    // ── geo nodes ──────────────────────────────────────────────────────────────────────

    /** append one node at the section's tip, then place it at `(x, y)` — the compound every
     *  hand-authored `addNode(state, sec, x, y)` fixture call becomes: `node-add` has no
     *  position of its own (it seeds from the live heading, `extendTrack`'s doc), so the
     *  follow-up `node-move` is what pins the exact fixture coordinate a raw `addNode` call
     *  used to set directly. Returns the new node's `Handle` eid (order 0 is never reachable
     *  here — it always exists from section creation; use `moveNode` to reposition it, and
     *  even that refuses: node 0 is pinned at the local origin by design). */
    addNode(section: number, x: number, y: number): number {
        const eid = this.op({ type: "node-add", section }).id;
        if (eid === undefined) throw new Error("build: node-add returned no id");
        const order = Handle.order.get(eid);
        this.op({ type: "node-move", section, order, x, y });
        return eid;
    }

    /** reposition an existing node by its order (never 0 — pinned at the local origin). */
    moveNode(section: number, order: number, x: number, y: number): void {
        this.op({ type: "node-move", section, order, x, y });
    }

    deleteNode(section: number): void {
        this.op({ type: "node-delete", section });
    }

    // ── force points ───────────────────────────────────────────────────────────────────

    /** create a force keyframe at the given station/value directly — unlike a geo node,
     *  `force-create` takes `(s, g)` up front, so no follow-up move is needed. */
    addForce(section: number, s: number, g: number): number {
        const id = this.op({ type: "force-create", section, s, g }).id;
        if (id === undefined) throw new Error("build: force-create returned no id");
        return id;
    }

    moveForce(id: number, s: number, g: number): void {
        this.op({ type: "force-move", id, s, g });
    }

    deleteForces(ids: number[]): void {
        this.op({ type: "force-delete", ids });
    }

    // ── velocity strips ────────────────────────────────────────────────────────────────

    addStrip(start: number, end: number, value: number): number {
        const id = this.op({ type: "strip-create", start, end, value }).id;
        if (id === undefined) throw new Error("build: strip-create returned no id");
        return id;
    }

    moveStrip(id: number, start: number, end: number, value: number): void {
        this.op({ type: "strip-move", id, start, end, value });
    }

    addStripKeyframe(strip: number, s: number, v: number): number {
        const id = this.op({ type: "strip-keyframe-create", strip, s, v }).id;
        if (id === undefined) throw new Error("build: strip-keyframe-create returned no id");
        return id;
    }

    moveStripKeyframe(id: number, s: number, v: number): void {
        this.op({ type: "strip-keyframe-move", id, s, v });
    }

    deleteStripKeyframes(ids: number[]): void {
        this.op({ type: "strip-keyframe-delete", ids });
    }

    // ── track scalars ──────────────────────────────────────────────────────────────────

    /** create-or-move the track-start one-shot — `entrySpeed`'s own value — returns its id. */
    startSpeed(value: number): number {
        const id = this.op({ type: "start-speed", value }).id;
        if (id === undefined) throw new Error("build: start-speed returned no id");
        return id;
    }

    friction(value: number): void {
        this.op({ type: "friction", value });
    }

    resistance(value: number): void {
        this.op({ type: "resistance", value });
    }

    domain(value: Domain): void {
        this.op({ type: "domain", value });
    }
}

/** one new headless fixture, `BakeSystem`-equipped, with a bare `Track` entity and zero
 *  sections — the starting point every builder-authored fixture below builds up from. */
export function build(): Build {
    return new Build();
}
