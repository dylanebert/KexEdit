import { State } from "@dylanebert/shallot";
import { beforeEach, describe, expect, test } from "bun:test";
import {
    beginLanding,
    beginPin,
    editor,
    endPin,
    modeChromeSection,
    sandbox,
    skipLanding,
    toggleLockedSet,
} from "../src/editor";
import { beginForceMove, commit, createHistory, redo, undo } from "../src/history";
import { liveOptimizeWorkers } from "../src/optimize-async";
import {
    enterPin,
    enterPinMode,
    exitPinMode,
    redoRouted,
    runPinSection,
    StalePin,
    undoRouted,
} from "../src/pin";
import {
    BakeSystem,
    bakeOut,
    createForcePoint,
    createSection,
    createStrip,
    createTrack,
    samples,
    sectionForces,
    sectionInfo,
    type SectionSnapshot,
    SectionKind,
    setForcePoint,
    setTrackFriction,
    setTrackResistance,
    setTrackV0,
    snapshotAll,
    stripsForStep,
} from "../src/track";
import { resolveStep } from "../src/profile";

// Pin mode's document seam (`pin.ts`) over the real ECS + history substrate: the sandbox
// contract, the landing, the downstream freeze, and the paced landing's display override. The
// masked exit-restore KERNEL the mode invokes is a separate unit — `tests/optimize.test.ts`.

function forceTrack(coeffs?: { friction: number; resistance: number }): {
    state: State;
    eid: number;
    sec: number;
} {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setTrackV0(eid, 20);
    if (coeffs) {
        setTrackFriction(eid, coeffs.friction);
        setTrackResistance(eid, coeffs.resistance);
    }
    const sec = createSection(state, 0, SectionKind.Force, 40);
    createForcePoint(state, sec, 0, 1);
    createForcePoint(state, sec, 10, 1.5);
    createForcePoint(state, sec, 20, 1);
    createForcePoint(state, sec, 30, 0.8);
    createForcePoint(state, sec, 40, 1);
    state.step(0);
    return { state, eid, sec };
}

function docState(state: State, eid: number): { snap: SectionSnapshot[]; hash: string } {
    return { snap: snapshotAll(state), hash: bakeOut.get(eid)?.hash ?? "" };
}

describe("runPinSection — the document seam", () => {
    test("enterPin stamps the section's current exit and freezes a ghost", () => {
        const { state, sec } = forceTrack();
        const session = enterPin(state, sec);
        expect(session).not.toBeNull();
        if (!session) return;
        expect(session.section).toBe(sec);
        expect(Number.isFinite(session.stamp.x)).toBe(true);
        expect(session.ghost.x.length).toBeGreaterThan(0);
        endPin(); // never opened via beginPin; just clearing any stray state
    });

    test("a solve lands atomically and undo restores the section byte-identical", async () => {
        const { state, sec } = forceTrack();
        // the mode must actually be OPEN: a landing is only valid for the open session (the
        // review-A invariant), so the bare enterPin-without-beginPin calling shape
        // this test once used is now rejected by design.
        if (!enterPinMode(state, sec)) throw new Error("no session");
        const session = editor.pinning;
        if (!session) throw new Error("no session");

        // the author bumps an interior key, locking the first and last (the endpoints stay
        // exactly authored while the interior free keys absorb the correction).
        const rows = sectionForces(state, sec);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.6);
        state.step(0); // rebake the edit so the section has a live bake to solve against
        const locked = new Set([rows[0].id, rows[4].id]);

        const h = createHistory();
        const result = await runPinSection(h, state, session, locked);
        expect(result.outcome).toBe("solved");
        expect(liveOptimizeWorkers()).toBe(0); // the one-shot worker settled with its answer
        state.step(0);

        // the locked endpoints' g are exactly what they were before the solve landed.
        const after = sectionForces(state, sec);
        expect(after.find((r) => r.id === rows[0].id)?.g).toBe(rows[0].g);
        expect(after.find((r) => r.id === rows[4].id)?.g).toBe(rows[4].g);

        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        // undo restores the PRE-SOLVE state, i.e. the author's edited-but-unsolved draft —
        // which itself differs from `before` (the interior key's bump is real authored state
        // from BEFORE the solve ran, never rolled back by undoing the solve alone). the landing
        // entry also carries the mode transition, so this undo RE-ENTERS the mode.
        const rowsAfterUndo = sectionForces(state, sec);
        expect(rowsAfterUndo.find((r) => r.s === rows[2].s)?.g).toBe(rows[2].g + 0.6);
        expect(editor.pinning).not.toBeNull();
        endPin();
    });

    // `sectionSpec` (`pin.ts`) reads the track's own authored
    // `friction`/`resistance` and threads them into `enterPin`'s stamp — RED FIRST (seen failing
    // pre-wiring: the stamp read the kernel's own μ = c = 0 default regardless of the track's
    // authored coefficients, so this equality held for every track). A discriminating check, not
    // a smoke test: the same section on a zero-coefficient track and a real-coefficient track
    // must stamp DIFFERENT exits, or the wiring below (injection === 0) can't tell "friction
    // reached the solve" from "friction was silently dropped and both sides agree at 0 anyway".
    test("enterPin's stamp reads the track's own authored friction/drag, not the kernel default", () => {
        skipLanding(); // clear a prior test's still-live paced landing, same as `endPin()` above
        // one track, not two: `bakeOut`'s live-bake map is keyed by entity id, and two
        // independent `State()`s each start their own id counter at 0, so two separate tracks
        // would collide in that shared map. Reading the SAME track's stamp before and after
        // authoring its coefficients sidesteps that entirely.
        const { state, eid, sec } = forceTrack();
        const zeroStamp = enterPin(state, sec)?.stamp;
        if (!zeroStamp) throw new Error("no session");
        setTrackFriction(eid, 0.021);
        setTrackResistance(eid, 2.5e-4);
        state.step(0);
        const nonzeroStamp = enterPin(state, sec)?.stamp;
        if (!nonzeroStamp) throw new Error("no session");
        expect(nonzeroStamp.v).not.toBe(zeroStamp.v);
        expect(nonzeroStamp.y).not.toBe(zeroStamp.y);
    });

    // A non-stalling section under the locked-decision defaults still solves cleanly and lands no
    // injection — the pin consequence (`kex2d-map.md`): exit `v` is a derived output of the
    // landed path, never a constraint row, so a real μ/c on a smooth march changes nothing about
    // the mode's own acceptance.
    test("a pin solve on a track with authored friction/drag lands within tol at injection 0", async () => {
        const { state, sec } = forceTrack({ friction: 0.021, resistance: 2.5e-4 });
        if (!enterPinMode(state, sec)) throw new Error("no session");
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        const rows = sectionForces(state, sec);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.6);
        state.step(0);
        const locked = new Set([rows[0].id, rows[4].id]);
        const h = createHistory();
        const result = await runPinSection(h, state, session, locked);
        expect(result.outcome).toBe("solved");
        expect(result.injection).toBe(0);
        endPin();
    });

    test("Solve on an already-restored draft writes nothing, but still lands the mode close", async () => {
        // stage-5 rewrite of the old "no undo entry" idempotence pin: under the sandbox contract a
        // landed Solve IS the mode close, so even a zero-drift solve records exactly one entry —
        // the transition — while the document stays byte-identical (the `deltaG !== 0` filter
        // still keeps every write out). idempotence holds trivially: the mode closed, so there
        // is no second press. seen failing (doc hash diff) with the write filter removed.
        const { state, eid, sec } = forceTrack();
        if (!enterPinMode(state, sec)) throw new Error("no session");
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        const before = docState(state, eid);

        const h = createHistory();
        const result = await runPinSection(h, state, session, new Set());
        expect(result.outcome).toBe("solved");
        expect(result.deltaG.every((d) => d === 0)).toBe(true);

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(1); // the mode-close transition, nothing else
        undo(h, state);
        state.step(0);
        expect(docState(state, eid)).toEqual(before); // undoing it changes no document byte
        expect(editor.pinning).not.toBeNull(); // …but re-enters the mode
        endPin();
    });

    test("a cancelled solve leaves the track byte-identical", async () => {
        const { state, eid, sec } = forceTrack();
        const session = enterPin(state, sec);
        if (!session) throw new Error("no session");
        const rows = sectionForces(state, sec);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.6);
        state.step(0); // rebake the edit before capturing the "before" the cancel must preserve
        const before = docState(state, eid);

        const h = createHistory();
        const controller = new AbortController();
        const run = runPinSection(h, state, session, new Set(), { signal: controller.signal });
        controller.abort(new Error("cancelled"));
        await expect(run).rejects.toThrow();

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
        expect(liveOptimizeWorkers()).toBe(0); // cancellation is worker termination — no leak
    });

    test("a document change during the solve rejects as StalePin and writes nothing", async () => {
        const { state, eid, sec } = forceTrack();
        const session = enterPin(state, sec);
        if (!session) throw new Error("no session");
        const before = docState(state, eid);
        const h = createHistory();

        const run = runPinSection(h, state, session, new Set());
        // mutate the document while the (real, off-thread) solve is in flight.
        const rows = sectionForces(state, sec);
        setForcePoint(state, rows[1].id, rows[1].s, rows[1].g + 0.2);

        let threw: unknown;
        try {
            await run;
        } catch (e) {
            threw = e;
        }
        expect(threw).toBeInstanceOf(StalePin);
        // the only extra change on the document is the mutation this test itself made —
        // the solve wrote nothing else.
        state.step(0);
        const after = docState(state, eid);
        expect(after.snap).not.toEqual(before.snap); // our own edit is there
        expect(h.undo).toHaveLength(0); // but the solve recorded nothing
    });
});

describe("editor.ts — pin mode + lock toggling", () => {
    test("beginPin/endPin + lock toggling round-trip", () => {
        const { state, sec } = forceTrack();
        const session = enterPin(state, sec);
        if (!session) throw new Error("no session");
        beginPin(session);
        expect(editor.pinning).not.toBeNull();
        expect(editor.locked.size).toBe(0);

        toggleLockedSet([1, 2]);
        expect(editor.locked.has(1)).toBe(true);
        expect(editor.locked.has(2)).toBe(true);
        toggleLockedSet([1, 2]); // all locked -> unlock all
        expect(editor.locked.size).toBe(0);

        endPin();
        expect(editor.pinning).toBeNull();
        expect(editor.locked.size).toBe(0);
    });
});

describe("the sandbox (kex2d-optimize-mode stage 7)", () => {
    // the sandbox contract over the real document + history substrate, orchestrated exactly the
    // way the app does: enter = `enterPinMode` (opens the sandbox — nothing lands outer),
    // in-mode edits record into the sandbox (the `redirectHistory` seam — call sites still pass
    // the OUTER history, which is the point), undo/redo route through
    // `undoRouted`/`redoRouted`, Exit = `exitPinMode` (discard, no trace), a landed Solve =
    // ONE outer entry carrying the frozen experiment. red-first evidence is by mutation probes
    // (the API changed shape, so the stage-6 build can't run these): each load-bearing guard —
    // the record redirect, the exit revert loop, undo-at-start-exits, the landing's sandbox
    // restore, the resumed re-land fall-through — was broken in turn and its pins seen failing
    // for that reason (readings in the working log).

    // failure isolation: a test that dies mid-mode must not strand the NEXT test's entry
    // (enterPinMode refuses while a mode is open, cascading unrelated failures).
    beforeEach(() => {
        if (editor.pinning !== null) endPin();
    });

    // one in-mode edit through the normal idiom (the drag gesture's bracket). deliberately
    // passed the OUTER history — the redirect must route it into the sandbox.
    function bump(h: ReturnType<typeof createHistory>, state: State, sec: number): void {
        const rows = sectionForces(state, sec);
        beginForceMove(state, rows[2].id);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.6);
        commit(h);
        state.step(0);
    }

    test("entering touches outer history not at all; in-mode edits land in the SANDBOX", () => {
        const { state, sec } = forceTrack();
        const h = createHistory();
        bump(h, state, sec); // pre-mode: a normal outer entry
        expect(h.undo).toHaveLength(1);

        expect(enterPinMode(state, sec)).toBe(true);
        expect(h.undo).toHaveLength(1); // entry records NOTHING outer
        expect(sandbox()).not.toBeNull();
        expect(sandbox()?.undo).toHaveLength(0);

        bump(h, state, sec); // called with the OUTER history — the redirect routes it
        expect(h.undo).toHaveLength(1); // outer untouched
        expect(sandbox()?.undo).toHaveLength(1); // the sandbox took it
        exitPinMode(state);
    });

    test("in-mode undo/redo operate over the sandbox only; undo at the start EXITS; pre-mode stays applied", () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        bump(h, state, sec); // pre-mode edit (crest +0.6)
        const preEntry = docState(state, eid);

        enterPinMode(state, sec);
        bump(h, state, sec); // in-mode edit (crest +1.2 now)
        const edited = docState(state, eid);
        expect(edited).not.toEqual(preEntry);

        undoRouted(h, state); // reverts the in-mode edit — sandbox scope, mode stays open
        state.step(0);
        expect(docState(state, eid)).toEqual(preEntry);
        expect(editor.pinning).not.toBeNull();
        expect(h.undo).toHaveLength(1); // the pre-mode edit was NOT popped (unreachable inside)

        redoRouted(h, state); // the in-mode edit replays — sandbox scope
        state.step(0);
        expect(docState(state, eid)).toEqual(edited);
        undoRouted(h, state); // back off again

        undoRouted(h, state); // at the sandbox's start: acts as EXIT
        state.step(0);
        expect(editor.pinning).toBeNull();
        expect(docState(state, eid)).toEqual(preEntry); // the pre-mode edit still applied
        expect(h.undo).toHaveLength(1);
        expect(h.redo).toHaveLength(0); // …and no trace on the outer redo

        undoRouted(h, state); // mode closed — the outer path works again
        state.step(0);
        expect(docState(state, eid)).not.toEqual(preEntry); // the pre-mode edit undone now
    });

    test("Exit discards without trace: outer undo AND redo byte-identical, pre-mode redo survives", () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        bump(h, state, sec);
        undo(h, state); // → a live pre-mode redo branch
        state.step(0);
        expect(h.redo).toHaveLength(1);
        const preEntry = docState(state, eid);

        enterPinMode(state, sec);
        expect(h.redo).toHaveLength(1); // entry does NOT clear the outer redo (no outer record)
        bump(h, state, sec);
        bump(h, state, sec);
        exitPinMode(state);
        state.step(0);

        expect(editor.pinning).toBeNull();
        expect(docState(state, eid)).toEqual(preEntry); // every in-mode edit reverted
        expect(h.undo).toHaveLength(0);
        expect(h.redo).toHaveLength(1); // the pre-mode redo branch survived untouched
        redo(h, state); // …and still replays
        state.step(0);
        expect(docState(state, eid)).not.toEqual(preEntry);
    });

    test("Solve = ONE outer entry; undo REOPENS with the experiment resumed; redo re-lands and closes", async () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        const preEntry = docState(state, eid);

        enterPinMode(state, sec);
        bump(h, state, sec); // edit 1
        bump(h, state, sec); // edit 2
        undoRouted(h, state); // edit 2 undone in-mode — it sits on the SANDBOX redo
        state.step(0);
        const draft = docState(state, eid); // edit 1 applied, edit 2 undone
        const rows = sectionForces(state, sec);
        editor.locked = new Set([rows[0].id]);

        const session = editor.pinning;
        if (!session) throw new Error("no session");
        const result = await runPinSection(h, state, session, editor.locked);
        expect(result.outcome).toBe("solved");
        expect(editor.pinning).toBeNull(); // Solve confirmed AND closed
        state.step(0);
        const landed = docState(state, eid);
        expect(h.undo).toHaveLength(1); // ONE outer entry — the whole experiment
        expect(sandbox()).toBeNull();

        undoRouted(h, state); // undo the landing: the experiment RESUMES
        state.step(0);
        expect(editor.pinning).not.toBeNull();
        expect(docState(state, eid)).toEqual(draft); // the edited-but-unsolved draft
        expect(editor.locked.size).toBe(1); // locks restored
        expect(sandbox()?.undo).toHaveLength(1); // edit 1 undoable again…
        expect(sandbox()?.redo).toHaveLength(1); // …and edit 2 still REDOABLE (full resume)

        redoRouted(h, state); // redo inside the resumed experiment replays edit 2 (sandbox scope)
        state.step(0);
        expect(docState(state, eid)).not.toEqual(draft);
        expect(editor.pinning).not.toBeNull(); // still in the mode — that was a sandbox redo
        undoRouted(h, state); // back off edit 2 → the sandbox redo holds it again

        // now AT the resumed sandbox's end with nothing left on its redo? no — edit 2 is on the
        // sandbox redo, so redo routes there first; walk the contract's own case instead: the
        // plain undo-then-redo cycle.
        redoRouted(h, state); // edit 2 back (sandbox)
        expect(sandbox()?.redo).toHaveLength(0);
        redoRouted(h, state); // at the sandbox's END, resumed → falls through: RE-LANDS + closes
        state.step(0);
        expect(editor.pinning).toBeNull();
        expect(docState(state, eid)).toEqual(landed);
        expect(h.undo).toHaveLength(1);

        // reopen again: the frozen redo still carries edit 2, so redo walks the SANDBOX first
        // and only falls through to the re-land at the true end of the resumed experiment.
        undoRouted(h, state); // reopen
        expect(editor.pinning).not.toBeNull();
        expect(sandbox()?.redo).toHaveLength(1); // edit 2, frozen at solve time
        redoRouted(h, state); // edit 2 (sandbox)
        expect(editor.pinning).not.toBeNull();
        redoRouted(h, state); // the end → re-land
        state.step(0);
        expect(editor.pinning).toBeNull();
        expect(docState(state, eid)).toEqual(landed);

        // walking a resumed experiment all the way out exits at its start with no outer trace
        // beyond the landing sitting on the outer redo.
        undoRouted(h, state); // reopen again (sandbox undo: [edit 1], redo: [edit 2])
        undoRouted(h, state); // edit 1 off
        expect(editor.pinning).not.toBeNull();
        undoRouted(h, state); // at the start → exits
        state.step(0);
        expect(editor.pinning).toBeNull();
        expect(docState(state, eid)).toEqual(preEntry);
        expect(h.undo).toHaveLength(0);
        redoRouted(h, state); // outer redo still holds the landing → re-lands from pre-entry
        state.step(0);
        expect(docState(state, eid)).toEqual(landed);
    });

    test("the straight cycle: Solve, Ctrl+Z (reopen), Ctrl+Shift+Z (re-land) — no in-mode undos", async () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterPinMode(state, sec);
        bump(h, state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        expect((await runPinSection(h, state, session, editor.locked)).outcome).toBe("solved");
        state.step(0);
        const landed = docState(state, eid);

        undoRouted(h, state); // reopen — frozen sandbox redo is EMPTY here
        expect(editor.pinning).not.toBeNull();
        expect(sandbox()?.redo).toHaveLength(0);
        redoRouted(h, state); // → falls through to the outer redo: re-lands and closes
        state.step(0);
        expect(editor.pinning).toBeNull();
        expect(docState(state, eid)).toEqual(landed);
    });

    test("a NEW edit in a resumed experiment forks: redo stays in the sandbox, no accidental re-land", async () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterPinMode(state, sec);
        bump(h, state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        expect((await runPinSection(h, state, session, editor.locked)).outcome).toBe("solved");
        state.step(0);

        undoRouted(h, state); // resume the experiment
        expect(editor.pinning).not.toBeNull();
        const beforeFork = docState(state, eid);
        bump(h, state, sec); // a NEW in-mode edit — the fork
        redoRouted(h, state); // sandbox redo is empty AND the re-land offer is cleared → no-op
        expect(editor.pinning).not.toBeNull(); // did NOT re-land over the new edit
        state.step(0);
        expect(docState(state, eid)).not.toEqual(beforeFork); // the new edit survived
        exitPinMode(state);
    });

    test("a Solve resolving AFTER the mode closed writes nothing — the no-trace guarantee is a module invariant", async () => {
        // RED FIRST on 9f3dc41 (review finding A): the only post-await staleness check was
        // `authoredHash`, which detects a changed draft, not a closed mode — a late-resolving
        // Solve landed one outer entry after the user exited expecting no trace. The UI paths
        // that make this hard to reach (inert content, Escape ordering) are accidents, not
        // invariants; the module must enforce it. This is the reviewer's exact probe.
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterPinMode(state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        const before = docState(state, eid);

        const run = runPinSection(h, state, session, editor.locked);
        exitPinMode(state); // synchronous close while the solve is in flight

        let threw: unknown;
        try {
            await run;
        } catch (e) {
            threw = e;
        }
        expect(threw).toBeInstanceOf(StalePin);
        state.step(0);
        expect(docState(state, eid)).toEqual(before); // byte-identical
        expect(h.undo).toHaveLength(0); // the exit's no-trace contract survived the late resolve
        expect(editor.pinning).toBeNull();
    });

    test("a re-entered session mid-flight is a DIFFERENT session — the stale solve still discards", async () => {
        // the identity check is per-session, not per-mode-openness: exit + re-enter while the
        // old solve is in flight must not let the old result land into the new session.
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterPinMode(state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        const run = runPinSection(h, state, session, editor.locked);
        exitPinMode(state);
        state.step(0);
        expect(enterPinMode(state, sec)).toBe(true); // a NEW session, same section
        const before = docState(state, eid);

        let threw: unknown;
        try {
            await run;
        } catch (e) {
            threw = e;
        }
        expect(threw).toBeInstanceOf(StalePin);
        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
        expect(editor.pinning).not.toBeNull(); // the new session is untouched
        exitPinMode(state);
    });

    test("the lock ledger freezes AT INVOKE — an in-place clear mid-flight can't empty it", async () => {
        // RED FIRST on 9f3dc41 (review finding B): `relock` was built from the live
        // `editor.locked` AFTER the await, and `endPin` clears that Set in place — so any
        // mid-flight clear emptied the landing's ledger and an undo-reopen lost the locks.
        const { state, sec } = forceTrack();
        const h = createHistory();
        enterPinMode(state, sec);
        bump(h, state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        const rows = sectionForces(state, sec);
        editor.locked.add(rows[0].id);

        const run = runPinSection(h, state, session, editor.locked);
        editor.locked.clear(); // the in-place mutation `endPin` performs, mid-flight
        const result = await run;
        expect(result.outcome).toBe("solved");
        state.step(0);

        undoRouted(h, state); // reopen — the ledger must be the one frozen at Solve-press time
        expect(editor.pinning).not.toBeNull();
        expect(editor.locked.size).toBe(1);
        expect(editor.locked.has(rows[0].id)).toBe(true);
        exitPinMode(state);
    });

    test("the sandbox is EXEMPT from MAX_UNDO eviction: Exit stays byte-identical past 256 in-mode edits", () => {
        // RED FIRST on 333aaa7 (architectural pass, item 1): `record` applied the shift-past-256
        // eviction to the redirect target too, so the 257th in-mode entry (every arrow-nudge is
        // one) evicted the FIRST — and Exit, which discards by replaying reverses, left that
        // edit applied with no trace. The stage-4 eviction hazard resurfacing (that fix died
        // with the bracket): the sandbox is bounded by the mode's lifetime, so it grows instead.
        // seen failing here on the byte-compare with the crest stuck at edit 1's value.
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        const preEntry = docState(state, eid);
        enterPinMode(state, sec);
        const rows = sectionForces(state, sec);
        for (let i = 0; i < 257; i++) {
            beginForceMove(state, rows[2].id);
            setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.1 + (i % 2) * 0.1);
            commit(h);
        }
        expect(sandbox()?.undo).toHaveLength(257); // nothing evicted — the sandbox grew
        exitPinMode(state);
        state.step(0);
        expect(editor.pinning).toBeNull();
        expect(docState(state, eid)).toEqual(preEntry); // every one of the 257 reversed
        expect(h.undo).toHaveLength(0);
    });

    test("the frozen Solve entry carries ALL sandbox entries past 256 — undo-reopen loses none", async () => {
        // the same hazard's other face: the landing froze the (already-evicted) stacks, so an
        // undo-reopen resumed an experiment missing its earliest edit. seen failing on the
        // depth pin (256) before the eviction exemption.
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        const preEntry = docState(state, eid);
        enterPinMode(state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        const rows = sectionForces(state, sec);
        for (let i = 0; i < 257; i++) {
            beginForceMove(state, rows[2].id);
            setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.1 + (i % 2) * 0.1);
            commit(h);
        }
        state.step(0);
        expect((await runPinSection(h, state, session, editor.locked)).outcome).toBe("solved");
        state.step(0);
        undoRouted(h, state); // reopen — the resumed experiment must hold all 257
        expect(sandbox()?.undo).toHaveLength(257);
        exitPinMode(state); // …and the discard walks every one back to pre-entry
        state.step(0);
        expect(docState(state, eid)).toEqual(preEntry);
        expect(h.undo).toHaveLength(0);
    });

    test("Exit skips a live paced landing (history navigation never eases toward erased values)", () => {
        // carried from stage 5's adversarial finding 2 (the exit route): the discard must clear
        // a running landing or its frozen moves keep easing diamonds toward erased values.
        const { state, sec } = forceTrack();
        enterPinMode(state, sec);
        beginLanding([{ id: 1, from: 0, to: 1 }], {
            section: sec,
            entry: { x: 0, y: 0, theta: 0, v: 10 },
        });
        expect(editor.landing).not.toBeNull();
        exitPinMode(state);
        expect(editor.landing).toBeNull();
    });

    test("skip mid-window snaps the whole display to the document (kex2d-idioms stage 4)", () => {
        // every skip path — pointerdown, Esc, history nav, Exit — routes through the ONE
        // `skipLanding` (App.svelte's capture listeners, Timeline's undo/redo keys,
        // `exitPinMode`), so the seam contract is pinned once here: mid-window the bake
        // rides the interpolant (positive control), and the skip's next bake is byte-identical
        // to the document's own values (the mechanism is substitution-then-removal, so the
        // bound is equality — never a tolerance).
        const { state, eid, sec } = forceTrack();
        const out = bakeOut.get(eid);
        if (!out) throw new Error("no bake");
        const final = Array.from(out.fN.subarray(0, 40));
        const crest = sectionForces(state, sec)[1];
        // a landing opened NOW: t ≈ 0, so the display g sits at `from` (the pre-solve draft),
        // well off the authored value.
        beginLanding([{ id: crest.id, from: crest.g + 0.6, to: crest.g }], {
            section: sec,
            entry: { x: 0, y: 0, theta: 0, v: 20 },
        });
        state.step(0);
        expect(Array.from(out.fN.subarray(0, 40))).not.toEqual(final); // mid-flight display
        skipLanding();
        state.step(0);
        expect(Array.from(out.fN.subarray(0, 40))).toEqual(final); // snapped, no residue
        expect(editor.landing).toBeNull();
    });

    test("a zero-move landing clears a live bake override (both halves, one clear)", () => {
        // beginLanding([]) is the "solve moved nothing" path: it must clear BOTH halves of the
        // landing state — a cleared `editor.landing` with a live `bakeLanding` desyncs them (the
        // skip listeners all guard on `editor.landing !== null`, so no path could ever release
        // the override, and the gate would bake every frame forever).
        const { state, eid, sec } = forceTrack();
        const out = bakeOut.get(eid);
        if (!out) throw new Error("no bake");
        const final = Array.from(out.fN.subarray(0, 40));
        const crest = sectionForces(state, sec)[1];
        beginLanding([{ id: crest.id, from: crest.g + 0.6, to: crest.g }], {
            section: sec,
            entry: { x: 0, y: 0, theta: 0, v: 20 },
        });
        state.step(0);
        expect(Array.from(out.fN.subarray(0, 40))).not.toEqual(final); // live override
        beginLanding([], { section: sec, entry: { x: 0, y: 0, theta: 0, v: 20 } });
        state.step(0);
        // the seam contract: override cleared ⇒ bake byte-identical to the authored document.
        expect(Array.from(out.fN.subarray(0, 40))).toEqual(final);
        expect(editor.landing).toBeNull();
    });

    test("beginPin skips a live landing (a session never opens over the override)", () => {
        // exitPinMode's symmetric twin: the mode OPEN must clear a running landing too, or
        // the new session's freeze and the stale override's hold fight over the two-part chain.
        const { state, eid, sec } = forceTrack();
        const out = bakeOut.get(eid);
        if (!out) throw new Error("no bake");
        const final = Array.from(out.fN.subarray(0, 40));
        const crest = sectionForces(state, sec)[1];
        beginLanding([{ id: crest.id, from: crest.g + 0.6, to: crest.g }], {
            section: sec,
            entry: { x: 0, y: 0, theta: 0, v: 20 },
        });
        state.step(0);
        expect(Array.from(out.fN.subarray(0, 40))).not.toEqual(final); // live override
        beginPin({
            section: sec,
            stamp: { x: 0, y: 0, theta: 0, v: 20 },
            ghost: { x: new Float32Array(0), y: new Float32Array(0) },
            freeze: { x: 0, y: 0, theta: 0, v: 20 },
        });
        expect(editor.landing).toBeNull();
        endPin();
        state.step(0);
        expect(Array.from(out.fN.subarray(0, 40))).toEqual(final); // no override residue
    });

    test("a refusal stays in the mode: draft + histories untouched, locks intact", async () => {
        const { state, eid, sec } = forceTrack();
        const h = createHistory();
        enterPinMode(state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");

        // starve the free set below MIN_FREE — the counting certificate refuses at invoke.
        const rows = sectionForces(state, sec);
        const locked = new Set(rows.slice(0, rows.length - 2).map((r) => r.id));
        for (const id of locked) editor.locked.add(id);
        const before = docState(state, eid);
        const sbDepth = sandbox()?.undo.length ?? -1;

        const result = await runPinSection(h, state, session, editor.locked);
        expect(result.outcome).toBe("unreachable");
        expect(result.reason).toBe("free-count");
        state.step(0);
        expect(docState(state, eid)).toEqual(before); // byte-identical, still in-mode
        expect(h.undo).toHaveLength(0); // refusal records nothing outer…
        expect(sandbox()?.undo.length).toBe(sbDepth); // …nor in the sandbox
        expect(editor.pinning).not.toBeNull();
        expect(editor.locked.size).toBe(locked.size); // lock persistence across solves in-mode
        exitPinMode(state);
        expect(editor.locked.size).toBe(0); // …and exit discards the locks
    });
});

describe("the downstream freeze (kex2d-optimize-mode stage 7)", () => {
    // two force sections; the mode on the FIRST freezes the second's placement at its
    // mode-entry state — no live repropagation of the wandering exit — and any close unfreezes.

    beforeEach(() => {
        if (editor.pinning !== null) endPin();
    });

    function twoSections(): { state: State; eid: number; sec: number; secB: number } {
        const { state, eid, sec } = forceTrack();
        const secB = createSection(state, 1, SectionKind.Force, 30);
        createForcePoint(state, secB, 0, 1);
        createForcePoint(state, secB, 10, 1.3);
        createForcePoint(state, secB, 20, 1);
        createForcePoint(state, secB, 30, 1);
        state.step(0);
        return { state, eid, sec, secB };
    }

    function bump(h: ReturnType<typeof createHistory>, state: State, sec: number): void {
        const rows = sectionForces(state, sec);
        beginForceMove(state, rows[2].id);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.6);
        commit(h);
        state.step(0);
    }

    test("downstream holds its mode-entry state across an in-mode edit; Exit repropagates", () => {
        const { state, eid, sec, secB } = twoSections();
        const h = createHistory();
        const entryB0 = { ...(sectionInfo.get(secB)?.entry ?? { x: 0, y: 0, theta: 0, v: 0 }) };

        enterPinMode(state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        bump(h, state, sec); // the pinning section's exit wanders…
        const infoA = sectionInfo.get(sec);
        const infoB = sectionInfo.get(secB);
        const s = samples.get(eid);
        if (!infoA || !infoB || !s) throw new Error("no bake");

        // …but downstream holds its mode-entry entry BIT-IDENTICAL (the freeze).
        expect(infoB.entry.x).toBe(entryB0.x);
        expect(infoB.entry.y).toBe(entryB0.y);
        expect(infoB.entry.theta).toBe(entryB0.theta);
        expect(infoB.entry.v).toBe(entryB0.v);
        // the frozen bake does NOT share the boundary sample — the seam is the visible gap:
        // downstream starts at its own sample, placed at the FROZEN entry (= the stamp), while
        // the live exit sits elsewhere.
        expect(infoB.startSample).toBe(infoA.endSample + 1);
        expect(s.posX[infoB.startSample]).toBeCloseTo(session.stamp.x, 4);
        expect(s.posY[infoB.startSample]).toBeCloseTo(session.stamp.y, 4);
        // positive control: the live exit really moved off the stamp (the gap is real).
        const gapX = Math.abs(s.posX[infoA.endSample] - session.stamp.x);
        const gapY = Math.abs(s.posY[infoA.endSample] - session.stamp.y);
        expect(gapX + gapY).toBeGreaterThan(0.01);

        exitPinMode(state);
        state.step(0);
        // unfrozen: the chain shares the boundary sample again and downstream re-propagates —
        // the draft was restored, so downstream is back at its pre-entry placement.
        const infoA2 = sectionInfo.get(sec);
        const infoB2 = sectionInfo.get(secB);
        if (!infoA2 || !infoB2) throw new Error("no bake after exit");
        expect(infoB2.startSample).toBe(infoA2.endSample);
        expect(infoB2.entry.x).toBe(entryB0.x);
        expect(infoB2.entry.y).toBe(entryB0.y);
    });

    test("a landed Solve unfreezes with downstream where it was (the stamp restored)", async () => {
        const { state, sec, secB } = twoSections();
        const h = createHistory();
        const entryB0 = { ...(sectionInfo.get(secB)?.entry ?? { x: 0, y: 0, theta: 0, v: 0 }) };

        enterPinMode(state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        bump(h, state, sec);
        const result = await runPinSection(h, state, session, editor.locked);
        expect(result.outcome).toBe("solved");
        state.step(0);

        const infoA = sectionInfo.get(sec);
        const infoB = sectionInfo.get(secB);
        if (!infoA || !infoB) throw new Error("no bake after solve");
        expect(infoB.startSample).toBe(infoA.endSample); // unfrozen — shared boundary again
        // downstream lands where it was: the solved exit restored the stamp, so the entry is
        // back within the solve's own floor of its mode-entry value (the mechanisms' own
        // disagreement, not a tuned number — the solver suite pins the floor itself; here the
        // claim is placement-scale identity, asserted at display precision).
        expect(infoB.entry.x).toBeCloseTo(entryB0.x, 3);
        expect(infoB.entry.y).toBeCloseTo(entryB0.y, 3);
        expect(infoB.entry.theta).toBeCloseTo(entryB0.theta, 3);
    });

    test("the landing holds the freeze through its window; skip releases it (kex2d-idioms stage 4)", async () => {
        // the App shape: the landed Solve closed the mode (freeze cleared), then `beginLanding`
        // re-seeds downstream at the session's frozen entry for the window — so the frozen gap
        // closes continuously with the interpolated exit instead of snapping at the close.
        const { state, sec, secB } = twoSections();
        const h = createHistory();
        enterPinMode(state, sec);
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        const preRows = sectionForces(state, sec).map((r) => ({ id: r.id, g: r.g }));
        bump(h, state, sec);
        const result = await runPinSection(h, state, session, editor.locked);
        expect(result.outcome).toBe("solved");

        // the App calls beginLanding synchronously on resolution — before any bake runs free.
        const rows = sectionForces(state, sec);
        beginLanding(
            rows
                .map((r, k) => ({ id: r.id, from: preRows[k].g, to: r.g }))
                .filter((m) => m.from !== m.to),
            { section: session.section, entry: session.freeze },
        );
        expect(editor.landing).not.toBeNull(); // the solve really moved keys (positive control)
        // the chrome predicate seam (kex2d-idioms stage 8): the mode is CLOSED here, but the
        // modal presentation still names the landed section — the exit transition holds it.
        expect(modeChromeSection()).toBe(session.section);
        state.step(0);
        const infoA = sectionInfo.get(sec);
        const infoB = sectionInfo.get(secB);
        if (!infoA || !infoB) throw new Error("no landing bake");
        expect(infoB.startSample).toBe(infoA.endSample + 1); // the freeze HELD through the close
        expect(infoB.entry.x).toBe(session.freeze.x); // …at the session's frozen entry, bit-exact
        expect(infoB.entry.y).toBe(session.freeze.y);
        expect(infoB.entry.theta).toBe(session.freeze.theta);
        expect(infoB.entry.v).toBe(session.freeze.v);

        skipLanding();
        expect(modeChromeSection()).toBeNull(); // the skip releases the chrome in the same call
        state.step(0);
        const infoA2 = sectionInfo.get(sec);
        const infoB2 = sectionInfo.get(secB);
        if (!infoA2 || !infoB2) throw new Error("no release bake");
        expect(infoB2.startSample).toBe(infoA2.endSample); // released: shared boundary again
    });
});

// ── the Pin/solver boundary sentinel (kex2d-menu-grammar stage 4) ────────────────────
//
// The law the rename landed: **the solver optimizes, the mode pins.** `optimize.ts` and its
// façade/worker/oracle/lab genuinely are a constrained minimization and keep their names; every
// identifier and every line of prose naming the MODE says Pin. Nothing but a census keeps that
// boundary from eroding one convenient name at a time, so this is it — a declared allowlist with
// a reason per entry, so a new `optimize`-flavored name outside the solver vocabulary fails
// loudly rather than silently widening the exemption set.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

describe("the Pin/solver boundary — grep sentinel", () => {
    const root = join(import.meta.dir, "..");
    const sources = ["src", "tests", "harness"].flatMap((dir) =>
        readdirSync(join(root, dir))
            .map((f) => join(dir, f))
            .filter((p) => statSync(join(root, p)).isFile() && /\.(ts|svelte)$/.test(p)),
    );
    const read = (p: string): string => readFileSync(join(root, p), "utf8");

    // the ONE literal that keeps its old spelling: `kex2d-optimize-mode` is the name of the spec
    // that built the mode — a historical proper noun in a citation, not a description of what the
    // mode is. Rewriting it would invent a spec that never existed. Stripped before every census
    // below so it can't launder a real violation hiding on the same line.
    const Slug = "kex2d-optimize-mode";
    // this suite necessarily SPELLS every name it forbids, so the census reads each file only up
    // to the sentinel's own header — otherwise it reports itself and can never go green. The
    // marker's presence is asserted below, so a rename of the header can't silently truncate a
    // whole file to nothing.
    const Mark = "── the Pin/solver boundary sentinel";
    const body = (p: string): string => {
        const text = read(p).replaceAll(Slug, "");
        const cut = text.indexOf(Mark);
        return cut < 0 ? text : text.slice(0, cut);
    };

    test("the census reads this file up to the sentinel header and no further", () => {
        expect(read("tests/pin.test.ts")).toContain(Mark);
        expect(body("tests/pin.test.ts").length).toBeGreaterThan(1000);
        expect(body("tests/pin.test.ts")).not.toContain(Mark);
    });

    // the solver's own public vocabulary — legal in any module that CONSUMES the kernel.
    const Solver: Record<string, string> = {
        optimize: "the module basename: `optimize.ts` / `-async` / `-worker` / `.oracle` / `.lab`",
        solveOptimize: "the kernel entry point (`optimize.ts`)",
        runOptimize: "the one-shot worker façade (`optimize-async.ts`)",
        liveOptimizeWorkers: "the façade's teardown observable",
        OptimizeOpts: "the kernel's input type",
        OptimizeResult: "the kernel's answer type",
        OptimizeOutcome: "the kernel's outcome union",
        OptimizeStamp: "the kernel's target type",
        OptimizeRunOpts: "the façade's run options",
        OptimizeRequest: "the worker's message type",
        OptimizeReply: "the worker's reply type",
    };

    // everything else, per file, with its reason. A file absent from here may carry solver
    // vocabulary and nothing more.
    const Exempt: Record<string, Record<string, string>> = {
        "src/Timeline.svelte": {
            optimization: "the constraints-not-keyframes law's general noun, not this mode",
        },
        "src/collocatelab.ts": { optimizer: "the collocation kernel's own lab caption" },
        "tests/collocate.lab.ts": { optimizer: "general optimization vocabulary" },
        "tests/collocate.test.ts": { optimizer: "general optimization vocabulary" },
        "tests/conditioning.lab.ts": { Optimizer: "cites the retired 'Optimizer design' notes" },
        "tests/hill.lab.ts": { optimization: "the lab's question is about optimization at large" },
        "tests/optimize.test.ts": { optimizeGolden: "the kernel's frozen fixture import" },
    };

    test("no `optimize`-flavored identifier survives outside the declared solver vocabulary", () => {
        const stray: string[] = [];
        for (const p of sources) {
            const allowed = Exempt[p] ?? {};
            const tokens = new Set(
                (body(p).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter((t) =>
                    /optimiz/i.test(t),
                ),
            );
            for (const t of tokens) if (!(t in Solver) && !(t in allowed)) stray.push(`${p}: ${t}`);
        }
        expect(stray.sort()).toEqual([]);
    });

    test("the mode's retired identifiers are gone everywhere", () => {
        // named one by one rather than inferred: each was the mode wearing the solver's word, and
        // a regression reintroducing any of them is the exact drift this unit closed.
        const Retired = [
            "optimizeMode",
            "optimizing",
            "optimizeSolving",
            "OptimizeSession",
            "beginOptimize",
            "endOptimize",
            "enterOptimize",
            "exitOptimizeMode",
            "runOptimizeSection",
            "StaleOptimize",
            "optimizeRefused",
            "canOptimize",
            "optimizeSolve",
            "optimizeExit",
            "optimizeEnter",
            "optSolvable",
            "optOpen",
            "optReason",
            "optpanel",
        ];
        const found: string[] = [];
        for (const p of sources) {
            const text = body(p);
            for (const name of Retired)
                if (new RegExp(`\\b${name}\\b`).test(text)) found.push(`${p}: ${name}`);
        }
        expect(found.sort()).toEqual([]);
    });

    test("no prose still calls the mode an optimization", () => {
        // the identifier census can't see this: `// optimize mode` tokenizes to `optimize` (legal
        // — it's the kernel's module basename) plus `mode`. Phrases are their own check.
        const Phrases = [
            /optimize mode/i,
            /optimize-mode/i,
            /optimize session/i,
            /optimize solve/i,
            /optimize panel/i,
            /optimize state/i,
            /optimize stamp/i,
            /optimized (section|span)/i,
        ];
        const found: string[] = [];
        for (const p of sources)
            for (const rx of Phrases) {
                const hit = body(p).match(rx);
                if (hit) found.push(`${p}: ${hit[0]}`);
            }
        expect(found.sort()).toEqual([]);
    });
});

// C3: the pin invariant — a strip on a pinned section's track. `enterPin`'s stamp/ghost
// construction (`pin.ts`'s own `evalForce` call) must read the strip's stored
// {start,end,value} DIRECTLY off ECS state, never through `sectionInfo`/`bakeOut`/any
// other bake-derived read — checked STRUCTURALLY, not just by outcome.
describe("velocity strips — the pin invariant (C3)", () => {
    test("stripsForStep resolves a section's strips at a caller-supplied Step with zero reads of bakeOut/sectionInfo — structural", () => {
        // red before `pin.ts` threaded `stripsForStep`: `enterPin`'s own `evalForce` call
        // carried no strips argument at all, so a strip on the pinning section was silently
        // ignored by the stamp/ghost (verified by reverting `pin.ts`'s `strips` argument and
        // observing the stamp arm below fail — see the next test).
        const { state, eid, sec } = forceTrack();
        createStrip(state, sec, 15, 25, 6);
        state.step(0);

        // corrupt the two bake-derived maps this construction path could reach — proving the
        // strip resolution below cannot be reading through either of them (a mistaken read
        // would throw on the deleted `sectionInfo` entry or see the poisoned hash). Restored
        // after, since both are module-level and outlive this test.
        const savedInfo = sectionInfo.get(sec);
        const savedOut = bakeOut.get(eid);
        if (!savedInfo || !savedOut) throw new Error("no bake");
        sectionInfo.delete(sec);
        bakeOut.set(eid, { ...savedOut, hash: "__corrupted__" });

        const step = resolveStep(40, 20 / 40); // an independently-resolved step (ds = 0.5)
        const specs = stripsForStep(state, sec, step);
        expect(specs).toBeDefined();
        expect(specs?.[0].start).toBe(Math.round(15 / step.ds));
        expect(specs?.[0].end).toBe(Math.round(25 / step.ds));
        expect(specs?.[0].value).toBe(6);

        sectionInfo.set(sec, savedInfo);
        bakeOut.set(eid, savedOut);
    });

    test("enterPin's stamp/ghost reflect a strip reaching the section's exit — the construction actually threads it", () => {
        const { state, sec } = forceTrack(); // length 40, entry v0 = 20
        // reaches the section's own exit, so the stamp's v is exactly the strip's value —
        // the exit is the ONE state `enterPin`'s stamp exposes directly.
        createStrip(state, sec, 30, 40, 7);
        state.step(0);
        const session = enterPin(state, sec);
        expect(session).not.toBeNull();
        if (!session) return;
        expect(session.stamp.v).toBeCloseTo(7, 4);
        endPin();
    });

    test("a strip on a pinned section's track: the solve still lands", async () => {
        const { state, sec } = forceTrack();
        createStrip(state, sec, 15, 25, 9);
        state.step(0);
        if (!enterPinMode(state, sec)) throw new Error("no session");
        const session = editor.pinning;
        if (!session) throw new Error("no session");
        const rows = sectionForces(state, sec);
        setForcePoint(state, rows[2].id, rows[2].s, rows[2].g + 0.4);
        state.step(0);
        const h = createHistory();
        const locked = new Set([rows[0].id, rows[4].id]);
        const result = await runPinSection(h, state, session, locked);
        expect(result.outcome).toBe("solved");
        expect(editor.pinning).toBeNull(); // Solve closed the mode
    });
});
