/** undo/redo substrate for the whole editor, mirroring the shallot editor's
 *  command model (`shallot/.../editor/document/index.ts`): opaque `apply`/`reverse`
 *  commands on a dual stack, plus a `begin`/`commit`/`cancel` gesture lifecycle so
 *  one drag collapses to a single entry.
 *
 *  the substrate is domain-agnostic — a `Command` is just a do/undo pair. two
 *  authoring surfaces record onto the one stack: the force pins (`pins.ts`,
 *  canonical store, addressed by stable `id`) and the track nodes (`track.ts`,
 *  ECS `Handle` entities, addressed by stable `order` — the append/delete-trailing
 *  chain never changes an interior node's order, so order survives eid recycling
 *  across a delete→undo the way the pin `id` does).
 *
 *  do-paths mutate the live data (the re-solve / re-bake is instant via the pin
 *  `rev` / bake `hash` gates) and record an already-applied command; only undo/redo
 *  replay through apply/reverse. */

import {
    addPin,
    findPin,
    insertPin,
    type Pin,
    type PinState,
    pinSnapshot,
    pinsOf,
    removePin,
    restorePin,
} from "./pins";
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

function record(h: History, cmd: Command): void {
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

/** abort the open gesture, restoring the pre-gesture state. */
export function cancel(): void {
    const g = gesture;
    gesture = null;
    if (g) g.restore(g.prev);
}

// ── pins ─────────────────────────────────────────────────────────────────────

/** drop a new pin (the do-path appends it live, then records an undoable add). */
export function drop(h: History, eid: number, index: number, value: number): Pin {
    const at = pinsOf(eid).length; // the append position, restored on redo
    const pin = addPin(eid, index, value);
    record(h, {
        apply: () => insertPin(eid, pin, at),
        reverse: () => removePin(eid, pin.id),
    });
    return pin;
}

/** delete a pin by id, recording it (with its position) so undo restores it. */
export function erase(h: History, eid: number, id: number): void {
    const pin = findPin(eid, id);
    if (!pin) return;
    const at = removePin(eid, id);
    record(h, {
        apply: () => removePin(eid, pin.id),
        reverse: () => insertPin(eid, pin, at),
    });
}

/** open a gesture on a pin — a drag (index+value), a tangent-handle drag, or an
 *  inline value edit — coalescing the live writes into one `set`. */
export function beginPin(eid: number, id: number): void {
    begin(
        () => pinSnapshot(eid, id),
        (s: PinState) => restorePin(eid, id, s),
        samePin,
    );
}

function samePin(a: PinState, b: PinState): boolean {
    return (
        a.index === b.index &&
        a.value === b.value &&
        a.hl.dx === b.hl.dx &&
        a.hl.dy === b.hl.dy &&
        a.hr.dx === b.hr.dx &&
        a.hr.dy === b.hr.dy
    );
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
