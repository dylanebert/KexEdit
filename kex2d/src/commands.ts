/** the headless command layer: a typed op vocabulary dispatching to the
 *  SAME `track.ts` setters the UI drives, inside the SAME `history` gestures (`loadDocument` →
 *  ops → `saveDocument`) — the one dispatch layer the CLI (`cli.ts`) and the test suite's shared
 *  authoring builder (`tests/helpers/build.ts`) both drive. `applyOp` never opens a second write
 *  path: every branch below either calls a `history.ts` wrapper verbatim or reproduces one
 *  gesture the UI itself performs (`begin*`/write/`commit`).
 *
 *  **Refusals are structural, not thrown.** A guard is read BEFORE the write, from the same
 *  exported predicate the setter itself calls, so a refusal names the violated guard and a
 *  runnable remedy rather than throwing — per the spec's Locked decision. */

import type { State } from "@dylanebert/shallot";
import {
    addRecord,
    beginBody,
    beginEnd,
    beginFriction,
    beginHandle,
    beginResistance,
    beginV0,
    commit,
    type History,
    landDomain,
    removeRecord,
    setEase,
    setOrder,
} from "./history";
import { Lane } from "./lanes";
import type { Easing } from "./profile";
import type { Domain } from "./section";
import {
    setEnd,
    setRecordHandle,
    setRecordSpan,
    setTrackFriction,
    setTrackResistance,
    setV0,
    trackEntity,
    validCoefficient,
} from "./track";

/** one violated setter guard: the guard's own name (stable across callers — the CLI's JSON
 *  error surface and the differential/refusal tests both key on it) plus a human-readable
 *  remedy. Naming mirrors the guard predicate it reads (`segmentOverlapped` ⇒ `lanes`'s own
 *  law), so a reader can grep straight to the source of truth. */
export interface Refusal {
    guard: string;
    message: string;
}

/** the outcome of one op: whether the live document changed at all, every guard that fired
 *  (possibly alongside `applied: true` for a per-axis refusal), and the new entity's stable id
 *  for a create op. */
export interface OpResult {
    applied: boolean;
    refusals: Refusal[];
    id?: number;
}

function ok(id?: number): OpResult {
    return { applied: true, refusals: [], id };
}

function refused(guard: string, message: string): OpResult {
    return { applied: false, refusals: [{ guard, message }] };
}

// ── the authoring verbs ─────────────────────────────────────────────────────────────────────
//
// Three track-level writes plus the lane vocabulary S2e-ii declares over the S2e-i setters. A
// record is addressed by its STABLE ID everywhere except `record-add`, which has no record yet
// and so carries the `lane` the new record joins; the id is lane-independent by construction
// (ids are unique across the whole document), so no other op needs one.

/** the lane names the wire and this vocabulary speak — the `lanes.*` keys of the v4 document,
 *  so a CLI user reads a `dump` and writes an op in the same words. */
export type LaneName = "velocity" | "force" | "geo";

const LANES: Record<LaneName, Lane> = {
    velocity: Lane.Velocity,
    force: Lane.Force,
    geo: Lane.Geo,
};

function laneOf(name: unknown): Lane | undefined {
    return typeof name === "string" ? LANES[name as LaneName] : undefined;
}

export interface RecordAddOp {
    type: "record-add";
    lane: LaneName;
    start: number;
    end: number;
    ease?: number;
    /** omitted leaves the record's entry UNOWNED — the entry law resolves it. */
    entry?: number;
    exit: number;
}

export interface RecordDeleteOp {
    type: "record-delete";
    id: number;
}

export interface RecordSpanOp {
    type: "record-span";
    id: number;
    start: number;
    end: number;
}

export interface RecordHandleOp {
    type: "record-handle";
    id: number;
    which: "entry" | "exit";
    /** omitted DISOWNS an entry handle (never an exit, which a record always owns). */
    value?: number;
}

export interface RecordEaseOp {
    type: "record-ease";
    id: number;
    ease: number;
}

export interface EndOp {
    type: "end";
    /** 0 unpins: the end follows the longest lane's last exit. */
    value: number;
}

export interface OrderOp {
    type: "order";
    value: LaneName[];
}

export interface StartSpeedOp {
    type: "start-speed";
    value: number;
}

export interface FrictionOp {
    type: "friction";
    value: number;
}

export interface ResistanceOp {
    type: "resistance";
    value: number;
}

export interface DomainOp {
    type: "domain";
    value: Domain;
}

export type Op =
    | RecordAddOp
    | RecordDeleteOp
    | RecordSpanOp
    | RecordHandleOp
    | RecordEaseOp
    | EndOp
    | OrderOp
    | StartSpeedOp
    | FrictionOp
    | ResistanceOp
    | DomainOp;

/** the op layer's own shape guard. Every setter refusal below is the SETTER's — this one covers
 *  what a setter never sees, an op whose field is missing or is not a number at all (the CLI
 *  parses arbitrary JSON, so `{"type": "end"}` reaches `applyOp` as a live op). */
function finite(...values: unknown[]): boolean {
    return values.every((v) => typeof v === "number" && Number.isFinite(v));
}

function opShape(message: string): OpResult {
    return refused("opFieldInvalid", message);
}

/** the setters' `LaneWrite`/`LaneRefusal[]` outcomes as one `OpResult`. */
function fromWrite(write: { id: number | null; refusals: Refusal[] }): OpResult {
    return write.id === null
        ? { applied: false, refusals: write.refusals }
        : { applied: true, refusals: [], id: write.id };
}

function fromRefusals(refusals: Refusal[]): OpResult {
    return refusals.length > 0 ? { applied: false, refusals } : ok();
}

/** Dispatch one authored operation through the canonical command surface. */
export function applyOp(ecs: State, h: History, op: Op): OpResult {
    switch (op.type) {
        // ── lane records ────────────────────────────────────────────────────────────────
        case "record-add": {
            const lane = laneOf(op.lane);
            if (lane === undefined)
                return opShape(`record-add's lane must be one of ${Object.keys(LANES).join(", ")}`);
            if (!finite(op.start, op.end, op.exit))
                return opShape("record-add needs finite start, end and exit");
            if (op.entry !== undefined && !finite(op.entry))
                return opShape("record-add's entry must be a finite number when present");
            if (op.ease !== undefined && !finite(op.ease))
                return opShape("record-add's ease must be a finite number when present");
            return fromWrite(
                addRecord(h, ecs, lane, {
                    start: op.start,
                    end: op.end,
                    ease: (op.ease ?? 0) as Easing,
                    ...(op.entry === undefined ? {} : { entry: op.entry }),
                    exit: op.exit,
                }),
            );
        }

        case "record-delete": {
            if (!finite(op.id)) return opShape("record-delete needs a finite id");
            if (!removeRecord(h, ecs, op.id))
                return refused("recordNotFound", `no record ${op.id}`);
            return ok(op.id);
        }

        // a span edit is the timeline's body drag performed headlessly: the same
        // `beginBody`/setter/`commit` bracket, so one op is one undo entry.
        case "record-span": {
            if (!finite(op.id, op.start, op.end))
                return opShape("record-span needs a finite id, start and end");
            beginBody(ecs, op.id);
            const write = setRecordSpan(ecs, op.id, op.start, op.end);
            commit(h);
            return fromWrite(write);
        }

        case "record-handle": {
            if (!finite(op.id)) return opShape("record-handle needs a finite id");
            if (op.which !== "entry" && op.which !== "exit")
                return opShape('record-handle\'s which must be "entry" or "exit"');
            if (op.value !== undefined && !finite(op.value))
                return opShape("record-handle's value must be a finite number when present");
            beginHandle(ecs, op.id, op.which);
            const write = setRecordHandle(ecs, op.id, op.which, op.value);
            commit(h);
            return fromWrite(write);
        }

        case "record-ease": {
            if (!finite(op.id, op.ease)) return opShape("record-ease needs a finite id and ease");
            return fromWrite(setEase(h, ecs, op.id, op.ease as Easing));
        }

        // ── track-level columns ─────────────────────────────────────────────────────────
        case "end": {
            if (!finite(op.value)) return opShape("end needs a finite value");
            if (trackEntity(ecs) === null) return refused("trackNotFound", "no track exists");
            beginEnd(ecs);
            const refusals = setEnd(ecs, op.value);
            commit(h);
            return fromRefusals(refusals);
        }

        case "order": {
            if (!Array.isArray(op.value) || op.value.some((n) => laneOf(n) === undefined))
                return opShape(
                    `order's value must be lane names from ${Object.keys(LANES).join(", ")}`,
                );
            if (trackEntity(ecs) === null) return refused("trackNotFound", "no track exists");
            return fromRefusals(
                setOrder(
                    h,
                    ecs,
                    op.value.map((n) => LANES[n]),
                ),
            );
        }

        case "start-speed": {
            if (!finite(op.value)) return opShape("start-speed needs a finite value");
            if (trackEntity(ecs) === null) return refused("trackNotFound", "no track exists");
            beginV0(ecs);
            const refusals = setV0(ecs, op.value);
            commit(h);
            return fromRefusals(refusals);
        }

        case "friction": {
            if (!validCoefficient(op.value))
                return refused(
                    "validCoefficient",
                    "friction must be a finite, non-negative number",
                );
            const trackEid = trackEntity(ecs);
            if (trackEid === null) return refused("trackNotFound", "no track exists");
            beginFriction(trackEid);
            setTrackFriction(trackEid, op.value);
            commit(h);
            return ok();
        }

        case "resistance": {
            if (!validCoefficient(op.value))
                return refused(
                    "validCoefficient",
                    "resistance must be a finite, non-negative number",
                );
            const trackEid = trackEntity(ecs);
            if (trackEid === null) return refused("trackNotFound", "no track exists");
            beginResistance(trackEid);
            setTrackResistance(trackEid, op.value);
            commit(h);
            return ok();
        }

        // `landDomain` (`history.ts`) writes exactly the one `Track.domain` column and records
        // it directly — no gesture lifecycle (a domain flip is a single one-shot write, never a
        // drag), and no guard: every `Domain` value is valid.
        case "domain": {
            if (trackEntity(ecs) === null) return refused("trackNotFound", "no track exists");
            landDomain(h, ecs, op.value);
            return ok();
        }

        default: {
            const _exhaustive: never = op;
            throw new Error(`commands.applyOp: unhandled op ${JSON.stringify(_exhaustive)}`);
        }
    }
}
