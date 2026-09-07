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
import { beginFriction, beginResistance, commit, type History, landDomain } from "./history";
import type { Domain } from "./section";
import {
    setTrackFriction,
    setTrackResistance,
    trackEditable,
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

// ── the surviving authoring verbs ───────────────────────────────────────────────────────────
//
// S2e-i cut the store over to lanes and deleted every verb that addressed the retired node,
// force-point, strip and one-shot entities. What survives is the three track-level writes that
// never went through them; S2e-ii re-declares the lane verbs (record ops carrying a `lane`
// field, plus `end`, `order` and `start-speed`) over the S2e-i setters.

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

export type Op = FrictionOp | ResistanceOp | DomainOp;

/** Dispatch one authored operation through the canonical command surface. */
export function applyOp(ecs: State, h: History, op: Op): OpResult {
    switch (op.type) {
        case "friction": {
            if (!validCoefficient(op.value))
                return refused(
                    "validCoefficient",
                    "friction must be a finite, non-negative number",
                );
            const trackEid = trackEntity(ecs);
            if (trackEid === null) return refused("trackNotFound", "no track exists");
            if (!trackEditable()) return refused("trackEditable", "the track is not editable");
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
            if (!trackEditable()) return refused("trackEditable", "the track is not editable");
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
