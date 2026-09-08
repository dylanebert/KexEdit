import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    activateRecord,
    activeKind,
    anySelected,
    beginConvert,
    clearHover,
    clearSelection,
    convertProgress,
    dismissNotice,
    editor,
    endConvert,
    fitDone,
    multi,
    notify,
    type Selection,
    selectionHook,
    selectRecord,
    selectRecords,
    setMember,
    solveDone,
    solveFailed,
    toggleMember,
    toggleRecord,
    writeHover,
} from "../src/editor";
import { addRecord, createHistory, removeRecord } from "../src/history";
import { Lane } from "../src/lanes";
import { Easing } from "../src/profile";
import { BakeSystem, createTrack } from "../src/track";

// the selection substrate over the lane records: one member set with an active member, and
// single-select as its size-1 case. These are pure editor-state tests — `selectRecord` and its
// siblings touch no ECS (only the `SelectionHook` does, and its restore-against-the-store arm is
// at the bottom of this file). Clear before each so a leftover can't leak.
beforeEach(() => {
    clearSelection();
});

// ── pure set helpers ──

test("toggleMember adds-and-activates, removes-and-promotes the most-recently-added survivor", () => {
    const sel: Selection = { ids: new Set(), active: null };
    toggleMember(sel, 1);
    expect([...sel.ids]).toEqual([1]);
    expect(sel.active).toBe(1);
    toggleMember(sel, 2);
    toggleMember(sel, 3);
    expect([...sel.ids]).toEqual([1, 2, 3]);
    expect(sel.active).toBe(3); // active follows the last toggled-in member
    toggleMember(sel, 1); // remove a non-active member — active unchanged
    expect([...sel.ids]).toEqual([2, 3]);
    expect(sel.active).toBe(3);
    toggleMember(sel, 3); // remove the active → promote the last survivor in insertion order
    expect([...sel.ids]).toEqual([2]);
    expect(sel.active).toBe(2);
    toggleMember(sel, 2); // remove the last member → active clears
    expect(sel.ids.size).toBe(0);
    expect(sel.active).toBeNull();
});

test("active promotion picks the last-inserted survivor, independent of what was removed", () => {
    const sel: Selection = { ids: new Set(), active: null };
    for (const id of [5, 6, 7]) toggleMember(sel, id); // active 7
    toggleMember(sel, 6); // remove an interior non-active member
    expect([...sel.ids]).toEqual([5, 7]);
    toggleMember(sel, 7); // remove the active → promote 5 (the sole survivor, last in order)
    expect(sel.active).toBe(5);
});

test("setMember replaces the set with one member, or clears it", () => {
    const sel: Selection = { ids: new Set([1, 2, 3]), active: 2 };
    setMember(sel, 9);
    expect([...sel.ids]).toEqual([9]);
    expect(sel.active).toBe(9);
    setMember(sel, null);
    expect(sel.ids.size).toBe(0);
    expect(sel.active).toBeNull();
});

// ── replace (single-select, the default) ──

// ── the record kind ──────────────────────────────────────────────────────────────────
// One kind over the lane substrate, addressed by the stable record id every setter, op and undo
// entry already uses. The three forms a press takes: replace (a plain click), toggle (Shift), and
// clear (an empty click, or Escape's selection rung).

test("a plain click replace-selects: one member, active, whatever was there gone", () => {
    selectRecord(4);
    selectRecord(7);
    expect([...editor.records.ids]).toEqual([7]);
    expect(editor.record).toBe(7);
    expect(anySelected()).toBe(true);
    expect(multi()).toBe(false);
});

test("the scalar setter is a replace-select", () => {
    selectRecord(4);
    editor.record = 9;
    expect([...editor.records.ids]).toEqual([9]);
    expect(editor.record).toBe(9);
});

// RED: make `toggleRecord` an unconditional add and the second press below never removes — the
// Shift-click grammar loses its half.
test("Shift toggles membership, the active following the last toggled-in member", () => {
    selectRecord(4);
    toggleRecord(7);
    toggleRecord(9);
    expect([...editor.records.ids]).toEqual([4, 7, 9]);
    expect(editor.record).toBe(9);
    expect(multi()).toBe(true);
    toggleRecord(7);
    expect([...editor.records.ids]).toEqual([4, 9]);
    expect(editor.record).toBe(9); // an inactive member leaving doesn't move the active
});

// RED: promote the FIRST survivor instead of the last-inserted one and this reads 4, not 7.
test("toggling out the active promotes the most-recently-added survivor", () => {
    selectRecord(4);
    toggleRecord(7);
    toggleRecord(9);
    toggleRecord(9); // the active leaves
    expect(editor.record).toBe(7);
});

test("selectRecord(null) and clearSelection both empty the set", () => {
    selectRecord(4);
    selectRecord(null);
    expect(anySelected()).toBe(false);
    expect(editor.record).toBeNull();
    selectRecord(4);
    toggleRecord(7);
    clearSelection();
    expect([...editor.records.ids]).toEqual([]);
    expect(editor.record).toBeNull();
});

test("selectRecords writes a whole set and anchors the active, falling back to the last member", () => {
    selectRecords([4, 7, 9], 7);
    expect([...editor.records.ids]).toEqual([4, 7, 9]);
    expect(editor.record).toBe(7);
    selectRecords([4, 7], 99); // an active outside the set falls back to the last inserted
    expect(editor.record).toBe(7);
    selectRecords([], null);
    expect(anySelected()).toBe(false);
});

// RED: let `activateRecord` add the id it was given and a right-click outside the set would
// silently grow it — the Blender active-object model says promote a MEMBER, never mint one.
test("activateRecord promotes a member without disturbing the set, and no-ops off it", () => {
    selectRecord(4);
    toggleRecord(7);
    activateRecord(4);
    expect(editor.record).toBe(4);
    expect([...editor.records.ids]).toEqual([4, 7]);
    activateRecord(99);
    expect(editor.record).toBe(4);
    expect([...editor.records.ids]).toEqual([4, 7]);
});

test("activeKind tags the one kind, and null on an empty selection", () => {
    expect(activeKind()).toBeNull();
    selectRecord(4);
    expect(activeKind()).toBe("record");
    clearSelection();
    expect(activeKind()).toBeNull();
});

// ── the history selection hook ────────────────────────────────────────────────────────
// The hook snapshots the whole SET, and restores only the members whose records the store still
// holds — the store is the authority on what exists, so an undo past a delete restores the set
// minus what is gone rather than a member addressing nothing.
describe("selectionHook — snapshot the set, restore against the store", () => {
    function fixture(): { ecs: State; ids: number[] } {
        const ecs = new State();
        ecs.addSystem(BakeSystem);
        createTrack(ecs);
        const h = createHistory();
        const ids: number[] = [];
        for (const [start, end] of [
            [0, 10],
            [10, 20],
        ] as const) {
            const w = addRecord(h, ecs, Lane.Force, {
                start,
                end,
                ease: Easing.Linear,
                entry: 1,
                exit: 1,
            });
            if (w.id === null) throw new Error("fixture refused");
            ids.push(w.id);
        }
        return { ecs, ids };
    }

    test("an empty selection snapshots as null and restores as a clear", () => {
        const { ecs, ids } = fixture();
        expect(selectionHook.snapshot(ecs)).toBeNull();
        selectRecord(ids[0]);
        selectionHook.restore(ecs, null);
        expect(anySelected()).toBe(false);
    });

    test("every member rides the snapshot, and the active comes back as the active", () => {
        const { ecs, ids } = fixture();
        selectRecord(ids[0]);
        toggleRecord(ids[1]);
        const snap = selectionHook.snapshot(ecs);
        clearSelection();
        selectionHook.restore(ecs, snap);
        expect([...editor.records.ids]).toEqual(ids);
        expect(editor.record).toBe(ids[1]);
    });

    // RED: drop the `recordAt` guard in `restore` and the deleted record comes back as a member
    // addressing nothing — every later reader (the popover, the Delete rung) then binds to a
    // record the store does not hold.
    test("a member whose record is gone is dropped on restore, and the active falls back", () => {
        const { ecs, ids } = fixture();
        selectRecord(ids[0]);
        toggleRecord(ids[1]);
        const snap = selectionHook.snapshot(ecs);
        clearSelection();
        // the second record leaves the store between the snapshot and the restore
        const h = createHistory();
        expect(removeRecord(h, ecs, ids[1]).id).toBe(ids[1]);
        selectionHook.restore(ecs, snap);
        expect([...editor.records.ids]).toEqual([ids[0]]);
        expect(editor.record).toBe(ids[0]); // the active fell back to the surviving member
    });
});

// ── the invoked-solve gate (kex2d-geoforce-editor stage 3) ──
// the modal's state, device-free: what opens it, what a progress report may write, and what a
// report arriving after it closed may NOT write.

test("beginConvert opens the gate zeroed and clears the previous readout", () => {
    notify("done", "an earlier solve");
    beginConvert();
    expect(editor.converting).toEqual({ phase: "open", keys: 0, probes: 0 });
    expect(editor.notice).toBeNull(); // a new solve's modal never carries the last one's result
    endConvert();
    expect(editor.converting).toBeNull();
});

test("convertProgress folds a report into the live gate", () => {
    beginConvert();
    convertProgress({ phase: "split", keys: 9, probes: 4 });
    expect(editor.converting).toEqual({ phase: "split", keys: 9, probes: 4 });
    convertProgress({ phase: "prune", keys: 12, probes: 30 });
    expect(editor.converting).toEqual({ phase: "prune", keys: 12, probes: 30 });
    endConvert();
});

test("a progress report landing after the gate closed is dropped", () => {
    // a cancelled solve's in-flight probe still reports; writing it would raise the modal back
    // over an editor that is no longer converting, with no cancel path left to close it.
    beginConvert();
    endConvert();
    convertProgress({ phase: "prune", keys: 12, probes: 30 });
    expect(editor.converting).toBeNull();
});

test("a notice is raised and dismissed on its own, without touching the gate", () => {
    notify("error", "The solve diverged.");
    expect(editor.notice).toEqual({ kind: "error", text: "The solve diverged." });
    expect(editor.converting).toBeNull();
    dismissNotice();
    expect(editor.notice).toBeNull();
});

// ── what a finished solve says ──
// the readout mapping, branch by branch. Every exit a solve has lands here, and this text is the
// author's ONLY report of what happened — a branch that silently reads as another one (a diverged
// answer announcing "Converted to force" over an unchanged section) is invisible to every other gate.

const answer = { outcome: "floor", keys: 12, deviation: 0.567, floor: 0.571 };

test("a converged convert reads as a short confirmation, nothing else", () => {
    // it held its budget, so the readout says only "it worked" — the key count was dropped as
    // noise (stage 7: the curve is on screen). Anything past that is noise the readout doesn't earn.
    expect(solveDone(answer)).toEqual({ kind: "done", text: "Converted to force" });
});

test("a budget convert landed too — it reads as done, and names the miss", () => {
    // "budget" is the sanctioned narrow-feature outcome (refine.ts): the answer IS on the
    // document, so it must not read as a failure — but it missed, and THAT is when the
    // achieved-vs-allowed numbers are worth the author's attention.
    expect(solveDone({ ...answer, outcome: "budget" })).toEqual({
        kind: "done",
        text: "Converted to force · 0.57 m off (0.57 m allowed)",
    });
});

test("a diverged convert reads as a failure — nothing was landed", () => {
    // it RESOLVES like a success (geoforce.ts writes nothing on it), so this branch is the only
    // thing standing between an unchanged section and a green "Converted to force".
    expect(solveDone({ ...answer, outcome: "diverged" })).toEqual({
        kind: "error",
        text: "The solve could not fit this shape. Nothing changed.",
    });
});

test("a cancel says nothing at all and logs nothing", () => {
    expect(solveFailed(new Error("cancelled"), true)).toEqual({ notice: null, detail: null });
});

test("any other failure reads as one sentence, never the thrown message", () => {
    const { notice, detail } = solveFailed(
        new Error("convertGeo: section 3 has no live bake"),
        false,
    );
    expect(notice?.kind).toBe("error");
    expect(notice?.text).toBe("The solve could not finish. Nothing changed.");
    expect(notice?.text).not.toContain("convertGeo"); // no internals on the readout
    expect(detail).toContain("convertGeo: section 3 has no live bake");
});

test("a non-Error rejection still reports something", () => {
    const { notice, detail } = solveFailed("worker died", false);
    expect(notice?.text).toBe("The solve could not finish. Nothing changed.");
    expect(detail).toBe("worker died");
});

// ── the force→geo fit's readout (`fitDone`) — `solveDone`'s dual-budget twin ──
// same three-way branch, over the geo (m) + force (g) budget pair instead of the single
// geometric floor. `solveFailed` is reused as-is (it's direction-neutral, `StaleConvert` matched
// by name), so only the RESOLVED mapping gets its own tests.

const fitAnswer = {
    outcome: "floor",
    nodes: 6,
    deviation: 0.31,
    forceError: 0.22,
    geoBudget: 0.5,
    forceBudget: 0.5,
};

test("a converged fit reads as a short confirmation, nothing else", () => {
    expect(fitDone(fitAnswer)).toEqual({ kind: "done", text: "Converted to geo" });
});

test("a budget fit names only the axis that missed", () => {
    // "budget" is the sanctioned narrow-feature outcome (geofit.ts): the answer IS on the
    // document, so it must not read as a failure. The geometric budget held here, so printing it
    // would bury the one reading the author can act on.
    expect(fitDone({ ...fitAnswer, outcome: "budget", forceError: 0.58 })).toEqual({
        kind: "done",
        text: "Converted to geo · 0.58 g off (0.50 g allowed)",
    });
});

test("both axes missing prints both, in geo-then-force order", () => {
    expect(
        fitDone({ ...fitAnswer, outcome: "budget", deviation: 0.62, forceError: 0.58 }).text,
    ).toBe("Converted to geo · 0.62 m off (0.50 m allowed) · 0.58 g off (0.50 g allowed)");
});

test("a budget fit that held BOTH bounds reports both readings", () => {
    // it ran out of admissible split sites rather than missing, so there is no single miss to
    // point at — the fallback keeps the outcome honest instead of reading as a clean hold.
    expect(fitDone({ ...fitAnswer, outcome: "budget" }).text).toBe(
        "Converted to geo · 0.31 m off (0.50 m allowed) · 0.22 g off (0.50 g allowed)",
    );
});

test("a diverged fit reads as a failure — nothing was landed", () => {
    // it RESOLVES like a success (forcegeo.ts writes nothing on it), so this branch is the only
    // thing standing between an unchanged section and a green "Converted to geo".
    expect(fitDone({ ...fitAnswer, outcome: "diverged" })).toEqual({
        kind: "error",
        text: "The solve could not fit this shape. Nothing changed.",
    });
});

test("a dense fit reads as a failure and names the node count — a held budget isn't a miss", () => {
    // forcegeo.ts rewrites an over-`MAX_LANDED_NODES` answer's outcome to "dense" even though the
    // fit itself held its budget — nothing lands, so this must read like "diverged", not "budget".
    expect(fitDone({ ...fitAnswer, outcome: "dense", nodes: 240 })).toEqual({
        kind: "error",
        text: "The fit needs 240 nodes — too many to author. Nothing changed.",
    });
});

// ── the hover seam (kex2d-followups stage 3, follow-up 7): `writeHover`/`clearHover` are pure —
// they only mutate this module's own `hoverKnob`/`hoverNode`/`hoverForce`/`hoverSection` fields —
// so they're pinned here, beside the state they own, rather than in controls.test.ts (whose
// pointerleave/detach pin needs a real `attachControls` wiring and stays there).
describe("writeHover / clearHover — the one seam every hover write and clear go through", () => {
    afterEach(() => {
        clearHover();
    });

    test("writeHover writes exactly the given four fields, replacing whatever was there", () => {
        writeHover({ knob: { eid: 9, side: "out" }, node: null, force: null, section: null });
        expect(editor.hoverKnob).toEqual({ eid: 9, side: "out" });
        expect(editor.hoverNode).toBeNull();
        expect(editor.hoverForce).toBeNull();
        expect(editor.hoverSection).toBeNull();

        writeHover({ knob: null, node: 5, force: null, section: null });
        expect(editor.hoverKnob).toBeNull();
        expect(editor.hoverNode).toBe(5);
    });

    test("clearHover clears all four fields regardless of their prior values", () => {
        writeHover({ knob: { eid: 1, side: "in" }, node: 2, force: 3, section: 4 });
        clearHover();
        expect(editor.hoverKnob).toBeNull();
        expect(editor.hoverNode).toBeNull();
        expect(editor.hoverForce).toBeNull();
        expect(editor.hoverSection).toBeNull();
    });
});

// ── the set-level predicates ───────────────────────────────────────────────────────────
// `multi()` answers whether contextual single-subject chrome is valid (the popover binds to one
// span); `anySelected()` answers whether the dismissal rung has anything to clear. Both read the
// set, not a per-kind view.
describe("multi / anySelected — the set-level reads", () => {
    test("an empty selection reads false on both", () => {
        expect(multi()).toBe(false);
        expect(anySelected()).toBe(false);
    });

    test("one member is selected but not multi; two members are both", () => {
        selectRecord(5);
        expect(anySelected()).toBe(true);
        expect(multi()).toBe(false);
        toggleRecord(6);
        expect(multi()).toBe(true);
    });

    test("toggling back to one member reads single again", () => {
        selectRecord(5);
        toggleRecord(6);
        toggleRecord(6);
        expect(multi()).toBe(false);
        expect(anySelected()).toBe(true);
    });
});
