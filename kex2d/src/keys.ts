import { BINDINGS, bound, RESERVED } from "./menu";
import type { SpanMenuActions } from "./menus";

/** Suppress global handlers without preventing native typing, focus or checkbox actions.
 * Field Enter/Escape reach the field; menu Escape reaches the dismissal owner. */
export function inputOwnsKey(key: string, field: boolean, menu: boolean): boolean {
    if (bound(BINDINGS.exitMode, key)) return false;
    if (menu) return true;
    return field && !RESERVED.commitField.keys.some((value) => value === key);
}

/** Plain input facts, read synchronously by the surface rather than from a tick-lagged closure. */
export type TimelineKeyState = {
    dragging: boolean;
    ctrl: boolean;
    shift: boolean;
    selected: boolean;
    local?: boolean;
    inputOwned?: boolean;
};
export type TimelineAct =
    | "undo"
    | "redo"
    | Extract<keyof SpanMenuActions, "remove">
    | "toggleSnap"
    | "selectTool"
    | "addTool";

/** The shared edit keys and the three explicitly local authoring mnemonics. */
export function timelineKeyAct(key: string, s: TimelineKeyState): TimelineAct | null {
    if (s.dragging || s.inputOwned) return null;
    const k = key.toLowerCase();
    if (s.ctrl) {
        if (k === "z") return s.shift ? "redo" : "undo";
        if (k === "y") return "redo";
        return null;
    }
    if (s.local && bound(BINDINGS.selectTool, k)) return "selectTool";
    if (s.local && bound(BINDINGS.addTool, k)) return "addTool";
    if (bound(BINDINGS.remove, key)) return s.selected ? "remove" : null;
    if (s.local && k === "s") return "toggleSnap";
    return null;
}

export type NudgeKeyState = {
    dragging: boolean;
    selected: boolean;
    shift: boolean;
    alt: boolean;
    /** Ownership must not affect the target-only nudge. Kept in the input truth table. */
    ownsEntry: boolean;
};
export type NudgeAct =
    | { kind: "station"; sign: 1 | -1 }
    | { kind: "value"; which: "entry" | "exit"; sign: 1 | -1 };

/** Left/right move stations; Shift+up/down changes the absolute target. No Alt entry path. */
export function nudgeAct(press: { key: string }, s: NudgeKeyState): NudgeAct | null {
    if (s.dragging || !s.selected || s.alt) return null;
    if (s.shift) {
        const which = "exit";
        if (press.key === "ArrowUp") return { kind: "value", which, sign: 1 };
        if (press.key === "ArrowDown") return { kind: "value", which, sign: -1 };
        return null;
    }
    if (press.key === "ArrowRight") return { kind: "station", sign: 1 };
    if (press.key === "ArrowLeft") return { kind: "station", sign: -1 };
    return null;
}
