/** undo/redo over the pin store, mirroring the shallot editor's command model
 *  (`shallot/.../editor/document/index.ts`): a discriminated-union command holding
 *  inverse data (`prev`/`next`), a dual stack, and a `begin`/`commit`/`cancel`
 *  gesture lifecycle so one drag collapses to a single entry.
 *
 *  the pin store is the canonical authoring data (see `pins.ts`), so apply/reverse
 *  mutate it directly — there's no separate runtime mirror to sync (unlike the
 *  editor, where commands sync into the ECS). do-paths mutate the store live (the
 *  re-solve is instant via the pin `rev` gate) and record an already-applied
 *  command; only undo/redo replay through apply/reverse. */

import {
    addPin,
    findPin,
    insertPin,
    type Pin,
    type PinState,
    pinsOf,
    removePin,
    setPin,
} from "./pins";

type Cmd =
    | { type: "add"; eid: number; pin: Pin; at: number }
    | { type: "remove"; eid: number; pin: Pin; at: number }
    | { type: "set"; eid: number; id: number; prev: PinState; next: PinState };

export interface History {
    undo: Cmd[];
    redo: Cmd[];
}

const MAX_UNDO = 256;

export function createHistory(): History {
    return { undo: [], redo: [] };
}

/** the app's single history. tests build their own via `createHistory`. */
export const history = createHistory();

function record(h: History, cmd: Cmd): void {
    h.undo.push(cmd);
    if (h.undo.length > MAX_UNDO) h.undo.shift();
    h.redo.length = 0; // a new edit invalidates the redo branch
}

function apply(cmd: Cmd): void {
    if (cmd.type === "add") insertPin(cmd.eid, cmd.pin, cmd.at);
    else if (cmd.type === "remove") removePin(cmd.eid, cmd.pin.id);
    else setPin(cmd.eid, cmd.id, cmd.next.index, cmd.next.value);
}

function reverse(cmd: Cmd): void {
    if (cmd.type === "add") removePin(cmd.eid, cmd.pin.id);
    else if (cmd.type === "remove") insertPin(cmd.eid, cmd.pin, cmd.at);
    else setPin(cmd.eid, cmd.id, cmd.prev.index, cmd.prev.value);
}

/** drop a new pin (the do-path appends it live, then records an undoable add). */
export function drop(h: History, eid: number, index: number, value: number): Pin {
    const at = pinsOf(eid).length; // the append position, restored on redo
    const pin = addPin(eid, index, value);
    record(h, { type: "add", eid, pin, at });
    return pin;
}

/** delete a pin by id, recording it (with its position) so undo restores it. */
export function erase(h: History, eid: number, id: number): void {
    const pin = findPin(eid, id);
    if (!pin) return;
    const at = removePin(eid, id);
    record(h, { type: "remove", eid, pin, at });
}

export function undo(h: History): void {
    const cmd = h.undo.pop();
    if (!cmd) return;
    reverse(cmd);
    h.redo.push(cmd);
}

export function redo(h: History): void {
    const cmd = h.redo.pop();
    if (!cmd) return;
    apply(cmd);
    h.undo.push(cmd);
}

// ── gesture lifecycle: a drag (or a live inline edit) writes the pin every frame
// for instant preview, then commits one coalesced `set`. a single gesture is open
// at a time (one pin under the cursor).
let gesture: { eid: number; id: number; prev: PinState } | null = null;

/** open a gesture on a pin, capturing its pristine state for commit/cancel. */
export function begin(eid: number, id: number): void {
    const pin = findPin(eid, id);
    if (!pin) return;
    gesture = { eid, id, prev: { index: pin.index, value: pin.value } };
}

/** commit the open gesture: record one `set` (prev → the pin's current state) if
 *  it actually changed; the live writes already applied it. */
export function commit(h: History): void {
    const g = gesture;
    gesture = null;
    if (!g) return;
    const pin = findPin(g.eid, g.id);
    if (!pin) return;
    const next: PinState = { index: pin.index, value: pin.value };
    if (next.index === g.prev.index && next.value === g.prev.value) return; // no-op (a click)
    record(h, { type: "set", eid: g.eid, id: g.id, prev: g.prev, next });
}

/** abort the open gesture, restoring the pin to its pre-gesture state. */
export function cancel(): void {
    const g = gesture;
    gesture = null;
    if (!g) return;
    setPin(g.eid, g.id, g.prev.index, g.prev.value);
}
