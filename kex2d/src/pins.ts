/** authored force pins — canonical track authoring data. the force constraints
 *  the user draws on the timeline are part of the track's design, the same tier
 *  as the nodes, and serialize with the track when save/load lands (NOT ephemeral
 *  like `editor.selection`). per-track, keyed by trackEid like `bakeOut`/
 *  `solveOut`/`samples`, but authored rather than derived.
 *
 *  a pin pulls the solved F_n toward `value` at a fixed draft-time grid index —
 *  `optimize.ts` builds a `PointCon` from it and the recovery anchor heals the
 *  downstream geometry the edit would otherwise swing. the nodes are
 *  canonical-in-ECS (`Handle` entities), but pins use a plain store with a stable
 *  monotonic `id`: undo commands address pins by `id`, which survives a
 *  remove→undo→set round-trip where a recycled ECS eid would not. */
export interface Pin {
    /** stable identity, assigned once and never reused. */
    id: number;
    /** draft-time grid index in [0, OPT_GRID). draft-time addressing keeps the
     *  pin at a fixed index so the solve term stays convex. */
    index: number;
    /** target normal force in g. */
    value: number;
}

/** a pin's mutable state — the undo commands' `prev`/`next` payload. */
export interface PinState {
    index: number;
    value: number;
}

const store = new Map<number, Pin[]>();
let nextId = 1;
let rev = 0;

/** the pins on a track, in insertion order. the returned array is the live
 *  store array — read-only to callers; mutate only through the ops below. */
export function pinsOf(trackEid: number): readonly Pin[] {
    return store.get(trackEid) ?? EMPTY;
}
const EMPTY: readonly Pin[] = [];

/** monotonic revision, bumped on every pin mutation. the solve gate folds this
 *  in so a pin edit re-solves even when the bake is unchanged. */
export function pinRev(): number {
    return rev;
}

/** append a new pin with a fresh stable id; returns it (the undo `add` command
 *  records the created pin). */
export function addPin(trackEid: number, index: number, value: number): Pin {
    const pin: Pin = { id: nextId++, index, value };
    list(trackEid).push(pin);
    rev++;
    return pin;
}

/** re-insert an existing pin object at `at` (undo of a remove / redo of an add).
 *  keeps the pin's id, restoring the exact prior state. */
export function insertPin(trackEid: number, pin: Pin, at: number): void {
    const arr = list(trackEid);
    arr.splice(Math.min(Math.max(at, 0), arr.length), 0, pin);
    rev++;
}

/** remove the pin with `id`; returns its array position (so the undo command can
 *  restore it there), or -1 if absent. */
export function removePin(trackEid: number, id: number): number {
    const arr = store.get(trackEid);
    if (!arr) return -1;
    const at = arr.findIndex((p) => p.id === id);
    if (at < 0) return -1;
    arr.splice(at, 1);
    rev++;
    return at;
}

/** set a pin's index + value by id (a drag moves both, an inline edit only the
 *  value). no-op if the pin is gone. */
export function setPin(trackEid: number, id: number, index: number, value: number): void {
    const pin = findPin(trackEid, id);
    if (!pin) return;
    pin.index = index;
    pin.value = value;
    rev++;
}

/** the pin with `id` on a track, or undefined. */
export function findPin(trackEid: number, id: number): Pin | undefined {
    return store.get(trackEid)?.find((p) => p.id === id);
}

/** drop every pin on a track (a freshly created track carries none). */
export function clearPins(trackEid: number): void {
    if (store.delete(trackEid)) rev++;
}

function list(trackEid: number): Pin[] {
    let arr = store.get(trackEid);
    if (!arr) {
        arr = [];
        store.set(trackEid, arr);
    }
    return arr;
}
