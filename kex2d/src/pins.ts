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
/** a bezier tangent handle, measured *outward from its own keyframe* (Phase 2c).
 *  `dx` is the time-fraction into the adjacent segment, clamped to [0,1] — the
 *  clamp keeps the segment's x(s) single-valued (the CSS cubic-bezier
 *  function-of-time guarantee), so the constraint curve never folds back in time.
 *  `dy` is a *free* g-delta from the keyframe's value (NOT theatre's value-delta
 *  normalization), so a flat segment can still bump and overshoot the band. */
export interface Handle {
    dx: number;
    dy: number;
}

/** the neutral tangent: a third of the way into the segment, flat (dy 0) — so the
 *  default piecewise curve eases smoothly through the pins. */
export function defaultHandle(): Handle {
    return { dx: 1 / 3, dy: 0 };
}

export interface Pin {
    /** stable identity, assigned once and never reused. */
    id: number;
    /** draft-time grid index in [0, OPT_GRID). draft-time addressing keeps the
     *  pin at a fixed index so the solve term stays convex. */
    index: number;
    /** target normal force in g. */
    value: number;
    /** the left tangent handle (toward the previous keyframe). */
    hl: Handle;
    /** the right tangent handle (toward the next keyframe). */
    hr: Handle;
}

/** a pin's mutable state — the undo commands' `prev`/`next` payload. handles are
 *  objects, so snapshots must deep-copy them (see `pinSnapshot`). */
export interface PinState {
    index: number;
    value: number;
    hl: Handle;
    hr: Handle;
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
    const pin: Pin = { id: nextId++, index, value, hl: defaultHandle(), hr: defaultHandle() };
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

/** set one tangent handle of a pin by id (a handle drag). `dx` is clamped to
 *  [0,1] (function-of-time); `dy` is free (overshoot). no-op if the pin is gone. */
export function setHandle(
    trackEid: number,
    id: number,
    side: "l" | "r",
    dx: number,
    dy: number,
): void {
    const pin = findPin(trackEid, id);
    if (!pin) return;
    const h = side === "l" ? pin.hl : pin.hr;
    h.dx = Math.min(Math.max(dx, 0), 1);
    h.dy = dy;
    rev++;
}

/** a deep snapshot of a pin's mutable state — the gesture's pristine `prev` and
 *  the committed `next`. handles are objects, so they're cloned: a live drag
 *  mutates the pin in place, and a shallow copy would let it bleed into the
 *  captured state and corrupt undo. */
export function pinSnapshot(trackEid: number, id: number): PinState | undefined {
    const pin = findPin(trackEid, id);
    if (!pin) return undefined;
    return {
        index: pin.index,
        value: pin.value,
        hl: { dx: pin.hl.dx, dy: pin.hl.dy },
        hr: { dx: pin.hr.dx, dy: pin.hr.dy },
    };
}

/** restore a pin's full state from a snapshot — index, value, and both handles —
 *  atomically (undo/redo of a `set`, and a gesture cancel). deep-copies the
 *  snapshot's handles in, so the stored state and the live pin never alias. */
export function restorePin(trackEid: number, id: number, s: PinState): void {
    const pin = findPin(trackEid, id);
    if (!pin) return;
    pin.index = s.index;
    pin.value = s.value;
    pin.hl = { dx: s.hl.dx, dy: s.hl.dy };
    pin.hr = { dx: s.hr.dx, dy: s.hr.dy };
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
