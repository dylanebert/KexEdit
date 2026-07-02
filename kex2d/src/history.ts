/** undo/redo substrate for the whole editor, mirroring the shallot editor's
 *  command model (`shallot/.../editor/document/index.ts`): opaque `apply`/`reverse`
 *  commands on a dual stack, plus a `begin`/`commit`/`cancel` gesture lifecycle so
 *  one drag collapses to a single entry.
 *
 *  the substrate is domain-agnostic — a `Command` is just a do/undo pair. today the
 *  track nodes (`track.ts`, ECS `Handle` entities, addressed by stable `order` — the
 *  append/delete-trailing chain never changes an interior node's order, so order
 *  survives eid recycling across a delete→undo) are the only surface recording onto
 *  it. do-paths mutate the live data (the re-bake is instant via the bake `hash`
 *  gate) and record an already-applied command; only undo/redo replay through
 *  apply/reverse. */

import {
    addPin,
    addPosPin,
    Pin,
    pinAt,
    PosPin,
    posPinAt,
    spawnPin,
    spawnPosPin,
} from "./constraints";
import {
    extend,
    Handle,
    handleAt,
    lastHandle,
    type NodeState,
    nodeSnapshot,
    removeTrailingHandle,
    restoreNodes,
    spawnNode,
} from "./track";
import type { State } from "@dylanebert/shallot";

/** a do/undo pair. `apply` is the do / redo direction, `reverse` is undo. both
 *  mutate the canonical data directly (there's no runtime mirror to sync). */
export interface Command {
    apply(): void;
    reverse(): void;
}

export interface History {
    undo: Command[];
    redo: Command[];
}

const MAX_UNDO = 256;

export function createHistory(): History {
    return { undo: [], redo: [] };
}

/** the app's single history. tests build their own via `createHistory`. */
export const history = createHistory();

/** push an already-applied command (the do-path mutated live data first).
 *  exported for composed commands (the relax verb); gestures and the
 *  domain helpers below are the usual entry. */
export function record(h: History, cmd: Command): void {
    h.undo.push(cmd);
    if (h.undo.length > MAX_UNDO) h.undo.shift();
    h.redo.length = 0; // a new edit invalidates the redo branch
}

export function undo(h: History): void {
    const cmd = h.undo.pop();
    if (!cmd) return;
    cmd.reverse();
    h.redo.push(cmd);
}

export function redo(h: History): void {
    const cmd = h.redo.pop();
    if (!cmd) return;
    cmd.apply();
    h.undo.push(cmd);
}

// ── gesture lifecycle: a drag (or a live inline edit) writes the canonical data
// every frame for instant preview, then commits one coalesced command. one gesture
// is open at a time (a node drag and a pin drag are mutually exclusive input
// surfaces). parameterized by snapshot/restore/equality closures so any domain —
// a pin's state, the node chain's pose — plugs into the same lifecycle.
let gesture: {
    snap: () => unknown;
    restore: (s: unknown) => void;
    same: (a: unknown, b: unknown) => boolean;
    prev: unknown;
} | null = null;

/** open a gesture, deep-capturing the pristine pre-gesture state. `snap` returning
 *  `undefined` (the target is gone) opens nothing. */
export function begin<S>(
    snap: () => S | undefined,
    restore: (s: S) => void,
    same: (a: S, b: S) => boolean,
): void {
    const prev = snap();
    if (prev === undefined) return;
    gesture = {
        snap: snap as () => unknown,
        restore: restore as (s: unknown) => void,
        same: same as (a: unknown, b: unknown) => boolean,
        prev,
    };
}

/** commit the open gesture: record one command (restore prev ↔ restore next) if the
 *  state changed. the live writes already applied `next`. */
export function commit(h: History): void {
    const g = gesture;
    gesture = null;
    if (!g) return;
    const next = g.snap();
    if (next === undefined) return;
    if (g.same(g.prev, next)) return; // a no-op (a click, or a nudge back to start)
    const { restore, prev } = g;
    record(h, { apply: () => restore(next), reverse: () => restore(prev) });
}

/** whether a gesture is open — the solver's rest signal: length adaptation
 *  re-grids only between gestures, never mid-drag. */
export function gestureActive(): boolean {
    return gesture !== null;
}

/** abort the open gesture, restoring the pre-gesture state. */
export function cancel(): void {
    const g = gesture;
    gesture = null;
    if (g) g.restore(g.prev);
}

// ── track nodes ────────────────────────────────────────────────────────────────

/** extend the chain (lay a node past the tip), recording an undoable add. extend
 *  never reheads the predecessor, so undo is a plain removal of the new node and
 *  redo re-spawns it verbatim. returns the new node's eid. */
export function extendTrack(h: History, ecs: State): number {
    const eid = extend(ecs);
    const order = Handle.order.get(eid);
    const x = Handle.pos.x.get(eid);
    const y = Handle.pos.y.get(eid);
    const theta = Handle.theta.get(eid);
    record(h, {
        apply: () => spawnNode(ecs, order, x, y, theta),
        reverse: () => destroyAt(ecs, order),
    });
    return eid;
}

/** trim the trailing node, recording an undoable remove. `removeTrailingHandle`
 *  reheads the promoted tip (`headLast`), so the command captures that neighbour's
 *  theta before and after and restores it on either side. no-op below the two-node
 *  floor (records nothing, returns false — callers keep their guard). */
export function trimTrack(h: History, ecs: State): boolean {
    const last = lastHandle(ecs);
    if (last === null) return false;
    const order = Handle.order.get(last);
    const x = Handle.pos.x.get(last);
    const y = Handle.pos.y.get(last);
    const theta = Handle.theta.get(last);
    // the tip the trim promotes; its heading re-derives on removal.
    const tip = handleAt(ecs, order - 1);
    const tipThetaBefore = tip === null ? 0 : Handle.theta.get(tip);

    if (!removeTrailingHandle(ecs)) return false;

    const tipAfter = handleAt(ecs, order - 1);
    const tipThetaAfter = tipAfter === null ? tipThetaBefore : Handle.theta.get(tipAfter);
    record(h, {
        apply: () => {
            destroyAt(ecs, order);
            setTheta(ecs, order - 1, tipThetaAfter);
        },
        reverse: () => {
            spawnNode(ecs, order, x, y, theta);
            setTheta(ecs, order - 1, tipThetaBefore);
        },
    });
    return true;
}

/** open a gesture on a node drag, snapshotting the chain's pose. commit coalesces
 *  the drag (which mutates pos + reheads the tip) into one entry; a no-move click
 *  records nothing. */
export function beginMove(ecs: State): void {
    begin(
        () => nodeSnapshot(ecs),
        (s: NodeState[]) => restoreNodes(ecs, s),
        sameNodes,
    );
}

// ── force pins ─────────────────────────────────────────────────────────────────
// pins record onto the same stack, addressed by stable `Pin.id` (the `order`
// convention: eids recycle across a delete→undo, ids never do).

/** a pin's undoable state, keyed by stable id. */
interface PinState {
    id: number;
    track: number;
    sigma: number;
    f: number;
    w: number;
    width: number;
}

function pinState(eid: number): PinState {
    return {
        id: Pin.id.get(eid),
        track: Pin.track.get(eid),
        sigma: Pin.sigma.get(eid),
        f: Pin.f.get(eid),
        w: Pin.w.get(eid),
        width: Pin.width.get(eid),
    };
}

function restorePin(ecs: State, s: PinState): void {
    const eid = pinAt(ecs, s.id);
    if (eid === null) return;
    Pin.sigma.set(eid, s.sigma);
    Pin.f.set(eid, s.f);
    Pin.w.set(eid, s.w);
    Pin.width.set(eid, s.width);
}

function samePin(a: PinState, b: PinState): boolean {
    return a.sigma === b.sigma && a.f === b.f && a.w === b.w && a.width === b.width;
}

/** author a pin (the deliberate add gesture), recording an undoable command.
 *  undo destroys it; redo re-spawns it verbatim. returns the pin eid. */
export function placePin(
    h: History,
    ecs: State,
    trackEid: number,
    sigma: number,
    f: number,
): number {
    const eid = addPin(ecs, trackEid, sigma, f);
    const s = pinState(eid);
    record(h, {
        apply: () => spawnPin(ecs, s.id, s.track, s.sigma, s.f, s.w, s.width),
        reverse: () => {
            const cur = pinAt(ecs, s.id);
            if (cur !== null) ecs.destroy(cur);
        },
    });
    return eid;
}

/** delete a pin by eid, recording an undoable command (undo re-spawns it
 *  verbatim, same id). returns true when a pin was deleted. */
export function deletePin(h: History, ecs: State, eid: number): boolean {
    const s = pinState(eid);
    ecs.destroy(eid);
    record(h, {
        apply: () => {
            const cur = pinAt(ecs, s.id);
            if (cur !== null) ecs.destroy(cur);
        },
        reverse: () => spawnPin(ecs, s.id, s.track, s.sigma, s.f, s.w, s.width),
    });
    return true;
}

/** open a gesture on a pin drag/edit (slide the anchor, drag the value, turn
 *  the weight — any live pin mutation); commit coalesces it to one entry. */
export function beginPinEdit(ecs: State, eid: number): void {
    const id = Pin.id.get(eid);
    begin(
        () => {
            const cur = pinAt(ecs, id);
            return cur === null ? undefined : pinState(cur);
        },
        (s: PinState) => restorePin(ecs, s),
        samePin,
    );
}

// ── position pins: the same pattern, PosPin.id-addressed ───────────────────────

interface PosPinState {
    id: number;
    track: number;
    sigma: number;
    x: number;
    y: number;
    w: number;
}

function posPinState(eid: number): PosPinState {
    return {
        id: PosPin.id.get(eid),
        track: PosPin.track.get(eid),
        sigma: PosPin.sigma.get(eid),
        x: PosPin.x.get(eid),
        y: PosPin.y.get(eid),
        w: PosPin.w.get(eid),
    };
}

function restorePosPin(ecs: State, s: PosPinState): void {
    const eid = posPinAt(ecs, s.id);
    if (eid === null) return;
    PosPin.sigma.set(eid, s.sigma);
    PosPin.x.set(eid, s.x);
    PosPin.y.set(eid, s.y);
    PosPin.w.set(eid, s.w);
}

function samePosPin(a: PosPinState, b: PosPinState): boolean {
    return a.sigma === b.sigma && a.x === b.x && a.y === b.y && a.w === b.w;
}

/** author a position pin (the deliberate add), recording an undoable command. */
export function placePosPin(
    h: History,
    ecs: State,
    trackEid: number,
    sigma: number,
    x: number,
    y: number,
): number {
    const eid = addPosPin(ecs, trackEid, sigma, x, y);
    const s = posPinState(eid);
    record(h, {
        apply: () => spawnPosPin(ecs, s.id, s.track, s.sigma, s.x, s.y, s.w),
        reverse: () => {
            const cur = posPinAt(ecs, s.id);
            if (cur !== null) ecs.destroy(cur);
        },
    });
    return eid;
}

/** delete a position pin by eid, recording an undoable command. */
export function deletePosPin(h: History, ecs: State, eid: number): boolean {
    const s = posPinState(eid);
    ecs.destroy(eid);
    record(h, {
        apply: () => {
            const cur = posPinAt(ecs, s.id);
            if (cur !== null) ecs.destroy(cur);
        },
        reverse: () => spawnPosPin(ecs, s.id, s.track, s.sigma, s.x, s.y, s.w),
    });
    return true;
}

/** open a gesture on a position-pin drag (move the target). */
export function beginPosPinEdit(ecs: State, eid: number): void {
    const id = PosPin.id.get(eid);
    begin(
        () => {
            const cur = posPinAt(ecs, id);
            return cur === null ? undefined : posPinState(cur);
        },
        (s: PosPinState) => restorePosPin(ecs, s),
        samePosPin,
    );
}

function destroyAt(ecs: State, order: number): void {
    const eid = handleAt(ecs, order);
    if (eid !== null) ecs.destroy(eid);
}

function setTheta(ecs: State, order: number, theta: number): void {
    const eid = handleAt(ecs, order);
    if (eid !== null) Handle.theta.set(eid, theta);
}

function sameNodes(a: NodeState[], b: NodeState[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        // both snapshots come from the same order set (a drag adds no nodes), but
        // query order isn't guaranteed — match by order, not index.
        const bi = b.find((n) => n.order === a[i].order);
        if (!bi || bi.x !== a[i].x || bi.y !== a[i].y || bi.theta !== a[i].theta) return false;
    }
    return true;
}
