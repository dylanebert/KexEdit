import { BINDINGS, bound } from "./menu";
import type { SpanMenuActions } from "./menus";

/**
 * The keyboard twin of `menus.ts`: one pure decider per surface, each taking the raw
 * `KeyboardEvent.key` plus a plain state descriptor (the guards its surface already derives) and
 * returning an act name — or `null` when the key doesn't apply. A home's window keydown handler
 * dispatches through its own actions record: `const act = timelineKeyAct(e.key, {…}); if (act !==
 * null) { e.preventDefault(); … }`.
 *
 * Purity is a MODULE-GRAPH property here too: at runtime this module reaches only `./menu`
 * (`BINDINGS`, `bound`) — never the ECS, `editor`, or the DOM — so `tests/menu.test.ts` can drive
 * every decider across its full state matrix with no shim, the same way it drives the menu
 * builders. The `./menus` import is type-only (the delete act's name is derived from the span
 * menu's own actions record instead of restated as a literal), so it erases at build time and
 * never joins the runtime graph. The predicates that feed a descriptor stay where they live
 * today; a decider takes their RESULTS, never recomputes them.
 *
 * The pose era's four deciders — whole-section Delete/Convert/Pin/Reset, the node rungs, the
 * force-keyframe rung and pin mode's Escape/Enter — went with the subjects they addressed
 * (`retired/pose-ux`): there are no sections, nodes, keyframes or modes to press against. What
 * survives is the lane timeline's own rung and its nudge twin.
 */

// ── the lane timeline's own rung (S3b) ────────────────────────────────────────────
// The timeline's window keydown, decided here rather than in `Timeline.svelte` so the whole
// matrix is drivable headlessly. The four presses it owns are the ones the person's check-in two
// named missing: undo/redo (point 5), snap (point 6) and Delete on the selected span (the
// selection rung, point 7). Each compares a LOWERCASED key, so `Z`/`Y`/`S` never appear as raw
// literals and the registry's chord rule (`Modifier`) is what keeps `z` under Ctrl distinct from
// a future bare one.

/** the timeline rung's state (`Timeline.svelte`'s permanent listener). */
export type TimelineKeyState = {
    /** a live pointer gesture is in flight (`editor.dragging`) — every act here is inert
     *  mid-drag: undoing under a drag would replay a stack the open gesture is still writing to,
     *  and deleting the record being dragged leaves the gesture with no subject. */
    dragging: boolean;
    /** the Ctrl/Cmd chord is held (`ctrlKey || metaKey`) — `RESERVED.undo`/`redo`'s own `mod`. */
    ctrl: boolean;
    /** Shift is held — Ctrl+Shift+Z is redo's second form, off the same lowercased `z`. */
    shift: boolean;
    /** a record is selected — Delete has a subject only then. */
    selected: boolean;
};

/** the acts the timeline rung names. `remove` is the one that reads a `BINDINGS` row (Delete, the
 *  span menu's own terminal row); the other three are reserved presses with no menu row. */
export type TimelineAct = "undo" | "redo" | Extract<keyof SpanMenuActions, "remove"> | "toggleSnap";

/** timeline Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / Delete / `S` — `null` off every claim, and `null`
 *  for ALL of them while a gesture is live. Delete additionally needs a selected record; the snap
 *  toggle needs nothing, since it is a standing preference rather than an act on a subject. */
export function timelineKeyAct(key: string, s: TimelineKeyState): TimelineAct | null {
    if (s.dragging) return null;
    const k = key.toLowerCase();
    if (s.ctrl) {
        if (k === "z") return s.shift ? "redo" : "undo";
        if (k === "y") return "redo";
        return null;
    }
    if (bound(BINDINGS.remove, key)) return s.selected ? "remove" : null;
    if (k === "s") return "toggleSnap";
    return null;
}

// ── the nudge rung (S3c) ──────────────────────────────────────────────────────────
// The in-place tweak the person asked for beside the popover (check-in two, point 13: "some
// shortcut controls to be able to tweak in-place on the timeline"). One meaning per channel
// (`editor-ui.md`): the HORIZONTAL arrows move the span along the ruler, and the VERTICAL arrows
// move a handle's value — under Shift, because a bare Up/Down over a stack of lane rows would
// read as "change row", which is the reorder grip's job, not a key's.
//
// The decider names the DIRECTION and the subject; the quantum is the caller's
// (`timeline.S_GRID` for a station, `timeline.nudgeQuantum(lane)` for a value), because a
// quantum is a per-lane number and this module reaches nothing that knows a lane.

/** the nudge rung's state. */
export type NudgeKeyState = {
    /** a live pointer gesture is in flight — a nudge mid-drag would write behind the gesture. */
    dragging: boolean;
    /** a record is selected: the nudge's whole subject. */
    selected: boolean;
    /** Shift is held — the value channel rather than the station channel. */
    shift: boolean;
    /** Alt is held — narrows a value nudge to the ENTRY handle. */
    alt: boolean;
    /** the selected record OWNS its entry handle. A record whose entry is inferred has no entry
     *  to nudge (writing one would author ownership as a side effect of an arrow press), so the
     *  Alt form returns `null` there rather than silently minting a handle. */
    ownsEntry: boolean;
};

/** one nudge: which channel it moves, whose handle when it is a value, and the SIGN (+1/−1). The
 *  caller multiplies by the channel's own quantum. */
export type NudgeAct =
    | { kind: "station"; sign: 1 | -1 }
    | { kind: "value"; which: "entry" | "exit"; sign: 1 | -1 };

/** timeline ←/→ (station) and Shift+↑/↓ (value, Alt for the owned entry) — `null` off every
 *  arrow, with nothing selected, mid-gesture, or for an Alt form over an inferred entry. The
 *  unshifted vertical arrows and the shifted horizontal ones are deliberately `null`: one meaning
 *  per channel, so a press never means two things depending on how hard the person leans on it.
 *
 *  It takes the PRESS (`{ key }`), not a bare string, unlike {@link timelineKeyAct} above: the
 *  four arrows are `RESERVED` presses with no `BINDINGS` row to match through `bound`, so their
 *  literals live here, and `tests/menu.test.ts`'s population scanner reads a `.key` compare —
 *  taking the press is what keeps these four inside the closed registry rather than invisible to
 *  it. A `KeyboardEvent` satisfies the shape, so the call site passes the event itself. */
export function nudgeAct(press: { key: string }, s: NudgeKeyState): NudgeAct | null {
    if (s.dragging || !s.selected) return null;
    if (s.shift) {
        if (s.alt && !s.ownsEntry) return null;
        const which = s.alt ? "entry" : "exit";
        if (press.key === "ArrowUp") return { kind: "value", which, sign: 1 };
        if (press.key === "ArrowDown") return { kind: "value", which, sign: -1 };
        return null;
    }
    if (press.key === "ArrowRight") return { kind: "station", sign: 1 };
    if (press.key === "ArrowLeft") return { kind: "station", sign: -1 };
    return null;
}
