import { beforeEach, expect, test } from "bun:test";
import {
    beginConvert,
    closeContext,
    convertProgress,
    dismissNotice,
    editor,
    endConvert,
    enterForceEdit,
    enterTangentEdit,
    fitDone,
    landingG,
    LANDING_MS,
    lockLabel,
    notify,
    openContext,
    optimizeRefused,
    solveDone,
    solveFailed,
    type Selection,
    select,
    selectForce,
    selectForces,
    selectNodes,
    selectSection,
    selectStart,
    setMember,
    toggleMember,
} from "../src/editor";
import { StaleConvert } from "../src/geoforce";

// the selection substrate: a per-kind set + active member, single-select the size-1 case. these are
// pure editor-state tests — the select* APIs touch no ECS (only the SelectionHook does; its
// set-restore-across-recycle lives in history.test.ts). ids here are arbitrary numbers (the set
// stores eids/stable-ids opaquely). clear every kind before each so a leftover can't leak.
beforeEach(() => {
    select(null);
    selectForce(null);
    selectSection(null);
    selectStart(false);
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

test("replace select collapses the node kind to one active member", () => {
    select(10);
    expect([...editor.nodes.ids]).toEqual([10]);
    expect(editor.selection).toBe(10); // the scalar accessor reads the active member
    select(20);
    expect([...editor.nodes.ids]).toEqual([20]);
    expect(editor.selection).toBe(20);
    select(null);
    expect(editor.nodes.ids.size).toBe(0);
    expect(editor.selection).toBeNull();
});

test("the scalar setter is a replace-select", () => {
    editor.selection = 42;
    expect([...editor.nodes.ids]).toEqual([42]);
    expect(editor.nodes.active).toBe(42);
    editor.force = 7; // switches kinds
    expect(editor.nodes.ids.size).toBe(0);
    expect([...editor.forces.ids]).toEqual([7]);
});

// ── toggle (shift-click) ──

test("toggle builds a node set, active following the last toggled-in member", () => {
    select(10); // replace baseline
    select(20, "toggle");
    select(30, "toggle");
    expect([...editor.nodes.ids]).toEqual([10, 20, 30]);
    expect(editor.selection).toBe(30);
    select(20, "toggle"); // remove a non-active member
    expect([...editor.nodes.ids]).toEqual([10, 30]);
    expect(editor.selection).toBe(30);
    select(30, "toggle"); // remove the active → promote the survivor
    expect([...editor.nodes.ids]).toEqual([10]);
    expect(editor.selection).toBe(10);
});

test("toggling out the active with ≥2 survivors promotes the last-inserted one, not the oldest", () => {
    select(1); // {1}
    select(2, "toggle"); // {1,2}
    select(3, "toggle"); // {1,2,3}, active 3
    expect(editor.selection).toBe(3);
    select(3, "toggle"); // remove the active while TWO survivors {1,2} remain
    expect([...editor.nodes.ids]).toEqual([1, 2]);
    expect(editor.selection).toBe(2); // the last-inserted survivor — a regression to order 1 would pass every ≤1-survivor test
});

// ── set appliers (the marquee's atomic write: one merged hit set + its active, written in one go) ──

test("selectNodes writes a whole set and re-anchors the active", () => {
    selectNodes([10, 20, 30], 20);
    expect([...editor.nodes.ids]).toEqual([10, 20, 30]);
    expect(editor.selection).toBe(20); // the caller's active, not the last member
});

test("selectNodes falls back to the last-inserted member when the given active isn't in the set", () => {
    selectNodes([10, 20, 30], 99); // 99 was never a member (a dropped/stale active)
    expect(editor.selection).toBe(30);
    selectNodes([10, 20], null);
    expect(editor.selection).toBe(20);
});

test("a non-empty set applier sweeps the other kinds; an empty one clears only its own", () => {
    selectSection(3);
    selectNodes([10, 20], 10);
    expect(editor.sections.ids.size).toBe(0); // swept
    expect([...editor.nodes.ids]).toEqual([10, 20]);

    // an empty write is the marquee's "hit nothing" case: it clears the node kind alone, leaving
    // the full deselect (the other kinds + START) to the caller, matching empty-click.
    selectSection(3);
    select(10, "toggle"); // node kind again, sections swept
    selectSection(3, "toggle"); // …and back to sections, so a stale kind exists to observe
    selectNodes([], null);
    expect(editor.nodes.ids.size).toBe(0);
    expect([...editor.sections.ids]).toEqual([3]); // untouched — the caller owns the rest
});

test("a set applier that grows past a sub-mode's subject drops the sub-mode", () => {
    select(10);
    enterTangentEdit(10);
    selectNodes([10, 20], 20);
    expect(editor.tangentEdit).toBeNull();

    selectForce(5);
    enterForceEdit(5);
    selectForces([5, 6], 6);
    expect(editor.forceEdit).toBeNull();
    expect(editor.forceHandle).toBeNull();
});

test("selectForces writes the force set and sweeps the other kinds", () => {
    select(10);
    selectForces([5, 6, 7], 6);
    expect(editor.nodes.ids.size).toBe(0);
    expect([...editor.forces.ids]).toEqual([5, 6, 7]);
    expect(editor.force).toBe(6);
});

// ── kind exclusivity ──

test("selecting into one kind clears the others (a multi-member set included)", () => {
    select(10);
    select(11, "toggle"); // a two-node set
    selectForce(5); // switch to the force kind
    expect(editor.nodes.ids.size).toBe(0);
    expect(editor.selection).toBeNull();
    expect([...editor.forces.ids]).toEqual([5]);
    selectSection(3);
    expect(editor.forces.ids.size).toBe(0);
    expect([...editor.sections.ids]).toEqual([3]);
    selectStart(true);
    expect(editor.sections.ids.size).toBe(0);
    expect(editor.start).toBe(true);
    select(10);
    expect(editor.start).toBe(false);
});

test("toggling into a kind while another kind is active switches kinds", () => {
    selectForce(5);
    selectForce(6, "toggle"); // a two-point force set
    select(10, "toggle"); // shift-click a node with forces selected
    expect(editor.forces.ids.size).toBe(0);
    expect([...editor.nodes.ids]).toEqual([10]);
    expect(editor.selection).toBe(10);
});

// ── sub-mode collapse ──

test("entering tangent edit collapses a multi-node set to its subject", () => {
    select(10);
    select(20, "toggle");
    select(30, "toggle"); // a three-node set
    enterTangentEdit(20);
    expect([...editor.nodes.ids]).toEqual([20]);
    expect(editor.selection).toBe(20);
    expect(editor.tangentEdit).toBe(20);
});

test("growing the node set past the tangent-edit subject exits the sub-mode", () => {
    select(10);
    enterTangentEdit(10);
    expect(editor.tangentEdit).toBe(10);
    select(20, "toggle"); // the set grows to two → the single-subject sub-mode drops
    expect(editor.tangentEdit).toBeNull();
    expect([...editor.nodes.ids]).toEqual([10, 20]);
});

test("re-selecting the tangent-edit subject alone keeps the sub-mode", () => {
    select(10);
    enterTangentEdit(10);
    select(10); // replace-select the same sole node
    expect(editor.tangentEdit).toBe(10);
});

test("entering force handle-edit collapses a multi-point set to its subject", () => {
    selectForce(5);
    selectForce(6, "toggle");
    enterForceEdit(6);
    expect([...editor.forces.ids]).toEqual([6]);
    expect(editor.force).toBe(6);
    expect(editor.forceEdit).toBe(6);
});

// ── section context menu: promote-vs-replace on right-click (mirrors openNodeMenu/openForceMenu) ──

test("openContext on a member of a multi-set promotes it active, keeping the whole set", () => {
    selectSection(1);
    selectSection(2, "toggle");
    selectSection(3, "toggle"); // a shift-click set {1,2,3}, active 3
    openContext(50, 60, 1); // right-click a non-active MEMBER
    expect([...editor.sections.ids].sort((a, b) => a - b)).toEqual([1, 2, 3]); // set preserved
    expect(editor.sections.active).toBe(1); // promoted, not replaced
    expect(editor.context).toEqual({ x: 50, y: 60, section: 1 });
    closeContext();
    expect(editor.context).toBeNull();
});

test("openContext outside the set replace-selects just the target (today's single-select)", () => {
    selectSection(1);
    selectSection(2, "toggle"); // a set {1,2}
    openContext(10, 20, 9); // right-click a section NOT in the set
    expect([...editor.sections.ids]).toEqual([9]); // replaced, not kept
    expect(editor.sections.active).toBe(9);
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

test("a converged convert reads as a short confirmation — the count, nothing else", () => {
    // it held its budget, so the numbers say only "it worked"; the key count is what the author
    // now edits. Anything past that is noise the readout doesn't earn.
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

test("a stale answer reads as its own plain sentence, with the internals kept for the console", () => {
    // pinned against the REAL class: the mapping matches it by `name` (importing it would pull the
    // conversion tier onto editor.ts's graph), so this is what keeps the two in step.
    const { notice, detail } = solveFailed(new StaleConvert(3), false);
    expect(notice).toEqual({
        kind: "error",
        text: "The track changed while the solve ran. Nothing changed.",
    });
    expect(detail).toContain("section 3 changed during the solve"); // the raw message, for us
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

test("a converged fit reads as a short confirmation — the node count, nothing else", () => {
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

// ── the paced landing's display interpolation (`landingG`) + the refusal mapping ──
// kex2d-optimize-mode stage 5: the landing animation IS the feedback (the Δg toast is gone) —
// the interpolation is the one cosmetic display override, so its edges are pinned here.

test("landingG: interpolates a covered key from `from` toward `to`, ease-out, and expires to null", () => {
    const landing = { start: 1000, moves: [{ id: 7, from: 1, to: 2 }] };
    expect(landingG(landing, 7, 1000)).toBe(1); // t = 0: the pre-solve draft value
    const mid = landingG(landing, 7, 1000 + LANDING_MS / 2);
    if (mid === null) throw new Error("mid-animation read expired");
    expect(mid).toBeGreaterThan(1.5); // ease-OUT: past the halfway value at half time
    expect(mid).toBeLessThan(2);
    expect(landingG(landing, 7, 1000 + LANDING_MS)).toBeNull(); // expiry → the document's own value
});

test("landingG: an uncovered key reads null (only moved keys animate)", () => {
    const landing = { start: 0, moves: [{ id: 7, from: 1, to: 2 }] };
    expect(landingG(landing, 8, 100)).toBeNull();
});

// ── the keyframe menu's Lock/Unlock row (`lockLabel`, kex2d stage 6) ──
// mode-scoped existence: the row is OMITTED (null) outside optimize mode and on any section other
// than the optimizing one (lock doesn't exist there — omit, not gray); inside, the label mirrors
// the `Q` toggle's semantics (all locked → Unlock, else Lock).

test("lockLabel: hidden outside the mode, on other sections, and on an empty set", () => {
    const session = {
        section: 7,
        stamp: { x: 0, y: 0, theta: 0 },
        ghost: { x: new Float32Array(0), y: new Float32Array(0) },
        freeze: { x: 0, y: 0, theta: 0, v: 10 },
    };
    expect(lockLabel(null, 7, [1, 2], new Set())).toBeNull(); // no mode → no row
    expect(lockLabel(session, 3, [1, 2], new Set())).toBeNull(); // another section → no row
    expect(lockLabel(session, 7, [], new Set())).toBeNull(); // nothing selected → no row
});

test("lockLabel: toggle semantics — all-locked offers Unlock, anything else Lock", () => {
    const session = {
        section: 7,
        stamp: { x: 0, y: 0, theta: 0 },
        ghost: { x: new Float32Array(0), y: new Float32Array(0) },
        freeze: { x: 0, y: 0, theta: 0, v: 10 },
    };
    expect(lockLabel(session, 7, [1, 2], new Set())).toBe("Lock"); // none locked
    expect(lockLabel(session, 7, [1, 2], new Set([1]))).toBe("Lock"); // mixed → lock the rest
    expect(lockLabel(session, 7, [1, 2], new Set([1, 2]))).toBe("Unlock"); // all locked
});

test("optimizeRefused: one plain sentence per refusal class", () => {
    expect(optimizeRefused("unreachable", "stall")).toBe(
        "The draft stalls before the exit. Nothing changed.",
    );
    expect(optimizeRefused("unreachable", "conditioning")).toBe(
        "The free keys can't steer the exit from here. Nothing changed.",
    );
    expect(optimizeRefused("unreachable", "free-count")).toBe(
        "Fewer than 3 free keys — nothing to solve.",
    );
    expect(optimizeRefused("diverged")).toBe("The solve did not converge. Nothing changed.");
});
