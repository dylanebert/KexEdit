// Shared test authoring builder: every test that needs a fixture track authors it through the
// S2e-i lane setters — the ONLY authored writers — rather than assembling ECS rows by hand. Two
// things a fixture still legitimately does, which this builder does too, because they aren't
// edits: `new State()` and `createTrack(ecs)` (the bare Track entity, no records).
//
// Every verb goes through `commands.applyOp`, because that dispatch layer is what the CLI drives
// and what `history.ts`'s gestures sit under — so a fixture is authored the way a person authors
// one, and a builder call that stopped matching the op vocabulary fails loud here rather than
// quietly authoring through a path no caller has.

import { State } from "@dylanebert/shallot";
import { applyOp, type Op, type OpResult } from "../../src/commands";
import { createHistory, type History } from "../../src/history";
import type { Domain } from "../../src/section";
import { Lane, type LaneSegment } from "../../src/lanes";
import type { Easing } from "../../src/profile";
import { BakeSystem, createTrack, trackEntity } from "../../src/track";

/** the op vocabulary's own lane names, so a builder call reads as the op it applies. */
const LANE_NAMES = {
    [Lane.Velocity]: "velocity",
    [Lane.Force]: "force",
    [Lane.Geo]: "geo",
} as const;

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
 *  returns the stable record id `doc.ts` round-trips. */
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

    /** run the bake so `bakeOut`/`samples`/`runInfo` reflect the authored state so far —
     *  every existing raw-ECS fixture's own `state.step(0)` call after building. */
    bake(): this {
        this.ecs.step(0);
        return this;
    }

    // ── lane records ───────────────────────────────────────────────────────────────────

    /** author one record in `lane`, throwing on a refusal — a fixture author almost always
     *  wants a refused setup call to fail loud rather than silently build a track that isn't
     *  what the test thinks it is. Returns the record's stable id. */
    record(lane: Lane, row: Omit<LaneSegment, "id">): number {
        const result = this.op({
            type: "record-add",
            lane: LANE_NAMES[lane],
            start: row.start,
            end: row.end,
            ease: row.ease,
            ...(row.entry === undefined ? {} : { entry: row.entry }),
            exit: row.exit,
        });
        if (result.id === undefined) throw new Error("build: record-add applied without an id");
        return result.id;
    }

    /** a force record over `[start, end)`, owning both handles. */
    force(
        start: number,
        end: number,
        entry: number,
        exit = entry,
        ease: Easing = 0 as Easing,
    ): number {
        return this.record(Lane.Force, { start, end, ease, entry, exit });
    }

    /** a geo (pitch) record over `[start, end)`, handles in radians. */
    geo(
        start: number,
        end: number,
        entry: number,
        exit: number,
        ease: Easing = 0 as Easing,
    ): number {
        return this.record(Lane.Geo, { start, end, ease, entry, exit });
    }

    /** a velocity record over `[start, end)`, handles in m/s. */
    velocity(
        start: number,
        end: number,
        entry: number,
        exit = entry,
        ease: Easing = 0 as Easing,
    ): number {
        return this.record(Lane.Velocity, { start, end, ease, entry, exit });
    }

    span(id: number, start: number, end: number): void {
        this.op({ type: "record-span", id, start, end });
    }

    handle(id: number, which: "entry" | "exit", value: number | undefined): void {
        this.op({ type: "record-handle", id, which, ...(value === undefined ? {} : { value }) });
    }

    ease(id: number, ease: Easing): void {
        this.op({ type: "record-ease", id, ease });
    }

    remove(id: number): void {
        this.op({ type: "record-delete", id });
    }

    // ── track scalars ──────────────────────────────────────────────────────────────────

    /** pin (or unpin, with 0) the track end. */
    end(value: number): void {
        this.op({ type: "end", value });
    }

    /** write the lane priority, top to bottom. */
    order(value: readonly Lane[]): void {
        this.op({ type: "order", value: value.map((lane) => LANE_NAMES[lane]) });
    }

    /** the authored start speed (m/s). */
    startSpeed(value: number): void {
        this.op({ type: "start-speed", value });
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

/** one new headless fixture, `BakeSystem`-equipped, with a bare `Track` entity and no records —
 *  the starting point every builder-authored fixture builds up from. */
export function build(): Build {
    return new Build();
}
