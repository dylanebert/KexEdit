/** the headless command layer (spec `kex2d-cli` S2): a typed op vocabulary dispatching to the
 *  SAME `track.ts` setters the UI drives, inside the SAME `history` gestures (`loadDocument` →
 *  ops → `saveDocument`) — the one dispatch layer the CLI (S3) and the migrated test suite (S6)
 *  will share. `applyOp` never opens a second write path: every branch below either calls a
 *  `history.ts` wrapper verbatim or reproduces one gesture the UI itself performs
 *  (`begin*`/write/`commit`), documented per op against the exact call site it mirrors.
 *
 *  **Refusals are structural, not thrown.** A setter guard (an overlap, a station collision, a
 *  floor) is read BEFORE the write — from the same exported predicate the setter itself calls
 *  (`stripOverlapped`, `stationTaken`, …) — so a refusal names the violated guard and a runnable
 *  remedy, per the spec's Locked decision (Anthropic tool-design guidance: refusals as structured
 *  error objects, not a second validation layer bolted in front of a setter that already refuses
 *  well). A guard hit does not always mean nothing was written: several setters refuse PER AXIS
 *  (`setForcePoint` refuses `s` alone, keeping `g`; `setStrip` refuses position independent of
 *  value) — `applied` reports whether the live document changed at all, `refusals` is never
 *  empty-implies-`applied: false` for those ops. */

import type { State } from "@dylanebert/shallot";
import {
    addOneShot,
    addStrip,
    addStripKeyframe,
    appendSection as appendSectionH,
    beginForceMove,
    beginFriction,
    beginLength,
    beginMove,
    beginOneShotMove,
    beginResistance,
    beginStripKeyframeMove,
    beginStripMove,
    commit,
    convertSection as convertSectionH,
    createForce,
    deleteForces,
    deleteStripKeyframes,
    extendTrack,
    type History,
    landDomain,
    removeSection as removeSectionH,
    setForcesEase,
    trimTrack,
} from "./history";
import type { Easing } from "./profile";
import type { Domain } from "./section";
import {
    entryOneShot,
    Force,
    forceAt,
    forcePointState,
    Handle,
    handleAt,
    lastHandle,
    nextForce,
    reheadOnDrag,
    type SectionKind,
    sectionAt,
    sectionHandles,
    sections,
    setForcePoint,
    setOneShotValue,
    setSectionLength,
    setStrip,
    setStripKeyframe,
    setTrackFriction,
    setTrackResistance,
    stationTaken,
    stripAt,
    stripCoversOneEdge,
    StripKeyframe,
    stripKeyframeAt,
    stripKeyframeTaken,
    stripOverlapped,
    trackEditable,
    trackEntity,
    validCoefficient,
    validStripValue,
} from "./track";

/** one violated setter guard: the guard's own name (stable across callers — the CLI's JSON
 *  error surface and the differential/refusal tests both key on it) plus a human-readable
 *  remedy. Naming mirrors the guard predicate/docblock it reads (`stripOverlapped` ⇒ the
 *  `track.stripOverlapped` guard), so a reader can grep straight to the source of truth. */
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

// ── sections ───────────────────────────────────────────────────────────────────────────

export interface AppendSectionOp {
    type: "append-section";
    kind: SectionKind;
}

export interface DeleteSectionOp {
    type: "delete-section";
    section: number;
}

export interface ConvertSectionOp {
    type: "convert-section";
    section: number;
}

// ── geo nodes ──────────────────────────────────────────────────────────────────────────

export interface NodeAddOp {
    type: "node-add";
    section: number;
}

export interface NodeMoveOp {
    type: "node-move";
    section: number;
    order: number;
    x: number;
    y: number;
}

export interface NodeDeleteOp {
    type: "node-delete";
    section: number;
}

// ── force points ───────────────────────────────────────────────────────────────────────

export interface ForceCreateOp {
    type: "force-create";
    section: number;
    s: number;
    g: number;
}

export interface ForceMoveOp {
    type: "force-move";
    id: number;
    s: number;
    g: number;
}

export interface ForceDeleteOp {
    type: "force-delete";
    ids: number[];
}

export interface ForceEaseOp {
    type: "force-ease";
    ids: number[];
    ease: Easing;
}

// ── velocity strips ────────────────────────────────────────────────────────────────────

export interface StripCreateOp {
    type: "strip-create";
    start: number;
    end: number;
    value: number;
}

export interface StripMoveOp {
    type: "strip-move";
    id: number;
    start: number;
    end: number;
    value: number;
}

export interface StripKeyframeCreateOp {
    type: "strip-keyframe-create";
    strip: number;
    s: number;
    v: number;
}

export interface StripKeyframeMoveOp {
    type: "strip-keyframe-move";
    id: number;
    s: number;
    v: number;
}

export interface StripKeyframeDeleteOp {
    type: "strip-keyframe-delete";
    ids: number[];
}

// ── track scalars ──────────────────────────────────────────────────────────────────────

export interface SectionLengthOp {
    type: "section-length";
    section: number;
    length: number;
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
    | AppendSectionOp
    | DeleteSectionOp
    | ConvertSectionOp
    | NodeAddOp
    | NodeMoveOp
    | NodeDeleteOp
    | ForceCreateOp
    | ForceMoveOp
    | ForceDeleteOp
    | ForceEaseOp
    | StripCreateOp
    | StripMoveOp
    | StripKeyframeCreateOp
    | StripKeyframeMoveOp
    | StripKeyframeDeleteOp
    | SectionLengthOp
    | StartSpeedOp
    | FrictionOp
    | ResistanceOp
    | DomainOp;

/** apply one op to `ecs`, recording through `h` — the one dispatcher every op family routes
 *  through. every branch below cites the exact UI call site it reproduces, so a diff to either
 *  side is a diff a reviewer can compare directly. */
export function applyOp(ecs: State, h: History, op: Op): OpResult {
    switch (op.type) {
        // `Timeline.svelte:2671`: `selectSection(appendSection(history, ecs, kind))`.
        case "append-section": {
            const id = appendSectionH(h, ecs, op.kind);
            return ok(id);
        }

        // `deleteSection` (`track.ts`) refuses at two independent points — an unknown section,
        // or the last-section floor — indistinguishable from its own `false` return, so both
        // are read here first (`sectionAt`/`sections`) to name the guard that actually fired.
        case "delete-section": {
            if (sectionAt(ecs, op.section) === null)
                return refused("sectionNotFound", `no section with id ${op.section}`);
            if (sections(ecs).length <= 1)
                return refused(
                    "lastSection",
                    "refusing to delete the track's only remaining section",
                );
            removeSectionH(h, ecs, op.section);
            return ok();
        }

        case "convert-section": {
            if (sectionAt(ecs, op.section) === null)
                return refused("sectionNotFound", `no section with id ${op.section}`);
            convertSectionH(h, ecs, op.section);
            return ok();
        }

        // `extendTrack` — the append-at-tip gesture (`history.ts`'s own doc: "the new node
        // takes its heading from the old tip's exit").
        case "node-add": {
            if (sectionAt(ecs, op.section) === null)
                return refused("sectionNotFound", `no section with id ${op.section}`);
            const eid = extendTrack(h, ecs, op.section);
            return ok(eid);
        }

        // `controls.ts:1184`/`1218`/`1534`/`1560`: `beginMove(ecs, section)` opens the gesture,
        // the live pointer-move writes `Handle.pos.set` directly, and only the TIP re-heads
        // (`controls.ts:1538`: `Handle.pos.set(...); reheadOnDrag(ecs, eid);` — the interior
        // branch at `:1561` never calls it). node 0's position is pinned at the section's local
        // origin (`main.ts:209`'s `nudge`'s own no-op comment) — refused here rather than let a
        // silent write through.
        case "node-move": {
            const eid = handleAt(ecs, op.section, op.order);
            if (eid === null)
                return refused(
                    "nodeNotFound",
                    `no node at order ${op.order} on section ${op.section}`,
                );
            if (op.order === 0)
                return refused(
                    "nodeZeroLocked",
                    "node 0 is pinned at the section's local origin and cannot move",
                );
            const before = Handle.pos.x.get(eid);
            const beforeY = Handle.pos.y.get(eid);
            beginMove(ecs, op.section);
            Handle.pos.set(eid, op.x, op.y);
            if (eid === lastHandle(ecs, op.section)) reheadOnDrag(ecs, eid);
            commit(h);
            const moved = Handle.pos.x.get(eid) !== before || Handle.pos.y.get(eid) !== beforeY;
            return { applied: moved, refusals: [] };
        }

        // `trimTrack` refuses below the two-node floor OR when the section is gone
        // (`removeTrailingHandle`'s own `lastHandle === null` branch) — read apart the same way
        // `delete-section` reads its two-branch refusal apart.
        case "node-delete": {
            if (sectionAt(ecs, op.section) === null)
                return refused("sectionNotFound", `no section with id ${op.section}`);
            if (sectionHandles(ecs, op.section).length <= 2)
                return refused(
                    "minNodeFloor",
                    "a geo section needs at least two nodes (node 0 + one shape node)",
                );
            trimTrack(h, ecs, op.section);
            return ok();
        }

        // `Timeline.svelte:1486`: `createForce(history, ecs, c.id, s, sampleForce(...))` — no
        // setter guard of its own (`createForcePoint` writes unconditionally); the command layer
        // adds the existence check the UI gets for free by only ever offering a live section.
        case "force-create": {
            if (sectionAt(ecs, op.section) === null)
                return refused("sectionNotFound", `no section with id ${op.section}`);
            const id = createForce(h, ecs, op.section, op.s, op.g);
            return ok(id);
        }

        // `Timeline.svelte:3302`-`3303`: `beginForceMove(ecs, p.id); setForcePoint(ecs, p.id,
        // s, v);` then a later `commit(history)`. `setForcePoint` refuses the `s` write alone
        // when `stationTaken` (`track.ts:2122`), landing `g` regardless — read the guard first
        // so a refusal is named even though the write still (partially) applies.
        case "force-move": {
            const eid = forceAt(ecs, op.id);
            if (eid === null) return refused("forceNotFound", `no force point with id ${op.id}`);
            // `Force.section` isn't exported as a bare read helper — `track.ts`'s own
            // `setForcePoint` reads it the same way (`Force.section.get(eid)`), mirrored here
            // rather than widening `track.ts`'s export surface for one field read.
            const section = Force.section.get(eid);
            const refusals: Refusal[] = [];
            if (stationTaken(ecs, section, op.s, op.id))
                refusals.push({
                    guard: "stationTaken",
                    message: `station ${op.s} is already held by another force point on this section; g still lands`,
                });
            beginForceMove(ecs, op.id);
            setForcePoint(ecs, op.id, op.s, op.g);
            commit(h);
            return { applied: true, refusals };
        }

        // `Timeline.svelte:2560`: `deleteStrips` — this op's force-point twin, `deleteForces`.
        case "force-delete": {
            const found = op.ids.some((id) => forcePointState(ecs, id) !== undefined);
            if (!found) return refused("notFound", "none of the given force-point ids exist");
            deleteForces(h, ecs, op.ids);
            return ok();
        }

        // `setForcesEase` (`history.ts`) skips a terminal keyframe (governs no following
        // segment) silently — read that guard first per id so a refusal names it.
        case "force-ease": {
            const refusals: Refusal[] = [];
            for (const id of op.ids) {
                if (forceAt(ecs, id) === null) {
                    refusals.push({
                        guard: "forceNotFound",
                        message: `no force point with id ${id}`,
                    });
                    continue;
                }
                if (nextForce(ecs, id) === null)
                    refusals.push({
                        guard: "terminalKeyframe",
                        message: `force point ${id} governs no following segment; its easing cannot be set`,
                    });
            }
            setForcesEase(h, ecs, op.ids, op.ease);
            return { applied: true, refusals };
        }

        // `Timeline.svelte:3274`: `addStrip(history, ecs, extent.start, extent.end, value)` —
        // `track.createStrip` itself reads all three guards before writing anything, so a
        // pre-check mirrors it exactly (`addStrip` returns null on any one of them).
        case "strip-create": {
            const refusals: Refusal[] = [];
            if (stripOverlapped(ecs, op.start, op.end, -1))
                refusals.push({
                    guard: "stripOverlapped",
                    message: `[${op.start}, ${op.end}) overlaps an existing velocity strip`,
                });
            else if (!stripCoversOneEdge(ecs, op.start, op.end))
                refusals.push({
                    guard: "minExtentFloor",
                    message: `[${op.start}, ${op.end}) covers no edge of the current bake`,
                });
            if (!validStripValue(op.value))
                refusals.push({
                    guard: "validStripValue",
                    message: "strip value must be finite and strictly positive",
                });
            const id = addStrip(h, ecs, op.start, op.end, op.value);
            if (id === null) return { applied: false, refusals };
            return { applied: true, refusals: [], id };
        }

        // `Timeline.svelte:3110`-`3115`: `beginStripMove(ecs, s.id)` then `setStrip(ecs, id,
        // start, end, value)`. `setStrip` refuses the span write under `stripOverlapped ||
        // !stripCoversOneEdge` (one combined condition, `track.ts:746`) and the value write
        // under `!validStripValue` independently — read both the same way.
        case "strip-move": {
            if (stripAt(ecs, op.id) === null)
                return refused("stripNotFound", `no strip with id ${op.id}`);
            const refusals: Refusal[] = [];
            if (stripOverlapped(ecs, op.start, op.end, op.id))
                refusals.push({
                    guard: "stripOverlapped",
                    message: `[${op.start}, ${op.end}) overlaps an existing velocity strip; start/end unchanged`,
                });
            else if (!stripCoversOneEdge(ecs, op.start, op.end))
                refusals.push({
                    guard: "minExtentFloor",
                    message: `[${op.start}, ${op.end}) covers no edge of the current bake; start/end unchanged`,
                });
            if (!validStripValue(op.value))
                refusals.push({
                    guard: "validStripValue",
                    message: "strip value must be finite and strictly positive; value unchanged",
                });
            beginStripMove(ecs, op.id);
            setStrip(ecs, op.id, op.start, op.end, op.value);
            commit(h);
            return { applied: true, refusals };
        }

        // `Timeline.svelte:1457`: `addStripKeyframe(history, ecs, st.id, d, ...)`.
        // `createStripKeyframe` clamps `s` into the strip's extent rather than refusing
        // (`track.ts:855`) — a clamp, not a guard, so it's not reported as a refusal.
        case "strip-keyframe-create": {
            if (stripAt(ecs, op.strip) === null)
                return refused("stripNotFound", `no strip with id ${op.strip}`);
            const id = addStripKeyframe(h, ecs, op.strip, op.s, op.v);
            return ok(id);
        }

        // `Timeline.svelte:3308`-`3309`: `beginStripKeyframeMove(ecs, k.id)` then
        // `setStripKeyframe(ecs, k.id, s, v)`. `setStripKeyframe` refuses `s` alone under
        // `stripKeyframeTaken`, landing `v` regardless (`track.ts:984`'s own mirror of
        // `setForcePoint`).
        case "strip-keyframe-move": {
            const eid = stripKeyframeAt(ecs, op.id);
            if (eid === null)
                return refused("stripKeyframeNotFound", `no strip keyframe with id ${op.id}`);
            const stripId = StripKeyframe.strip.get(eid);
            const refusals: Refusal[] = [];
            if (stripKeyframeTaken(ecs, stripId, op.s, op.id))
                refusals.push({
                    guard: "stripKeyframeTaken",
                    message: `station ${op.s} is already held by another keyframe on this strip; v still lands`,
                });
            beginStripKeyframeMove(ecs, op.id);
            setStripKeyframe(ecs, op.id, op.s, op.v);
            commit(h);
            return { applied: true, refusals };
        }

        case "strip-keyframe-delete": {
            const found = op.ids.some((id) => stripKeyframeAt(ecs, id) !== null);
            if (!found) return refused("notFound", "none of the given strip-keyframe ids exist");
            deleteStripKeyframes(h, ecs, op.ids);
            return ok();
        }

        // `Timeline.svelte:2857`/`2890`: `beginLength(ecs, c.id)` then a live
        // `setSectionLength` write, `commitLength` on release. `commitLength`'s `armed` branch
        // also updates the session's sticky append default (`setStickyLen`) — UI session state,
        // not part of the document, so the command layer commits bare (`commit`, not
        // `commitLength`) rather than mutate that global for an op that never asked for it.
        // `setSectionLength` floors silently at `minForceExtent` (a clamp, like the strip-
        // keyframe clamp above) — not reported as a refusal.
        case "section-length": {
            if (sectionAt(ecs, op.section) === null)
                return refused("sectionNotFound", `no section with id ${op.section}`);
            beginLength(ecs, op.section);
            setSectionLength(ecs, op.section, op.length);
            commit(h);
            return ok();
        }

        // `Timeline.svelte:3344`-`3345` (drag) / `:3280` (`addOneShot(history, ecs, V0)` on
        // create): the one-shot's value is moved when it exists, created when it doesn't —
        // `entryOneShot`'s own "first hit wins" reading is what `addOneShot` never re-checks
        // (a real UI gesture only offers create when none exists).
        case "start-speed": {
            const os = entryOneShot(ecs);
            if (os) {
                beginOneShotMove(ecs, os.id);
                setOneShotValue(ecs, os.id, op.value);
                commit(h);
                return ok(os.id);
            }
            const id = addOneShot(h, ecs, op.value);
            return ok(id);
        }

        // `App.svelte:1174`/`1203`: `beginFriction(te)` then `setTrackFriction(te, val)` — the
        // field itself checks `validCoefficient` before ever calling the setter
        // (`track.ts:2296`'s own docblock: "the field's own refusal"), so an invalid value never
        // reaches `setTrackFriction` here either. `trackEditable` (the in-mode lockdown) is the
        // setter's OWN belt-and-suspenders guard (`track.ts:2311`) — named separately since a
        // valid coefficient can still be refused by it.
        case "friction": {
            if (!validCoefficient(op.value))
                return refused(
                    "validCoefficient",
                    "friction must be a finite, non-negative number",
                );
            const trackEid = trackEntity(ecs);
            if (trackEid === null) return refused("trackNotFound", "no track exists");
            if (!trackEditable())
                return refused("trackEditable", "the track is locked while a pin session is open");
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
            if (!trackEditable())
                return refused("trackEditable", "the track is locked while a pin session is open");
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
