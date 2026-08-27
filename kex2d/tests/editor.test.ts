import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    activateStripKf,
    beginConvert,
    clearHover,
    closeContext,
    convertProgress,
    deselectAll,
    dismissNotice,
    editor,
    endConvert,
    enterForceEdit,
    enterTangentEdit,
    fitDone,
    landingG,
    LANDING_MS,
    lockLabel,
    modeChromeSection,
    notify,
    openContext,
    pinRefused,
    solveDone,
    solveFailed,
    type Selection,
    type SelectMode,
    select,
    selectForce,
    selectForces,
    selectNodes,
    selectOneShot,
    selectSection,
    selectStart,
    selectStrip,
    selectStripKf,
    selectStripKfs,
    setMember,
    toggleMember,
    writeHover,
} from "../src/editor";
import { StaleConvert } from "../src/geoforce";

// the selection substrate: a per-kind set + active member, single-select the size-1 case. these are
// pure editor-state tests — the select* APIs touch no ECS (only the SelectionHook does; its
// set-restore-across-recycle lives in history.test.ts). ids here are arbitrary numbers (the set
// stores eids/stable-ids opaquely). clear every kind before each so a leftover can't leak —
// `deselectAll` is the substrate's own one-shot form of the same four-kind clear this file used to
// spell out by hand (`kex2d-event-lane` S4).
beforeEach(() => {
    deselectAll();
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
    // S3: the track-start one-shot is the sixth mutually-exclusive kind (`editor.ts`'s own
    // header comment) — a boolean like `start`, so it gets the same round-trip.
    selectStrip(7);
    expect(editor.start).toBe(false);
    expect(editor.strip).toBe(7);
    selectOneShot(true);
    expect(editor.strips.ids.size).toBe(0);
    expect(editor.strip).toBeNull();
    expect(editor.oneShot).toBe(true);
    select(10);
    expect(editor.start).toBe(false);
    expect(editor.oneShot).toBe(false);
});

test("toggling into a kind while another kind is active switches kinds", () => {
    selectForce(5);
    selectForce(6, "toggle"); // a two-point force set
    select(10, "toggle"); // shift-click a node with forces selected
    expect(editor.forces.ids.size).toBe(0);
    expect([...editor.nodes.ids]).toEqual([10]);
    expect(editor.selection).toBe(10);
});

// ── kex2d-event-lane S4: one selection model — the locked decision's own transition table over
// {segment, span, keyframe, empty-ruler, empty-lane} × {click, modifier-click}, asserting the
// resulting selection set at the pure editor-state substrate every Timeline.svelte handler
// routes through (the DOM-driven twin is `force.pw.ts` "one selection model — the S4 transition
// table", which drives the real pointer over the same rows). "keyframe" is generic here — the
// force and strip-keyframe substrates share the exact same `select*`/`toggle` shape (S3's parity
// law), so one row stands for both; the strip-keyframe-specific multiselect (this stage's own
// booked ground) gets its own describe block below. ──

describe("one selection model — transition table (segment / span / keyframe)", () => {
    const kinds: Record<
        "segment" | "span" | "keyframe",
        {
            select: (id: number | null, mode?: SelectMode) => void;
            ids: () => Set<number>;
            active: () => number | null;
        }
    > = {
        segment: {
            select: selectSection,
            ids: () => editor.sections.ids,
            active: () => editor.section,
        },
        span: { select: selectStrip, ids: () => editor.strips.ids, active: () => editor.strip },
        keyframe: { select: selectForce, ids: () => editor.forces.ids, active: () => editor.force },
    };

    for (const [name, k] of Object.entries(kinds)) {
        test(`${name}: click replace-selects it, clearing every other kind`, () => {
            // arm every OTHER kind first — the row's own claim is that selecting this kind
            // sweeps them all, not just the one kind the test happens to pick.
            select(1);
            selectForce(2);
            selectSection(3);
            selectStrip(4);
            k.select(9);
            for (const [other, o] of Object.entries(kinds))
                if (other !== name) expect(o.ids().size).toBe(0);
            expect(editor.nodes.ids.size).toBe(0);
            expect(k.active()).toBe(9);
        });

        test(`${name}: modifier-click toggles membership — the sole member out, then back in`, () => {
            k.select(9);
            k.select(9, "toggle");
            expect(k.ids().size).toBe(0);
            expect(k.active()).toBeNull();
            k.select(9, "toggle");
            expect([...k.ids()]).toEqual([9]);
            expect(k.active()).toBe(9);
        });

        test(`${name}: modifier-click on a second id ADDS it, active following the toggled-in member`, () => {
            k.select(9);
            k.select(10, "toggle");
            expect([...k.ids()].sort((a, b) => a - b)).toEqual([9, 10]);
            expect(k.active()).toBe(10);
        });
    }
});

describe("one selection model — empty-ruler / empty-lane deselect", () => {
    test("deselectAll clears every kind and every sub-mode at once", () => {
        select(1);
        select(2, "toggle");
        enterTangentEdit(2);
        deselectAll();
        expect(editor.nodes.ids.size).toBe(0);
        expect(editor.tangentEdit).toBeNull();
        selectForce(3);
        enterForceEdit(3);
        deselectAll();
        expect(editor.forces.ids.size).toBe(0);
        expect(editor.forceEdit).toBeNull();
        expect(editor.forceHandle).toBeNull();
        selectSection(4);
        selectStrip(5);
        selectStripKf(6);
        selectStart(true);
        deselectAll();
        expect(editor.sections.ids.size).toBe(0);
        expect(editor.strips.ids.size).toBe(0);
        expect(editor.stripKfs.ids.size).toBe(0);
        expect(editor.start).toBe(false);
    });

    // the empty-ruler and empty-lane click handlers (`Timeline.svelte` `startScrub`/`bandDown`)
    // both route through this exact call on a plain click, guarded on `!e.shiftKey` at the DOM
    // layer — that guard is the "modifier-click preserves" half; the substrate has nothing left
    // to prove past "a modifier-click is a no-op here", asserted directly.
    test("a modifier-click at the DOM layer is a no-op — deselectAll is simply not called", () => {
        selectSection(1);
        // (the handler's own `if (!e.shiftKey) deselectAll();` — nothing to call here)
        expect(editor.section).toBe(1);
    });
});

// ── strip-keyframe multi-select (S4's booked ground, `kex2d-event-lane` S3 log) — `selectForce`'s
// own shape, generalized onto the strip-keyframe sub-selection layered under strip selection. ──

describe("strip-keyframe multi-select", () => {
    test("replace collapses the set to one member; toggle adds/removes", () => {
        selectStrip(1);
        selectStripKf(10);
        expect([...editor.stripKfs.ids]).toEqual([10]);
        expect(editor.stripKf).toBe(10);
        selectStripKf(20, "toggle");
        expect([...editor.stripKfs.ids].sort((a, b) => a - b)).toEqual([10, 20]);
        expect(editor.stripKf).toBe(20);
        selectStripKf(10, "toggle"); // remove the non-active member
        expect([...editor.stripKfs.ids]).toEqual([20]);
        expect(editor.stripKf).toBe(20); // untouched — the removed member wasn't active
    });

    test("toggling out the active promotes the most-recently-added survivor", () => {
        selectStrip(1);
        selectStripKf(10);
        selectStripKf(20, "toggle");
        selectStripKf(20, "toggle"); // remove the active member
        expect([...editor.stripKfs.ids]).toEqual([10]);
        expect(editor.stripKf).toBe(10);
    });

    test("activateStripKf promotes a member active without disturbing the set; a non-member is a no-op", () => {
        selectStrip(1);
        selectStripKf(10);
        selectStripKf(20, "toggle"); // {10, 20}, active 20
        activateStripKf(10);
        expect([...editor.stripKfs.ids].sort((a, b) => a - b)).toEqual([10, 20]); // set unchanged
        expect(editor.stripKf).toBe(10); // promoted
        activateStripKf(99); // not a member
        expect(editor.stripKf).toBe(10); // unchanged
    });

    test("deselecting the owning strip clears the keyframe set (the sub-selection's own invariant)", () => {
        selectStrip(1);
        selectStripKf(10);
        selectStripKf(20, "toggle");
        selectStrip(null);
        expect(editor.stripKfs.ids.size).toBe(0);
        expect(editor.stripKf).toBeNull();
    });

    test("selecting a different top-level kind sweeps the strip-keyframe set (the same exclusivity every other sub-selection observes)", () => {
        selectStrip(1);
        selectStripKf(10);
        selectStripKf(20, "toggle");
        selectSection(5);
        expect(editor.stripKfs.ids.size).toBe(0);
    });

    // ── S9 (F7, finding (b)): the two selection containers are disjoint and nothing cleared
    // across them — `exclusiveForce` already swept `stripKfs`, but `selectStripKf` called no
    // exclusive sweep of its own. Pure-function pin of `exclusiveStripKf`, both directions —
    // the round-2 standard's own required capture arm (marquee/click cross-clear, both
    // directions) lives in `harness/section.pw.ts`, driven through the real production
    // handler; this is the legitimate unit-level pin of the shared helper the S1 seam law
    // allows alongside it.
    //
    // MEASURED, NOT ASSUMED (S9's own open question): `exclusiveStripKf()`'s `clearSel
    // (editor.forces)` call is UNREACHABLE through ANY current production entry point, not
    // just `keyframeDown`'s click path — `forces` is only ever populated through
    // `selectForce`/`selectForces`, both of which route through `exclusiveForce`, which
    // already clears `strips`; `forces` non-empty therefore implies `editor.strip === null`,
    // which empties the strip-keyframe candidate pool (`kfDesc("strip").pts`, filtered on
    // `k.strip === editor.strip`) that `keyframeDown`'s click path and `marqueeUp`'s rubber-
    // band alike draw `selectStripKf`/`selectStripKfs` calls from — so neither production path
    // can ever reach `selectStripKf` with a non-empty `forces` set. This unit test calls
    // `selectStripKf` DIRECTLY (never through a production entry point), so it drives a state
    // production cannot reach today; it stays as a pin of `exclusiveStripKf()`'s own declared-
    // parity mechanism, not as evidence about a live path. ──
    test("selecting a strip keyframe clears the force selection (S9, F7 finding b — pins a state production cannot reach; see comment above)", () => {
        selectForce(99);
        expect(editor.force).toBe(99);
        selectStripKf(10);
        expect(editor.force).toBeNull(); // was left selected before S9
        expect(editor.stripKf).toBe(10);
    });

    test("selecting a force keyframe clears the strip-keyframe selection (the reverse already held)", () => {
        selectStrip(1);
        selectStripKf(10);
        expect(editor.stripKf).toBe(10);
        selectForce(99);
        expect(editor.stripKf).toBeNull();
        expect(editor.force).toBe(99);
    });

    // Like the finding-(b) arm above, this drives `selectStripKfs` with a non-empty `forces`
    // set directly — a state no production entry point can reach today (`forces` non-empty
    // implies `editor.strip === null`, which empties `marqueeUp`'s own strip-keyframe
    // candidate pool too), so it pins `exclusiveStripKf()`'s declared-parity sweep rather than
    // a live marquee outcome.
    test("selectStripKfs (the marquee multi-write) sweeps the other kinds like selectForces does", () => {
        selectForce(99);
        selectStripKfs([10, 20], 20);
        expect([...editor.stripKfs.ids].sort((a, b) => a - b)).toEqual([10, 20]);
        expect(editor.stripKf).toBe(20);
        expect(editor.force).toBeNull();
    });
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

// BLOCKER 2: selectNodes([])/selectForces([]) must exit tangent-edit / force-edit — the
// shrink-to-zero case (a shift+marquee that toggles the last member off). the length guards
// on the reconcile calls skipped the exit when `ids` was empty, leaving a sub-mode live on a
// deselected subject. these arms red at 47f456d (tangentEdit/forceEdit stays set) and green
// after the guards are dropped.
test("selectNodes([]) exits tangent-edit (shrink-to-zero)", () => {
    select(10);
    enterTangentEdit(10);
    expect(editor.tangentEdit).toBe(10);
    selectNodes([], null);
    expect(editor.nodes.ids.size).toBe(0);
    expect(editor.tangentEdit).toBeNull();
});

test("selectForces([]) exits force-edit (shrink-to-zero)", () => {
    selectForce(5);
    enterForceEdit(5);
    expect(editor.forceEdit).toBe(5);
    selectForces([], null);
    expect(editor.forces.ids.size).toBe(0);
    expect(editor.forceEdit).toBeNull();
});

// ── section context menu: promote-vs-replace on right-click (mirrors openNodeMenu/openForceMenu) ──

test("openContext on a member of a multi-set promotes it active, keeping the whole set", () => {
    selectSection(1);
    selectSection(2, "toggle");
    selectSection(3, "toggle"); // a shift-click set {1,2,3}, active 3
    openContext(50, 60, 1); // right-click a non-active MEMBER
    expect([...editor.sections.ids].sort((a, b) => a - b)).toEqual([1, 2, 3]); // set preserved
    expect(editor.sections.active).toBe(1); // promoted, not replaced
    expect(editor.context).toEqual({ x: 50, y: 60, section: 1, cut: null, cutSurface: false });
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

// ── the paced landing's display interpolation (`landingG`) + the refusal mapping ──
// kex2d-optimize-mode stage 5: the landing animation IS the feedback (the Δg toast is gone) —
// the interpolation is the one cosmetic display override, so its edges are pinned here.

test("landingG: interpolates a covered key from `from` toward `to`, ease-out, and expires to null", () => {
    const landing = { start: 1000, section: 0, moves: [{ id: 7, from: 1, to: 2 }] };
    expect(landingG(landing, 7, 1000)).toBe(1); // t = 0: the pre-solve draft value
    const mid = landingG(landing, 7, 1000 + LANDING_MS / 2);
    if (mid === null) throw new Error("mid-animation read expired");
    expect(mid).toBeGreaterThan(1.5); // ease-OUT: past the halfway value at half time
    expect(mid).toBeLessThan(2);
    expect(landingG(landing, 7, 1000 + LANDING_MS)).toBeNull(); // expiry → the document's own value
});

test("landingG: an uncovered key reads null (only moved keys animate)", () => {
    const landing = { start: 0, section: 0, moves: [{ id: 7, from: 1, to: 2 }] };
    expect(landingG(landing, 8, 100)).toBeNull();
});

// ── the modal-chrome predicate (`modeChromeSection`, kex2d-idioms stage 8) ──
// the landing is the mode's exit transition: the panel, dim wash, and subject hatch key on
// this one predicate (pinning ∥ landing) so the modal presentation holds through the
// window and releases in ONE moment — chrome only, never a second mode state (enablement
// keeps reading `editor.pinning`).

test("modeChromeSection: null at rest, the session's section in-mode, the landing's through the window", () => {
    expect(modeChromeSection()).toBeNull();
    editor.pinning = {
        section: 3,
        stamp: { x: 0, y: 0, theta: 0, v: 10 },
        ghost: { x: new Float32Array(0), y: new Float32Array(0) },
        freeze: { x: 0, y: 0, theta: 0, v: 10 },
    };
    expect(modeChromeSection()).toBe(3); // the live mode
    editor.pinning = null;
    editor.landing = { start: 0, section: 3, moves: [{ id: 1, from: 0, to: 1 }] };
    expect(modeChromeSection()).toBe(3); // the exit transition holds the chrome
    editor.landing = null;
    expect(modeChromeSection()).toBeNull(); // one release moment — skip and expiry alike
});

// ── the keyframe menu's Lock/Unlock row (`lockLabel`, kex2d stage 6) ──
// mode-scoped existence: the row is OMITTED (null) outside pin mode and on any section other
// than the pinning one (lock doesn't exist there — omit, not gray); inside, the label mirrors
// the `Q` toggle's semantics (all locked → Unlock, else Lock).

test("lockLabel: hidden outside the mode, on other sections, and on an empty set", () => {
    const session = {
        section: 7,
        stamp: { x: 0, y: 0, theta: 0, v: 10 },
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
        stamp: { x: 0, y: 0, theta: 0, v: 10 },
        ghost: { x: new Float32Array(0), y: new Float32Array(0) },
        freeze: { x: 0, y: 0, theta: 0, v: 10 },
    };
    expect(lockLabel(session, 7, [1, 2], new Set())).toBe("Lock"); // none locked
    expect(lockLabel(session, 7, [1, 2], new Set([1]))).toBe("Lock"); // mixed → lock the rest
    expect(lockLabel(session, 7, [1, 2], new Set([1, 2]))).toBe("Unlock"); // all locked
});

test("pinRefused: one TERSE sentence per refusal class, taxonomy distinguishable", () => {
    // stage-7 fourth check-in: no "Nothing changed" padding (the sandbox guarantees it); the
    // three unreachable certificates stay distinct from did-not-converge.
    expect(pinRefused("unreachable", "stall")).toBe("The draft stalls before the exit.");
    expect(pinRefused("unreachable", "conditioning")).toBe("The free keys can't steer the exit.");
    expect(pinRefused("unreachable", "free-count")).toBe("Fewer than 3 free keys.");
    expect(pinRefused("diverged")).toBe("Failed to converge.");
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
