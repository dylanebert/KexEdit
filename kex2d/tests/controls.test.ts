import { describe, expect, test, afterEach } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    keyframeCuttable,
    mixedSetDelete,
    nodeCuttable,
    sectionEditable,
    sectionOpsAllowed,
    suffixRun,
} from "../src/acts";
import {
    applyMultiDelta,
    armDrag,
    attachControls,
    beyondDeadZone,
    crossKind,
    DRAG_PX,
    dragFreeTo,
    forceEscape,
    formatDeg,
    formatLen,
    freezeChains,
    latchAngle,
    LATCH_PX,
    manipKnobs,
    nodeFrame,
    nodeMetrics,
    normDeg,
    oneShotEscape,
    pickForce,
    pickForceOrStart,
    pickHover,
    PICK_R,
    polarNudge,
    sectionsDeletable,
    sectionsJoinable,
    selectedMetrics,
    stripEscape,
} from "../src/controls";
import {
    activeKind,
    beginDrag,
    deselectAll,
    editor,
    endDrag as endDragGesture,
    enterForceEdit,
    enterTangentEdit,
    exitTangentEdit,
    select,
    selectForce,
    selectForceHandle,
    selectOneShot,
    selectSection,
    selectStrip,
    selectStripKf,
} from "../src/editor";
import { addStrip, history } from "../src/history";
import { forceKeyAct, modeKeyAct, nodeKeyAct, sectionKeyAct } from "../src/keys";
import { editHandleSets } from "../src/tangents";
import { LENGTH_MIN } from "../src/magnet";
import { ANGLE_STEP_DEFAULT as ANGLE_STEP } from "../src/settings";
import {
    angleControl,
    angleToPoint,
    lengthControl,
    lengthToPoint,
    offsetControl,
    offsetToPoint,
    screenToOffset,
    slideControl,
    slideToPoint,
} from "../src/manipulator";
import { localize } from "../src/section";
import { TangentMode } from "../src/spline";
import {
    addNode,
    appendSection,
    BakeSystem,
    convertSection,
    createForcePoint,
    createSection,
    createTrack,
    EXTEND_DIST,
    forceMarkers,
    exitWorld,
    Handle,
    handleAt,
    handleTangent,
    lastHandle,
    reheadOnDrag,
    samples,
    SectionKind,
    sectionInfo,
    seedTangent,
    setTangent,
    stripAt,
    Track,
} from "../src/track";
import { marquee, setCamera } from "../src/view";

// a synthetic view transform (world→screen affine, sy < 0 for the Y-flip) — the drag paths take
// screen px, so a device-free test projects through this.
const TX = { sx: 40, sy: -40, ox: 500, oy: 400 };
const trackOf = (state: State): number => {
    for (const e of state.query([Track])) return e;
    throw new Error("no track");
};
// replicate `dragManipTo`'s node write: place the tip at a screen point, then localize + rehead
// (exactly what `dragTo` does inside the controls — the DEFAULT surface's write. the tangent-edit
// body drag writes through `dragFreeTo` instead, which stamps concrete and never re-heads; that
// seam is exported and pinned directly below).
function writeNode(state: State, eid: number, screen: { x: number; y: number }): void {
    const world = { x: (screen.x - TX.ox) / TX.sx, y: (screen.y - TX.oy) / TX.sy };
    const entry = sectionInfo.get(Handle.section.get(eid))?.entry;
    if (!entry) throw new Error("no entry");
    const local = localize(entry, { x: world.x, y: world.y, theta: 0 });
    Handle.pos.set(eid, local.x, local.y);
    reheadOnDrag(state, eid);
}

// the readout formatting seam (feel round 6, universalized round 10, `.0` dropped round 11): one
// degree formatter (`formatDeg`) + one length formatter (`formatLen`) every source funnels through, so
// a value formats identically regardless of which precedence source produced it. the rule is one
// decimal, then strip an exact trailing `.0` — DETERMINISTIC post-rounding (`4.999` → `5.0` → `5°`,
// no epsilon window, no flicker), `5.5°` keeps its decimal, `-0` normalizes to `0`.

test("a 5°-grid multiple reads as a bare integer (the `.0` dropped), not `5.0°`", () => {
    // the angle control carries the incline in world radians (k·ANGLE_STEP, 5°); the readout feed
    // converts it rad→deg (`dragManipTo`). a snapped grid multiple's `.0` is stripped → `30°`.
    for (let k = -6; k <= 6; k++) {
        const incline = k * ANGLE_STEP;
        const label = formatDeg((-incline * 180) / Math.PI);
        expect(label).toBe(`${-k * 5}°`); // e.g. "30°", the .0 dropped
    }
});

test("a real decimal keeps its digit; an integer-rounding value drops the `.0`", () => {
    // deterministic post-rounding: derive the string from the rounded value, no epsilon window.
    expect(formatDeg(5.5)).toBe("5.5°"); // a real decimal stays
    expect(formatDeg(4.999)).toBe("5°"); // rounds to 5.0 → strips to "5" (no flicker, no epsilon)
    expect(formatDeg(-22.126334809373247)).toBe("-22.1°"); // f64 noise absorbed into one decimal
    expect(formatDeg(37.049999999999997)).toBe("37°"); // rounds to 37.0 → "37"
});

test("zero (and a small negative that rounds to zero) reads `0°`, sign-free", () => {
    expect(formatDeg(0)).toBe("0°");
    expect(formatDeg(-0)).toBe("0°");
    expect(formatDeg(-0.04)).toBe("0°"); // rounds to -0.0 → normalized → "0"
    expect(formatDeg(-1e-7)).toBe("0°");
});

test("every angle display path formats a value IDENTICALLY (one seam, one rule)", () => {
    // representative degrees: a snapped grid multiple (5), a hair off it (5.02→"5"), a real decimal
    // (5.5), a negative (−22.1), a value that rounds to zero (−0.04→"0"), zero, −0, ±90. the readout
    // (`nodeMetrics`, the one source both the resting and handle-drag paths read) routes the heading
    // through `formatDeg`, so every display reads the SAME string.
    for (const deg of [5, 5.02, 5.5, -22.1, -0.04, 0, -0, 90, -90]) {
        const rad = (deg * Math.PI) / 180;
        const seam = formatDeg(deg);
        expect(seam).toMatch(/^-?\d+(\.\d)?°$/); // one decimal OR a bare integer (the .0 dropped)
        // the readout (nodeMetrics) routes the heading through the seam.
        expect(nodeMetrics({ x: 0, y: 0 }, { x: 1, y: 0 }, rad).angleLabel).toBe(seam);
    }
    // the specific cases: a snapped 5° and a hair off both drop to "5°"; a real decimal keeps it.
    expect(formatDeg(5)).toBe("5°");
    expect(formatDeg(4.999)).toBe("5°");
    expect(formatDeg(5.5)).toBe("5.5°");
    // lengths funnel through the one `formatLen` — same rule (a whole metre drops the .0).
    expect(formatLen(5.02)).toBe(nodeMetrics({ x: 0, y: 0 }, { x: 5.02, y: 0 }, 0).lengthLabel);
    expect(formatLen(5)).toBe("5 m");
    expect(formatLen(5.3)).toBe("5.3 m"); // a continuous (Ctrl-bypass) length keeps its decimal
    expect(formatLen(-0)).toBe("0 m");
});

test("formatLen is the one length seam — one decimal, `.0` dropped, no sign on zero", () => {
    expect(formatLen(4.2)).toBe("4.2 m"); // a real decimal stays (a continuous length)
    expect(formatLen(4.999)).toBe("5 m"); // rounds to 5.0 → strips to "5 m"
    expect(formatLen(-0)).toBe("0 m"); // never "-0 m"
});

test("normDeg wraps into (−180, 180] — 180 stays 180, matching the doc", () => {
    expect(normDeg(180)).toBe(180);
    expect(normDeg(-180)).toBe(180);
    expect(normDeg(540)).toBe(180);
    expect(normDeg(0)).toBe(0);
    expect(normDeg(-90)).toBe(-90);
    expect(normDeg(270)).toBe(-90);
});

// the resting readout metrics: every node with a previous node reports its world exit heading + the
// chord to the previous node. one formatter feeds both readout sources (`formatDeg` for degrees,
// integer metres for length). the angle is the AUTHORED heading (passed in), never a bake
// re-derivation, so it holds while a handle drags along an engaged snap ray.

test("a node reports its world exit heading and the chord to the previous node", () => {
    // node 3 m right + 3 m up → chord = hypot(3,3) ≈ 4.24 → "4.2 m". heading π/4 → +45°.
    const m = nodeMetrics({ x: 0, y: 0 }, { x: 3, y: 3 }, Math.PI / 4);
    expect(m.angleLabel).toBe("45°");
    expect(m.lengthLabel).toBe("4.2 m");
});

test("a node with no heading (null) reports the chord length only", () => {
    const m = nodeMetrics({ x: 0, y: 0 }, { x: 5, y: 0 }, null);
    expect(m.angleLabel).toBeNull();
    expect(m.lengthLabel).toBe("5 m");
});

test("the heading routes through formatDeg (a fractional heading keeps one decimal)", () => {
    // heading atan2(1, 2) ≈ 26.565° → formatDeg's one-decimal path, "26.6°".
    const deg = (Math.atan2(1, 2) * 180) / Math.PI;
    expect(nodeMetrics({ x: 0, y: 0 }, { x: 2, y: 1 }, Math.atan2(1, 2)).angleLabel).toBe(
        formatDeg(deg),
    );
    expect(nodeMetrics({ x: 0, y: 0 }, { x: 2, y: 1 }, Math.atan2(1, 2)).angleLabel).toBe("26.6°");
});

// the click-vs-drag dead-zone: a node grab stays a select until the pointer travels DRAG_PX from
// the grab point. below the threshold no drag runs — no node move, no magnet, no guide (the fix for
// a refocus click flashing a snap guide on a plain click after a window blur).

test("a sub-threshold displacement stays inside the dead-zone (a click, not a drag)", () => {
    expect(beyondDeadZone(0, 0)).toBe(false);
    expect(beyondDeadZone(DRAG_PX - 1, 0)).toBe(false);
    expect(beyondDeadZone(0, DRAG_PX - 1)).toBe(false);
});

test("reaching DRAG_PX clears the dead-zone — the grab becomes a drag", () => {
    expect(beyondDeadZone(DRAG_PX, 0)).toBe(true);
    expect(beyondDeadZone(0, DRAG_PX)).toBe(true);
    // Euclidean boundary: a diagonal reaches the radius before either axis alone (3²+3²=18 ≥ 4²)
    expect(beyondDeadZone(3, 3)).toBe(true);
});

test("the dead-zone latches — once armed it stays armed even back inside", () => {
    // a fresh sub-threshold move doesn't arm
    expect(armDrag(false, 1, 0)).toBe(false);
    // crossing the threshold arms it
    expect(armDrag(false, DRAG_PX, 0)).toBe(true);
    // sticky: an armed drag stays armed at zero displacement (no disarm on a cross-back)
    expect(armDrag(true, 0, 0)).toBe(true);
});

// the tangent-handle angle snap (a polar-tracking landmark): the direction a handle drag grabbed
// at persists for the whole gesture, so pulling the tip out lengthens the tangent without bumping
// its angle — and a deviated tip re-snaps whenever it returns within LATCH_PX (perpendicular
// screen px) of the start ray (stateless, the magnet-target model — not the one-way armDrag
// latch). the ray argument is a unit direction (zero = no landmark); tip is screen px from the node.

test("an on-ray tip passes its length through — angle unchanged", () => {
    // ray along +x; a tip straight out the ray reports its length, no perpendicular deflection.
    expect(latchAngle(20, 0, 1, 0)).toEqual({ x: 20, y: 0, snapped: true });
    // pulling further out only grows the length — still exactly on the ray.
    expect(latchAngle(35, 0, 1, 0)).toEqual({ x: 35, y: 0, snapped: true });
});

test("a within-corridor deviation snaps — the angle locks, only length survives", () => {
    // tip 5 px off the ray (perp = 5 < LATCH_PX): the angle snaps back to the ray, the projected
    // length (the along component) is what's kept.
    expect(latchAngle(20, 5, 1, 0)).toEqual({ x: 20, y: 0, snapped: true });
});

test("the corridor half-width is LATCH_PX — at the edge it snaps, just past it is free", () => {
    // exactly LATCH_PX perpendicular still snaps (≤, the boundary is inclusive)…
    expect(latchAngle(20, LATCH_PX, 1, 0)).toEqual({ x: 20, y: 0, snapped: true });
    // …a hair past it is free and the raw tip passes through (free rotation).
    const r = latchAngle(20, LATCH_PX + 0.001, 1, 0);
    expect(r.snapped).toBe(false);
    expect(r.x).toBeCloseTo(20, 10);
    expect(r.y).toBeCloseTo(LATCH_PX + 0.001, 10);
});

test("the corridor is measured perpendicular in screen px, independent of ray angle", () => {
    // ray at (0.6, 0.8): a tip 10 along the ray plus 5 px perpendicular projects back to 10·ray.
    const tipX = 6 - 0.8 * 5; // (6,8) is 10·ray; (−0.8, 0.6) is the unit perpendicular
    const tipY = 8 + 0.6 * 5;
    const r = latchAngle(tipX, tipY, 0.6, 0.8);
    expect(r.snapped).toBe(true);
    expect(r.x).toBeCloseTo(6, 10);
    expect(r.y).toBeCloseTo(8, 10);
});

test("the landmark persists — a tip that deviated re-snaps on returning to the corridor", () => {
    // well outside the corridor: free rotation, raw tip through.
    expect(latchAngle(20, 15, 1, 0)).toEqual({ x: 20, y: 15, snapped: false });
    // the same gesture drifting back within LATCH_PX: the start angle re-engages as a landmark.
    expect(latchAngle(20, 5, 1, 0)).toEqual({ x: 20, y: 0, snapped: true });
});

test("a degenerate (zero) ray never snaps — no landmark to favor", () => {
    expect(latchAngle(20, 0, 0, 0)).toEqual({ x: 20, y: 0, snapped: false });
});

// the resting readout over a baked track (`selectedMetrics` + `exitWorld`): every selected node
// with a previous node reports its authored WORLD exit heading — an explicit out-vector else the
// stored `Auto` heading, rotated by the section entry frame. node 0 (no previous node) stays null.
// this is the authored source, not the flanking-sample bake re-derivation the readout drifted on.

/** a fresh single geo section: node 0 at the local origin (the pinned entry) + a shape node. */
function geoTrack(): { state: State; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    return { state, sec };
}

test("node 0 (the entry anchor) has no readout — the null guard holds", () => {
    const { state, sec } = geoTrack();
    addNode(state, sec, 0, 0);
    addNode(state, sec, EXTEND_DIST, 0);
    state.step(0);
    const node0 = handleAt(state, sec, 0);
    if (node0 === null) throw new Error("node 0 missing");
    expect(selectedMetrics(state, node0)).toBeNull();
});

test("an INTERIOR node reports its authored heading (not null — display is not the snap quantum)", () => {
    // node1 placed up-right → its frozen tip heading is π/2 (reflect(0, π/4)); adding node2 makes it
    // interior, heading frozen. the old readout gated the angle on `lastHandle`, so an interior node
    // showed NO angle — this pins the fix: an interior node reports its real heading.
    const { state, sec } = geoTrack();
    addNode(state, sec, 0, 0);
    addNode(state, sec, 10, 10); // tip heading = reflect(0, atan2(10,10)) = π/2
    addNode(state, sec, 20, 10); // node1 is now interior, heading frozen at π/2
    state.step(0);
    const interior = handleAt(state, sec, 1);
    if (interior === null) throw new Error("interior node missing");
    expect(Handle.theta.get(interior)).toBeCloseTo(Math.PI / 2, 6);
    const m = selectedMetrics(state, interior);
    expect(m).not.toBeNull();
    expect(m?.angleLabel).toBe("90°"); // the world exit heading (entry frame identity here)
});

test("an explicit out-vector governs the readout heading, not the recovered geometry", () => {
    // a Free tip with an out-vector pointing 30° local. exitWorld reads that authored vector, not a
    // flanking-sample bisector — the fix for the on-ray drift (the old readout re-derived from the
    // reshaping curve). entry frame is identity here, so world = local = 30°.
    const { state, sec } = geoTrack();
    addNode(state, sec, 0, 0);
    addNode(state, sec, 10, 0);
    const tip = lastHandle(state, sec);
    if (tip === null) throw new Error("tip missing");
    const a = (30 * Math.PI) / 180;
    setTangent(state, sec, Handle.order.get(tip), {
        mode: TangentMode.Free,
        inX: -5,
        inY: 0,
        outX: 5 * Math.cos(a),
        outY: 5 * Math.sin(a),
    });
    state.step(0);
    expect(exitWorld(tip)).toBeCloseTo(a, 4); // the authored out-vector, not a flanking bisector
    // the readout routes exitWorld through formatDeg (f32 tangent storage → the one-decimal path).
    expect(selectedMetrics(state, tip)?.angleLabel).toBe(
        formatDeg((exitWorld(tip) * 180) / Math.PI),
    );
});

// the ring (extend button + both knobs) orbits the node's AUTHORED exit heading, the same quantity
// `extend()` lays the next node along — not `Handle.theta`, which is dead state once a node carries
// an explicit out-vector (the kex2d/AGENTS.md gotcha, and the round-8/13 family of bugs). Rotating the
// authored vector must therefore rotate the ring; reading the dead field leaves it stuck.
test("the ring base tracks the authored exit heading, not the stale Handle.theta", () => {
    const { state, sec } = geoTrack();
    addNode(state, sec, 0, 0);
    addNode(state, sec, 10, 0);
    const tip = lastHandle(state, sec);
    if (tip === null) throw new Error("tip missing");
    const order = Handle.order.get(tip);
    const knobAngle = (): number => {
        const s = samples.get(trackOf(state));
        if (!s) throw new Error("no samples");
        const knobs = manipKnobs(state, s, TX, tip);
        if (!knobs) throw new Error("no knobs");
        const i = Handle.sample.get(tip);
        const k = knobs[0];
        return Math.atan2(k.y - (TX.oy + s.posY[i] * TX.sy), k.x - (TX.ox + s.posX[i] * TX.sx));
    };

    setTangent(state, sec, order, { mode: TangentMode.Free, inX: -5, inY: 0, outX: 5, outY: 0 });
    state.step(0);
    const before = knobAngle();
    const theta = Handle.theta.get(tip);

    // rotate the authored out-vector by +90°. Handle.theta is untouched by a tangent write, so a
    // ring reading it cannot move.
    const turn = Math.PI / 2;
    setTangent(state, sec, order, { mode: TangentMode.Free, inX: -5, inY: 0, outX: 0, outY: 5 });
    state.step(0);
    expect(Handle.theta.get(tip)).toBeCloseTo(theta, 9); // the dead field really is unchanged
    expect(exitWorld(tip)).toBeCloseTo(turn, 4);

    // TX is a uniform y-flip (sx = -sy), so `ringBase` negates the world heading exactly.
    expect(normDeg(((knobAngle() - before) * 180) / Math.PI)).toBeCloseTo(-90, 3);
});

test("the readout reports the node's quantities, invariant to the out-handle's length (round 14)", () => {
    // a handle drag along a ray lengthens the out-vector without rotating it. the readout (the one
    // source both the resting and handle-drag paths read) must report the node's exit heading + chord
    // to prev — both invariant to |out| — never the handle's own growing length. this is the source
    // the round-14 feed collapses onto; the old handle-length feed grew with the drag.
    const { state, sec } = geoTrack();
    addNode(state, sec, 0, 0);
    addNode(state, sec, 10, 0); // node 1: chord to prev = 10 m, fixed by the node position
    const tip = lastHandle(state, sec);
    if (tip === null) throw new Error("tip missing");
    const a = (30 * Math.PI) / 180;
    const dir: [number, number] = [Math.cos(a), Math.sin(a)];
    const order = Handle.order.get(tip);
    const authoredOut = (len: number) => {
        setTangent(state, sec, order, {
            mode: TangentMode.Free,
            inX: -5,
            inY: 0,
            outX: len * dir[0],
            outY: len * dir[1],
        });
        state.step(0);
        return selectedMetrics(state, tip);
    };
    const near = authoredOut(3); // a short out-handle
    const far = authoredOut(30); // pulled 10× further along the SAME ray
    expect(near?.angleLabel).toBe("30°"); // the exit heading (the out-vector direction)
    expect(far?.angleLabel).toBe(near?.angleLabel); // on-ray: heading unchanged
    expect(near?.lengthLabel).toBe("10 m"); // the chord to prev, not |out|
    expect(far?.lengthLabel).toBe(near?.lengthLabel); // invariant to the handle length
});

test("the section entry frame rotates the local heading into world", () => {
    // a curved first section leaves at a nonzero heading, so the appended section's entry frame is
    // rotated. a node whose LOCAL out-vector points along +x (0° local) must read the entry heading
    // in world — the rotation `tangents.ts` applies, mirrored here. a naive local read would show 0°.
    const { state, sec } = geoTrack();
    addNode(state, sec, 0, 0);
    addNode(state, sec, 10, 10); // section 0 exits at ~π/2 → section 1's entry frame is rotated
    const sec1 = appendSection(state, SectionKind.Geo);
    state.step(0);
    const info1 = sectionInfo.get(sec1);
    if (!info1) throw new Error("section 1 info missing");
    const entryDeg = (info1.entry.theta * 180) / Math.PI;
    expect(Math.abs(normDeg(entryDeg))).toBeGreaterThan(10); // a genuinely rotated frame
    const tip1 = lastHandle(state, sec1);
    if (tip1 === null) throw new Error("section 1 tip missing");
    // seed from the arc rule, then force the local out-vector to point along +x (0° local).
    const seed = seedTangent(state, sec1, Handle.order.get(tip1), TangentMode.Free);
    if (!seed) throw new Error("seed failed");
    setTangent(state, sec1, Handle.order.get(tip1), { ...seed, outX: 5, outY: 0 });
    state.step(0);
    // world exit heading = 0° local + entry.theta → the entry heading, NOT 0°.
    expect(exitWorld(tip1)).toBeCloseTo(info1.entry.theta, 6);
    expect(selectedMetrics(state, tip1)?.angleLabel).toBe(formatDeg(entryDeg));
});

// the polar arrow-nudge (`polarNudge`, the manipulators' keyboard twin): up/down step the chord
// LENGTH along its own direction, left/right rotate the chord ANGLE around the previous node by a
// fixed on-screen arc (step metres at the current radius → step/radius radians). the length floor
// keeps the chord from collapsing onto the previous node (a degenerate frame). `dir` is ±1.

const PREV0 = { x: 0, y: 0 };

test("length nudge steps the chord along its own direction, preserving the bearing", () => {
    // node 4 m out along +x; +1 m step → 5 m, still on +x (angle unchanged).
    expect(polarNudge(PREV0, { x: 4, y: 0 }, "length", 1, 1, 0.05)).toEqual({ x: 5, y: 0 });
    // −1 m step → 3 m.
    expect(polarNudge(PREV0, { x: 4, y: 0 }, "length", -1, 1, 0.05)).toEqual({ x: 3, y: 0 });
});

test("length nudge preserves a diagonal bearing (moves along the chord, not an axis)", () => {
    // node at 45°, chord = √2; +√2 step doubles the length along the same 45° ray → (2, 2).
    const n = polarNudge(PREV0, { x: 1, y: 1 }, "length", 1, Math.SQRT2, 0.05);
    expect(n.x).toBeCloseTo(2, 9);
    expect(n.y).toBeCloseTo(2, 9);
});

test("length nudge floors at minChord (can't collapse onto the previous node)", () => {
    // a huge shrink from 0.02 m clamps to the 0.05 m floor, not through zero (which flips the frame).
    const n = polarNudge(PREV0, { x: 0.02, y: 0 }, "length", -1, 1, 0.05);
    expect(n.x).toBeCloseTo(0.05, 9);
    expect(n.y).toBeCloseTo(0, 9);
});

test("angle nudge rotates around the previous node by step/radius, holding the length", () => {
    // node 4 m out along +x; a 1 m arc step at r=4 rotates by 0.25 rad, radius unchanged.
    const n = polarNudge(PREV0, { x: 4, y: 0 }, "angle", 1, 1, 0.05);
    expect(Math.hypot(n.x, n.y)).toBeCloseTo(4, 9); // length held
    expect(Math.atan2(n.y, n.x)).toBeCloseTo(0.25, 9); // +dir rotates CCW (world)
    // −dir rotates the other way by the same amount.
    const m = polarNudge(PREV0, { x: 4, y: 0 }, "angle", -1, 1, 0.05);
    expect(Math.atan2(m.y, m.x)).toBeCloseTo(-0.25, 9);
});

// feel round 8 — the write-end readout invariant: the value shown WHILE dragging a knob must equal
// the value at REST after release, exactly (the round-3 law at the write end). the angle bug: the
// drag snapped the exit incline against the previous node's geometry-RECOVERED heading (flanking
// baked samples), while the write re-heads the tip against its AUTHORED heading (`reflect(exitHeading
// (prev), chord)`), so the resting `exitWorld` landed off the snapped value (25° shown → 25.5° rest).

/** a curved geo section, so the previous node's recovered secant (flanking baked samples) differs
 *  from its authored heading — which is what makes the drag-vs-rest divergence visible. */
function curvedTip(): { state: State; tip: number; prev: number } {
    const { state, sec } = geoTrack();
    addNode(state, sec, 0, 0);
    addNode(state, sec, 10, 0);
    addNode(state, sec, 18, 7); // prev — a bend here makes the recovered secant ≠ the authored heading
    addNode(state, sec, 26, 11); // tip
    state.step(0);
    const tip = lastHandle(state, sec);
    if (tip === null) throw new Error("no tip");
    const prev = handleAt(state, sec, Handle.order.get(tip) - 1);
    if (prev === null) throw new Error("no prev");
    return { state, tip, prev };
}

test("angle drag: the snapped incline shown equals the resting exit heading (no 25→25.5 drift)", () => {
    const { state, tip } = curvedTip();
    const s = samples.get(trackOf(state));
    if (!s) throw new Error("no samples");
    const nf = nodeFrame(state, s, TX, tip);
    if (nf?.kind !== "polar") throw new Error("the tip must carry a polar frame");
    const f = nf.frame;
    // drag to a raw chord; snap on quantizes the exit incline to a 5° grid multiple.
    const raw = angleToPoint(f, 0.42);
    const res = angleControl(f, raw.x, raw.y, true);
    if (res.incline === null) throw new Error("the tip must carry an incline");
    // write the node exactly as the drag does (place on the arc at the snapped chord).
    writeNode(state, tip, angleToPoint(f, res.angle));
    // the drag readout showed res.incline; the resting readout shows exitWorld(tip) — they must match.
    const dragDeg = (res.incline * 180) / Math.PI;
    const restDeg = (exitWorld(tip) * 180) / Math.PI;
    expect(restDeg).toBeCloseTo(dragDeg, 4);
});

test("length drag: the snapped metres shown equal the resting chord (5 m rests at 5 m)", () => {
    const { state, tip, prev } = curvedTip();
    const s = samples.get(trackOf(state));
    if (!s) throw new Error("no samples");
    const nf = nodeFrame(state, s, TX, tip);
    if (nf?.kind !== "polar") throw new Error("the tip must carry a polar frame");
    const f = nf.frame;
    const raw = lengthToPoint(f, 5.02); // a raw pointer near 5 m
    const res = lengthControl(f, raw.x, raw.y, true);
    expect(res.meters).toBe(5); // snapped to the whole metre
    expect(res.meters).toBeGreaterThanOrEqual(LENGTH_MIN);
    writeNode(state, tip, lengthToPoint(f, res.meters));
    state.step(0); // re-bake so the resting samples reflect the write
    const prevW = { x: s.posX[Handle.sample.get(prev)], y: s.posY[Handle.sample.get(prev)] };
    const tipW = { x: s.posX[Handle.sample.get(tip)], y: s.posY[Handle.sample.get(tip)] };
    const restChord = Math.hypot(tipW.x - prevW.x, tipW.y - prevW.y);
    expect(restChord).toBeCloseTo(res.meters, 4); // dragged 5 m rests at 5 m, not 5.02
});

// kex2d-node-move-ux stage 2 — the interior chord-angle-snap law is RETIRED: an interior node no
// longer builds a polar frame at all (its own previous exit incline was never its reference —
// `tangent` was always null there), so its manipulator drags a `chordFrame` (slide ∥ / offset ⊥
// against the frozen prev→next chord), both axes on the SAME 1 m grid, no angle grid. This flips
// the old "an interior node snaps its chord angle" pin below to the new law.
test("an INTERIOR node's frame is the neighbor-chord frame, not polar (no angle grid any more)", () => {
    const { state, sec } = geoTrack();
    addNode(state, sec, 0, 0);
    addNode(state, sec, 10, 6); // node 1 — the interior we drag
    addNode(state, sec, 22, 8); // node 2
    addNode(state, sec, 30, 6); // node 3 (tip) — makes node 1 a clean interior (not last / last-1)
    state.step(0);
    const interior = handleAt(state, sec, 1);
    if (interior === null) throw new Error("no interior node");
    const s = samples.get(trackOf(state));
    if (!s) throw new Error("no samples");
    const nf = nodeFrame(state, s, TX, interior);
    if (nf?.kind !== "chord") throw new Error("an interior node must carry a chord frame"); // the retired law: no more polar frame on an interior node
    const f = nf.frame;

    // slide: a whole-metre grid, snap-writes-what-lands (the readout invariant, same shape as the
    // tip's length control).
    const rawSlide = slideToPoint(f, f.slide0 + 3.1);
    const slideRes = slideControl(f, rawSlide.x, rawSlide.y, true);
    expect(slideRes.meters).toBeCloseTo(Math.round(f.slide0 + 3.1), 6);
    writeNode(state, interior, slideToPoint(f, slideRes.meters));
    state.step(0);
    const wi = Handle.sample.get(interior);
    // `f` is built in screen px (`nodeFrame` projects world→screen through `TX`); re-project the
    // written world sample through the SAME transform before reading it back off the frame.
    const written = { x: TX.ox + s.posX[wi] * TX.sx, y: TX.oy + s.posY[wi] * TX.sy };
    // written offset (perpendicular to prev→next) is unchanged by a slide-only write.
    expect(screenToOffset(f, written.x, written.y)).toBeCloseTo(f.offset0, 4);

    // offset: same 1 m grid, sign preserved — no angle grid reachable from here at all.
    const rawOffset = offsetToPoint(f, -2.6);
    const offsetRes = offsetControl(f, rawOffset.x, rawOffset.y, true);
    expect(offsetRes.meters).toBeCloseTo(-3, 6);
});

// the geo multi-delete enablement (`suffixRun`, pure/device-free): Delete acts on a node set iff it
// is a CONTIGUOUS SUFFIX of ONE section's chain, excluding node 0, leaving ≥ 2 nodes — then it's k
// trims in one entry. anything else grays the row. `count` yields a section's node count.
describe("suffixRun — geo multi-delete enablement", () => {
    // a 5-node section (orders 0..4); the count fn a test can shadow per case.
    const count5 = (): number => 5;

    test("a contiguous suffix reaching the tip enables — returns the section + trim count k", () => {
        // orders {3,4} in a 5-node chain: a suffix ending at the tip (4), leaves 3 nodes.
        const run = suffixRun(
            [
                { section: 7, order: 3 },
                { section: 7, order: 4 },
            ],
            count5,
        );
        expect(run).toEqual({ section: 7, k: 2 });
    });

    test("the single tip is the size-1 case (today's trim) — k = 1", () => {
        expect(suffixRun([{ section: 7, order: 4 }], count5)).toEqual({ section: 7, k: 1 });
    });

    test("a gap in the run disqualifies (not contiguous)", () => {
        // {2,4}: skips order 3 — not a contiguous suffix.
        expect(
            suffixRun(
                [
                    { section: 7, order: 2 },
                    { section: 7, order: 4 },
                ],
                count5,
            ),
        ).toBeNull();
    });

    test("an interior suffix that doesn't reach the tip disqualifies", () => {
        // {2,3} in a 5-node chain: contiguous but order 4 (the tip) is unselected — intermediate.
        expect(
            suffixRun(
                [
                    { section: 7, order: 2 },
                    { section: 7, order: 3 },
                ],
                count5,
            ),
        ).toBeNull();
    });

    test("including node 0 (the entry anchor) disqualifies", () => {
        // even a full-chain selection {0..4} is not deletable — node 0 is the pinned entry.
        const all = [0, 1, 2, 3, 4].map((order) => ({ section: 7, order }));
        expect(suffixRun(all, count5)).toBeNull();
    });

    test("leaving fewer than 2 nodes disqualifies (a section keeps ≥ 2)", () => {
        // a 3-node chain (orders 0..2): trimming {1,2} would leave only node 0 — below the floor.
        const count3 = (): number => 3;
        expect(
            suffixRun(
                [
                    { section: 7, order: 1 },
                    { section: 7, order: 2 },
                ],
                count3,
            ),
        ).toBeNull();
        // trimming just the tip {2} leaves 2 nodes — allowed.
        expect(suffixRun([{ section: 7, order: 2 }], count3)).toEqual({ section: 7, k: 1 });
    });

    test("spanning two sections disqualifies (one section only)", () => {
        expect(
            suffixRun(
                [
                    { section: 7, order: 4 },
                    { section: 9, order: 4 },
                ],
                count5,
            ),
        ).toBeNull();
    });

    test("an empty set disqualifies", () => {
        expect(suffixRun([], count5)).toBeNull();
    });
});

// the section multi-delete enablement (`sectionsDeletable`, pure/device-free): Delete acts on a
// section SET iff it's smaller than the total section count — never every section, since the chain
// keeps at least one (the last-section floor, lifted from `deleteSection`'s per-call guard).
describe("sectionsDeletable — section multi-delete enablement", () => {
    test("a set smaller than the total is deletable", () => {
        expect(sectionsDeletable(2, 3)).toBe(true);
    });

    test("the single-section case (selected = 1) reduces to today's total > 1", () => {
        expect(sectionsDeletable(1, 1)).toBe(false); // the only section — can't delete it
        expect(sectionsDeletable(1, 2)).toBe(true);
    });

    test("a set equal to the total (every section) disqualifies", () => {
        expect(sectionsDeletable(3, 3)).toBe(false);
    });

    test("an empty set disqualifies", () => {
        expect(sectionsDeletable(0, 3)).toBe(false);
    });
});

// the section multi-join enablement (`sectionsJoinable`, pure/device-free): Join acts on a
// section SET iff it's a contiguous run of ≥2 sections all one kind (`joinNext`'s own same-kind
// guard, lifted to the set). Each clause pinned in isolation — a check that only proves the happy
// path can't tell a mutant that dropped one of the three from one that kept them all.
describe("sectionsJoinable — section multi-join enablement (contiguous run, ≥2, one kind)", () => {
    const rows = [
        { id: 1, order: 0, kind: SectionKind.Geo },
        { id: 2, order: 1, kind: SectionKind.Geo },
        { id: 3, order: 2, kind: SectionKind.Force },
        { id: 4, order: 3, kind: SectionKind.Force },
    ];

    test("a contiguous same-kind run of two is joinable", () => {
        expect(sectionsJoinable([1, 2], rows)).toBe(true);
        expect(sectionsJoinable([3, 4], rows)).toBe(true);
    });

    test("a run of three, one kind, joins", () => {
        const threeRows = [
            { id: 1, order: 0, kind: SectionKind.Geo },
            { id: 2, order: 1, kind: SectionKind.Geo },
            { id: 3, order: 2, kind: SectionKind.Geo },
        ];
        expect(sectionsJoinable([1, 2, 3], threeRows)).toBe(true);
    });

    test("fewer than two selected disqualifies — nothing to join", () => {
        expect(sectionsJoinable([1], rows)).toBe(false);
        expect(sectionsJoinable([], rows)).toBe(false);
    });

    test("a cross-kind pair disqualifies, even when adjacent", () => {
        expect(sectionsJoinable([2, 3], rows)).toBe(false);
    });

    test("a non-contiguous same-kind pair disqualifies — a gap in the run", () => {
        const gapRows = [
            { id: 1, order: 0, kind: SectionKind.Geo },
            { id: 2, order: 1, kind: SectionKind.Geo },
            { id: 3, order: 2, kind: SectionKind.Geo },
        ];
        expect(sectionsJoinable([1, 3], gapRows)).toBe(false); // skips the middle section
    });

    test("order is read from the row, not the id array's own order", () => {
        expect(sectionsJoinable([2, 1], rows)).toBe(true);
    });

    test("a stale id (no matching row) disqualifies", () => {
        expect(sectionsJoinable([1, 999], rows)).toBe(false);
    });

    // `history.joinSections` dedupes its own `ids` through a `Set` before validating the run
    // (the `removeSections`/`sectionsDeletable` precedent for a duplicated law reading the same
    // input shape) — a duplicated id must not make this copy disagree with that one at the same
    // edge, even though `editor.sections.ids` being itself a `Set` keeps it unreachable today.
    test("a duplicated id in the array dedupes to the same run — agrees with `joinSections`", () => {
        expect(sectionsJoinable([1, 2, 2], rows)).toBe(true);
        expect(sectionsJoinable([2, 1, 2, 1], rows)).toBe(true);
    });
});

// the section-structure surface — delete, EITHER convert direction, and the ruler's domain
// switch — is blocked entirely while a live pin session is open (kex2d-optimize-mode: the
// consent-boundary law; delete was stage 1's blocker, convert + domain stage 4's adversarial
// finding 2 — both were reachable in-mode and would have landed a track rewrite inside the
// open session, seen red in the capture flow's disabled-row asserts before the guard wired
// in). The BINDINGS rungs of the window keydown handlers have a DOM-free seam now (`keys.ts`,
// tested below) — what's left with none is the raw-Escape dismissal rung, the arrow-nudge rung,
// and `pickDomain`; the guard below is still extracted as its own predicate and tested directly,
// and every surface pairs the grayed affordance with the same guard at the action layer.
describe("sectionOpsAllowed — pin mode blocks delete, convert, and the domain switch", () => {
    test("no live session: the structure surface is allowed", () => {
        expect(sectionOpsAllowed(null)).toBe(true);
    });

    test("a live session on ANY section blocks the whole surface, not just its own section", () => {
        const session = {
            section: 7,
            stamp: { x: 0, y: 0, theta: 0, v: 10 },
            ghost: { x: new Float32Array(0), y: new Float32Array(0) },
            freeze: { x: 0, y: 0, theta: 0, v: 10 },
        };
        expect(sectionOpsAllowed(session)).toBe(false);
    });
});

// the editing lockdown's per-subject predicate (kex2d-optimize-mode stage 5): in-mode only the
// pinning section is editable — every edit surface (geo nodes, other sections' keys/extents,
// v0) pairs its grayed affordance with this same guard at the action layer.
describe("sectionEditable — the in-mode editing lockdown", () => {
    const session = {
        section: 7,
        stamp: { x: 0, y: 0, theta: 0, v: 10 },
        ghost: { x: new Float32Array(0), y: new Float32Array(0) },
        freeze: { x: 0, y: 0, theta: 0, v: 10 },
    };

    test("no live session: everything is editable", () => {
        expect(sectionEditable(null, 3)).toBe(true);
        expect(sectionEditable(null, -1)).toBe(true); // the track-global sentinel too
    });

    test("in-mode: only the pinning section passes; other sections and the track-global sentinel gray", () => {
        expect(sectionEditable(session, 7)).toBe(true);
        expect(sectionEditable(session, 3)).toBe(false);
        expect(sectionEditable(session, -1)).toBe(false); // v0 (track-global) is locked in-mode
    });
});

// Cut's two landmark enablement predicates (kex2d-structural-editing stage 4) — previously
// exercised only as raw booleans fed straight into the grammar oracle's own state generator
// (`menu.test.ts`'s `canCut`/`cuttable` matrices), never through the real function. Boundary
// coverage here closes that: each predicate's exact `>`/`<` (never `>=`/`<=`) is pinned at
// BOTH ends, not just proven true somewhere in the interior.
describe("nodeCuttable — the node landmark Cut point (`splitGeo`'s own interior bound)", () => {
    test("node 0 (the entry) is never cuttable, regardless of chain length", () => {
        expect(nodeCuttable(0, 4)).toBe(false);
        expect(nodeCuttable(0, 2)).toBe(false);
    });
    test("the chain end (order === count − 1) is never cuttable", () => {
        expect(nodeCuttable(3, 4)).toBe(false);
        expect(nodeCuttable(1, 2)).toBe(false); // the minimal two-node section: no interior exists
    });
    test("an interior order is cuttable", () => {
        expect(nodeCuttable(1, 4)).toBe(true);
        expect(nodeCuttable(2, 4)).toBe(true);
    });
});

describe("keyframeCuttable — the keyframe landmark Cut point (`splitForce`'s own interior bound)", () => {
    test("the section entry (s === 0) is never cuttable", () => {
        expect(keyframeCuttable(0, 40)).toBe(false);
    });
    test("the section exit (s === length) is never cuttable", () => {
        expect(keyframeCuttable(40, 40)).toBe(false);
    });
    test("an interior s is cuttable", () => {
        expect(keyframeCuttable(20, 40)).toBe(true);
        expect(keyframeCuttable(0.001, 40)).toBe(true); // just past the entry
        expect(keyframeCuttable(39.999, 40)).toBe(true); // just short of the exit
    });
});

// the key-act seam (kex2d-test-mechanism stage 2): the keyboard twin of `menus.ts`'s builders,
// one pure decider per `BINDINGS` home. Each guard's yield and each act's firing condition, over
// the vocabulary `tests/menu.test.ts` drives the same deciders against (the reverse-direction
// oracle) — these pin the PER-CASE behavior the drive-over-the-matrix test can't read off a
// pass/fail count alone.
describe("sectionKeyAct — the whole-section Delete + bulk-Join rungs", () => {
    test("off every binding: null regardless of state", () => {
        expect(sectionKeyAct("a", { opsAllowed: true, multi: false, joinable: false })).toBeNull();
        expect(
            sectionKeyAct("Enter", { opsAllowed: true, multi: true, joinable: true }),
        ).toBeNull();
    });
    test("the consent boundary bars both acts even on a bound key", () => {
        expect(
            sectionKeyAct("Delete", { opsAllowed: false, multi: false, joinable: false }),
        ).toBeNull();
        expect(
            sectionKeyAct("Backspace", { opsAllowed: false, multi: true, joinable: true }),
        ).toBeNull();
        expect(sectionKeyAct("j", { opsAllowed: false, multi: true, joinable: true })).toBeNull();
    });
    test("a single section fires remove; a multi-selection fires removeSet", () => {
        expect(sectionKeyAct("Delete", { opsAllowed: true, multi: false, joinable: false })).toBe(
            "remove",
        );
        expect(sectionKeyAct("Backspace", { opsAllowed: true, multi: true, joinable: false })).toBe(
            "removeSet",
        );
    });
    test("`J` fires join only over a valid run", () => {
        expect(sectionKeyAct("j", { opsAllowed: true, multi: true, joinable: true })).toBe("join");
        expect(sectionKeyAct("J", { opsAllowed: true, multi: true, joinable: true })).toBe("join");
    });
    test("`J` no-ops on an invalid (non-contiguous or single) selection, even with ops allowed", () => {
        expect(sectionKeyAct("j", { opsAllowed: true, multi: true, joinable: false })).toBeNull();
        expect(sectionKeyAct("j", { opsAllowed: true, multi: false, joinable: false })).toBeNull();
    });
    test("`D` fires solve when canSolve is true", () => {
        expect(
            sectionKeyAct("d", { opsAllowed: true, multi: false, joinable: false, canSolve: true }),
        ).toBe("solve");
        expect(
            sectionKeyAct("D", {
                opsAllowed: true,
                multi: false,
                joinable: false,
                canSolve: false,
            }),
        ).toBeNull();
    });
    test("Convert's own two-way fork: `D` fires solveShape when canSolveShape is true, winning over canSolve", () => {
        expect(
            sectionKeyAct("d", {
                opsAllowed: true,
                multi: false,
                joinable: false,
                canSolveShape: true,
                canSolve: true,
            }),
        ).toBe("solveShape");
        expect(
            sectionKeyAct("D", {
                opsAllowed: true,
                multi: false,
                joinable: false,
                canSolveShape: false,
                canSolve: true,
            }),
        ).toBe("solve");
        expect(
            sectionKeyAct("d", {
                opsAllowed: true,
                multi: false,
                joinable: false,
                canSolveShape: false,
                canSolve: false,
            }),
        ).toBeNull();
    });
    test("`P` fires pinEnter only when canPin is true", () => {
        expect(
            sectionKeyAct("p", { opsAllowed: true, multi: false, joinable: false, canPin: true }),
        ).toBe("pinEnter");
        expect(
            sectionKeyAct("P", { opsAllowed: true, multi: false, joinable: false, canPin: false }),
        ).toBeNull();
    });
    test("`R` fires reset only when canReset is true", () => {
        expect(
            sectionKeyAct("r", { opsAllowed: true, multi: false, joinable: false, canReset: true }),
        ).toBe("reset");
        expect(
            sectionKeyAct("R", {
                opsAllowed: true,
                multi: false,
                joinable: false,
                canReset: false,
            }),
        ).toBeNull();
    });
});

describe("nodeKeyAct — the node Enter/Delete rungs (chain-end trim + multi node-set trim)", () => {
    test("the editing lockdown bars every act, multi or single", () => {
        expect(nodeKeyAct("Delete", { editable: false, multi: true })).toBeNull();
        expect(
            nodeKeyAct("Enter", { editable: false, multi: false, endSelected: true }),
        ).toBeNull();
        // Reset applies to every node, but not through the editing lockdown either.
        expect(nodeKeyAct("r", { editable: false, multi: false, endSelected: true })).toBeNull();
    });
    test("a multi node-set only fires removeSet, never add", () => {
        expect(nodeKeyAct("Delete", { editable: true, multi: true })).toBe("removeSet");
        expect(nodeKeyAct("Enter", { editable: true, multi: true })).toBeNull();
    });
    test("a multi node-set fires resetSet", () => {
        expect(nodeKeyAct("r", { editable: true, multi: true })).toBe("resetSet");
        expect(nodeKeyAct("R", { editable: true, multi: true })).toBe("resetSet");
    });
    test("single-subject: off the chain end, neither add nor remove fires", () => {
        expect(
            nodeKeyAct("Enter", { editable: true, multi: false, endSelected: false }),
        ).toBeNull();
        expect(
            nodeKeyAct("Delete", { editable: true, multi: false, endSelected: false }),
        ).toBeNull();
    });
    // unlike Add/Remove/Cut, Reset applies to EVERY node — node 0, interior, and chain end alike
    // — so it's checked BEFORE the chain-end guard (`!s.endSelected`) rather than gated by it.
    test("Reset fires on an interior (non-chain-end) node — checked before the chain-end guard", () => {
        expect(nodeKeyAct("r", { editable: true, multi: false, endSelected: false })).toBe("reset");
    });
    test("Reset also fires on the chain end, same as an interior node", () => {
        expect(nodeKeyAct("R", { editable: true, multi: false, endSelected: true })).toBe("reset");
    });
    test("single-subject on the chain end: Enter adds, Delete removes", () => {
        expect(nodeKeyAct("Enter", { editable: true, multi: false, endSelected: true })).toBe(
            "add",
        );
        expect(nodeKeyAct("Delete", { editable: true, multi: false, endSelected: true })).toBe(
            "remove",
        );
    });
});

describe("forceKeyAct — the force-keyframe Delete/Lock rungs", () => {
    test("Delete removes unconditionally — no pin-mode or set-size guard", () => {
        expect(forceKeyAct("Delete", { pinning: false, size: 0 })).toBe("remove");
        expect(forceKeyAct("Backspace", { pinning: true, size: 3 })).toBe("remove");
    });
    test("Q toggles the lock only inside a live pin session over a non-empty set", () => {
        expect(forceKeyAct("q", { pinning: false, size: 3 })).toBeNull(); // no session open
        expect(forceKeyAct("Q", { pinning: true, size: 0 })).toBeNull(); // empty set
        expect(forceKeyAct("q", { pinning: true, size: 1 })).toBe("toggleLock");
    });
    test("off both bindings: null", () => {
        expect(forceKeyAct("Escape", { pinning: true, size: 3 })).toBeNull();
    });
    // adversarial-pass finding (kex2d-structural-editing stage 4, re-broken and closed again at
    // stage 6): C must not fire "cut" while ANY pin session is open — even on the pinning
    // session's OWN keyframe, where a looser per-section `editable` reading used to read true.
    // `cuttable` is purely the interior-point predicate and says nothing about the consent
    // boundary, mirroring `nodeKeyAct`'s top-level `editable` gate — `pinning` (the SAME field
    // the lock toggle reads) is Cut's own gate now, not a second hand-kept-in-sync field.
    test("C refuses under the lockdown even on a cuttable, single-select keyframe", () => {
        expect(forceKeyAct("c", { pinning: true, size: 1, cuttable: true })).toBeNull();
    });
    test("C cuts a cuttable, single-select keyframe when no pin session is open", () => {
        expect(forceKeyAct("C", { pinning: false, size: 1, cuttable: true })).toBe("cut");
    });
});

describe("modeKeyAct — the pin-mode Escape/Solve rung", () => {
    const open = {
        modeOpen: true,
        menuOpen: false,
        editing: false,
        selected: false,
        solvable: true,
        solving: false,
    };
    test("off BINDINGS.exitMode/solve, or the mode not open: null", () => {
        expect(modeKeyAct("a", open)).toBeNull();
        expect(modeKeyAct("Escape", { ...open, modeOpen: false })).toBeNull();
        expect(modeKeyAct("Enter", { ...open, modeOpen: false })).toBeNull();
    });
    test("every inner dismissal layer yields first — a summoned menu, an edit sub-mode, a live selection", () => {
        expect(modeKeyAct("Escape", { ...open, menuOpen: true })).toBeNull();
        expect(modeKeyAct("Escape", { ...open, editing: true })).toBeNull();
        expect(modeKeyAct("Escape", { ...open, selected: true })).toBeNull();
    });
    test("every inner layer yielded: Escape fires pinExit", () => {
        expect(modeKeyAct("Escape", open)).toBe("pinExit");
    });
    // Solve reads NONE of Escape's dismissal-ladder fields — it's the mode's primary action, not
    // a dismissal, matching the docked panel's own Solve button (`App.svelte`'s
    // `pinSolvable`/`disabled`), its keyboard twin (`BINDINGS.solve`, the mode-scoped `Enter`
    // exception, `kex2d-shortcuts` Locked decision 1's law 3).
    test("Solve fires regardless of a summoned menu, edit sub-mode, or live selection", () => {
        expect(modeKeyAct("Enter", { ...open, menuOpen: true })).toBe("pinSolve");
        expect(modeKeyAct("Enter", { ...open, editing: true })).toBe("pinSolve");
        expect(modeKeyAct("Enter", { ...open, selected: true })).toBe("pinSolve");
    });
    test("Solve refuses without headroom or mid-solve", () => {
        expect(modeKeyAct("Enter", { ...open, solvable: false })).toBeNull();
        expect(modeKeyAct("Enter", { ...open, solving: true })).toBeNull();
    });
    test("every condition met: Enter fires pinSolve", () => {
        expect(modeKeyAct("Enter", open)).toBe("pinSolve");
    });
});

// the group-drag wiring (`freezeChains` + `applyMultiDelta`): a drag derives a CUMULATIVE-from-start
// delta each pointermove and applies it to a FROZEN gesture-start snapshot, so successive frames read
// the same zero and land absolute — no accumulation. the pre-fix code read live `Handle.pos` as the
// start each frame, so frame 2's cumulative delta compounded on frame 1's already-moved positions (a
// 10 m chord dragged +3 then +5 ran away to 18/36 instead of 15/30). this pins the no-accumulation
// property at the wiring the blocker lived in.
describe("applyMultiDelta — group-drag idempotence (no accumulation)", () => {
    // a colinear 3-node geo section: node 0 (entry) at origin, nodes 1 and 2 along +x at 10 m chords.
    // entry frame is identity (first section), so section-local == world here.
    function triple(): { state: State; n1: number; n2: number } {
        const { state, sec } = geoTrack();
        addNode(state, sec, 0, 0);
        addNode(state, sec, 10, 0);
        addNode(state, sec, 20, 0);
        state.step(0);
        const n1 = handleAt(state, sec, 1);
        const n2 = handleAt(state, sec, 2);
        if (n1 === null || n2 === null) throw new Error("nodes missing");
        return { state, n1, n2 };
    }
    const localOf = (eid: number): { x: number; y: number } => ({
        x: Handle.pos.x.get(eid),
        y: Handle.pos.y.get(eid),
    });

    test("apply d then d' from the frozen start == a single application of d'", () => {
        // frame 1: cumulative +3. frame 2: cumulative +5 — both read the SAME frozen start ({0,10,20}).
        // a length +5 on the frozen chain, selected {1,2}: node1 chord 10→15 anchored at origin → (15,0);
        // node2 chord 10→15 anchored on the moved node1 (15,0) → (30,0). the intermediate +3 leaves no
        // trace — that's the property.
        const { state, n1, n2 } = triple();
        const frozen = freezeChains(state, [n1, n2]);
        applyMultiDelta(state, frozen, "length", 3);
        applyMultiDelta(state, frozen, "length", 5);
        expect(localOf(n1).x).toBeCloseTo(15, 4);
        expect(localOf(n1).y).toBeCloseTo(0, 4);
        expect(localOf(n2).x).toBeCloseTo(30, 4);
        expect(localOf(n2).y).toBeCloseTo(0, 4);

        // and it equals a single +5 applied once on a fresh identical track (the reference).
        const ref = triple();
        applyMultiDelta(ref.state, freezeChains(ref.state, [ref.n1, ref.n2]), "length", 5);
        expect(localOf(n1).x).toBeCloseTo(localOf(ref.n1).x, 4);
        expect(localOf(n2).x).toBeCloseTo(localOf(ref.n2).x, 4);
    });

    // the tip re-heads only on its OWN move (the same law reheadOnDrag holds for a single drag):
    // polarDelta moves only selected nodes, so a group move of the tip's predecessor leaves the tip
    // in place — re-heading it anyway swings the last segment under a gesture that never touched it.
    test("a group move excluding the tip preserves the tip's heading", () => {
        const { state, n1, n2 } = triple();
        const before = Handle.theta.get(n2);
        // rotate n1's chord +30° about the entry; n2 is unselected and must not move OR re-head.
        applyMultiDelta(state, freezeChains(state, [n1]), "angle", Math.PI / 6);
        expect(localOf(n2).x).toBeCloseTo(20, 4);
        expect(localOf(n2).y).toBeCloseTo(0, 4);
        expect(Handle.theta.get(n2)).toBeCloseTo(before, 6);
    });

    test("a group move including the tip still re-heads it", () => {
        const { state, n1, n2 } = triple();
        applyMultiDelta(state, freezeChains(state, [n1, n2]), "angle", Math.PI / 6);
        // both chords rotated +30°; n1's interior heading stays frozen at 0, so the tip reflects
        // to 2·chord − prev = 60°.
        expect(Handle.theta.get(n2)).toBeCloseTo(Math.PI / 3, 4);
    });
});

// kex2d-idioms stage 1 — inside tangent edit the subject's body drag is AUTHORING: the first
// armed move lazy-stamps the still-`Auto` node's tangents concrete (seeded jump-free from the
// live arc rule, the handle drag's own summon shape) and the write never re-heads. before the
// stamp, the body drag wrote through `dragTo` → `reheadOnDrag`, so the still-Auto node's
// displayed ghost handle swung to the circular-arc reflection every pointermove.
describe("tangent-edit free body drag (dragFreeTo)", () => {
    /** a curved three-node geo chain (first section, so entry = identity: world == local). */
    function curved(): { state: State; sec: number; tip: number } {
        const { state, sec } = geoTrack();
        addNode(state, sec, 0, 0);
        addNode(state, sec, 10, 0);
        addNode(state, sec, 18, 7); // the tip — a bend, so a re-head visibly swings theta
        state.step(0);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        return { state, sec, tip };
    }

    test("the first move stamps the tangents concrete — seeded from the live arc rule, jump-free", () => {
        const { state, sec, tip } = curved();
        const order = Handle.order.get(tip);
        expect(handleTangent(state, sec, order)).toBeUndefined(); // still Auto at grab
        const seed = seedTangent(state, sec, order, TangentMode.Aligned); // the live arc rule NOW
        if (!seed) throw new Error("no seed");
        dragFreeTo(state, tip, 18.4, 7.3); // the first armed move
        const tan = handleTangent(state, sec, order);
        if (!tan) throw new Error("not stamped"); // concretized at drag start
        // the stamp IS the live arc-rule seed (no jump) — exact to the tangent column's own f32
        // rounding (the store is f32; the seed is computed in f64).
        expect(tan.mode).toBe(TangentMode.Aligned);
        expect(tan.inX).toBe(Math.fround(seed.inX));
        expect(tan.inY).toBe(Math.fround(seed.inY));
        expect(tan.outX).toBe(Math.fround(seed.outX));
        expect(tan.outY).toBe(Math.fround(seed.outY));
    });

    test("heading never re-derives mid-drag — the stamped tangent holds, theta untouched", () => {
        const { state, sec, tip } = curved();
        const order = Handle.order.get(tip);
        const theta0 = Handle.theta.get(tip);
        dragFreeTo(state, tip, 19, 9);
        expect(Handle.theta.get(tip)).toBe(theta0); // the stored heading never re-derives
        const stamped = handleTangent(state, sec, order);
        if (!stamped) throw new Error("not stamped");
        dragFreeTo(state, tip, 21, 12); // keep dragging — no per-pointermove swing
        expect(Handle.theta.get(tip)).toBe(theta0);
        expect(handleTangent(state, sec, order)).toEqual(stamped); // held absolute under the drag
        // and the position still writes through (first section: world == local).
        expect(Handle.pos.x.get(tip)).toBeCloseTo(21, 6);
        expect(Handle.pos.y.get(tip)).toBeCloseTo(12, 6);
    });
});

// ── pickForce (kex2d-idioms stage 3): the viewport force-marker pick — select + menu only,
// never a drag. slots between node and START in the handler sweeps; here the pure radius/
// nearest behavior is pinned over a real baked force section, through the synthetic TX.
describe("pickForce", () => {
    function forceTrack(): { state: State; sec: number } {
        const { state, sec } = geoTrack();
        addNode(state, sec, 0, 0);
        addNode(state, sec, EXTEND_DIST, 0);
        state.step(0);
        convertSection(state, sec); // → force, two seed keyframes (entry + exit)
        state.step(1 / 60);
        return { state, sec };
    }

    test("nearest marker within the radius wins; outside is null", () => {
        const { state } = forceTrack();
        const ms = forceMarkers(state);
        expect(ms.length).toBe(2);
        const px = (m: { x: number; y: number }): { x: number; y: number } => ({
            x: TX.ox + m.x * TX.sx,
            y: TX.oy + m.y * TX.sy,
        });
        const p0 = px(ms[0]);
        const p1 = px(ms[1]);
        // a few px off the marker still picks it; the other marker (far away) never does.
        expect(pickForce(state, TX, p0.x + 3, p0.y - 2)).toBe(ms[0].id);
        expect(pickForce(state, TX, p1.x - 2, p1.y + 3)).toBe(ms[1].id);
        // just outside the pick radius: nothing.
        expect(pickForce(state, TX, p0.x, p0.y + 13)).toBeNull();
        // between the two, nearer the exit marker: the nearest wins. the probe is CONSTRUCTED
        // inside the pick radius — 5 px off the exit marker toward the entry marker — so the
        // assert always runs (a midpoint probe could fall outside r = 12 and pin nothing).
        const L = Math.hypot(p0.x - p1.x, p0.y - p1.y);
        expect(L).toBeGreaterThan(24); // the two markers sit a section apart — well clear
        const probe = {
            x: p1.x + (5 * (p0.x - p1.x)) / L,
            y: p1.y + (5 * (p0.y - p1.y)) / L,
        };
        expect(pickForce(state, TX, probe.x, probe.y)).toBe(ms[1].id);
    });

    test("a geo track has no markers to pick", () => {
        const { state, sec } = geoTrack();
        addNode(state, sec, 0, 0);
        addNode(state, sec, EXTEND_DIST, 0);
        state.step(0);
        expect(pickForce(state, TX, TX.ox, TX.oy)).toBeNull();
    });
});

// ── pickForceOrStart (the stage-3 review fix): a force-first section's s=0 seed keyframe
// sits exactly ON the START diamond and both pick at r=12, so a fixed force-before-START
// order made START — the only path to the v0 popover — permanently unclickable. Nearest
// wins; an exact tie goes to START (the coincident seed stays reachable on the chart).
describe("pickForceOrStart", () => {
    function forceTrack(): { state: State; sec: number } {
        const { state, sec } = geoTrack();
        addNode(state, sec, 0, 0);
        addNode(state, sec, EXTEND_DIST, 0);
        state.step(0);
        convertSection(state, sec); // → force-FIRST: the s=0 seed lands on the START diamond
        state.step(1 / 60);
        return { state, sec };
    }

    test("a click at the origin of a force-first track resolves START, not the seed key", () => {
        const { state } = forceTrack();
        // world (0,0) is both the START diamond and the s=0 seed marker: an exact tie → START.
        expect(pickForceOrStart(state, TX, TX.ox, TX.oy)).toEqual({ kind: "start" });
        // a few px off center the two stay coincident — still a tie, still START.
        expect(pickForceOrStart(state, TX, TX.ox + 4, TX.oy - 3)).toEqual({ kind: "start" });
    });

    test("nearest wins each way when START and a marker sit apart but overlap", () => {
        const { state, sec } = forceTrack();
        // a key 0.5 m in: ~20 px from the origin at sx=40, so the two pick discs overlap.
        const id = createForcePoint(state, sec, 0.5, 1);
        state.step(2 / 60);
        const m = forceMarkers(state).find((mk) => mk.id === id);
        if (!m) throw new Error("marker missing");
        const mp = { x: TX.ox + m.x * TX.sx, y: TX.oy + m.y * TX.sy };
        // 55% along START→marker: ~11 px to START, ~9 px to the key — the key wins.
        const p55 = { x: TX.ox + 0.55 * (mp.x - TX.ox), y: TX.oy + 0.55 * (mp.y - TX.oy) };
        expect(pickForceOrStart(state, TX, p55.x, p55.y)).toEqual({ kind: "force", id });
        // 45% along: ~9 px to START, ~11 px to the key — START wins.
        const p45 = { x: TX.ox + 0.45 * (mp.x - TX.ox), y: TX.oy + 0.45 * (mp.y - TX.oy) };
        expect(pickForceOrStart(state, TX, p45.x, p45.y)).toEqual({ kind: "start" });
    });
});

// ── pickHover (kex2d-burndown stage 3): the pointermove sweep's pure core — the four pickers
// run in the same PICK order `onPointerDown` grabs by (a summoned knob wins first, then its
// node, then a force marker, else the section span), so hover matches exactly what a click
// would take. Factored out of the DOM-bound `attachControls` closure so it's unit-testable
// without a canvas — the real wiring `onPointerMove` calls, not a restatement of it.
describe("pickHover", () => {
    /** a three-node geo chain, tangent-edited on its tip (first section, so entry is identity —
     *  world == local) with a deliberately SHORT explicit out-handle — short enough that its
     *  knob lands inside the node's own pick radius too, the exact "handle over its node"
     *  overlap `onPointerDown`'s comment calls out. real coincidence, not two probes on
     *  separate glyphs: it's the only case where pick ORDER (not just radius) decides the
     *  read. */
    function tangentTrack(): { state: State; sec: number; tip: number } {
        const { state, sec } = geoTrack();
        addNode(state, sec, 0, 0);
        addNode(state, sec, 10, 0);
        addNode(state, sec, 18, 7);
        state.step(0);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        const order = Handle.order.get(tip);
        // 0.1 m at TX.sx=40 is a 4 px knob offset — inside both TANGENT_PICK_R (11) and PICK_R
        // (16), so the node's own pick disc covers the knob's screen point too.
        setTangent(state, sec, order, {
            mode: TangentMode.Free,
            inX: 0.1,
            inY: 0,
            outX: 0.1,
            outY: 0,
        });
        state.step(1 / 60);
        enterTangentEdit(tip);
        return { state, sec, tip };
    }

    afterEach(() => {
        exitTangentEdit(); // a leaked `editor.tangentEdit` would leak the knob into later tests
    });

    test("a knob wins over its own node — the click priority, mutually exclusive both ways", () => {
        const { state, tip } = tangentTrack();
        const trackEid = [...state.query([Track])][0];
        const s = samples.get(trackEid);
        if (!s) throw new Error("no bake");
        const set = [...editHandleSets(state, s, TX, tip)].find((st) => st.eid === tip);
        const knob = set?.handles.find((h) => h.side === "in");
        if (!knob) throw new Error("no in-handle");
        const i = Handle.sample.get(tip);
        const nx = TX.ox + s.posX[i] * TX.sx;
        const ny = TX.oy + s.posY[i] * TX.sy;
        // the overlap this test depends on: the knob sits inside the node's OWN pick radius too.
        expect(Math.hypot(knob.x - nx, knob.y - ny)).toBeLessThan(PICK_R);

        // probing at the node's screen point (== the knob's, to float precision): the knob
        // wins — the same priority `onPointerDown` grabs by — and the node it sits over,
        // itself pickable at this exact point, stays unlit.
        const hover = pickHover(state, TX, nx, ny);
        expect(hover.knob).toEqual({ eid: tip, side: "in" });
        expect(hover.node).toBeNull();
        expect(hover.force).toBeNull();
        expect(hover.section).toBeNull();
    });

    test("outside tangent edit the same point picks only the node — no stray knob read", () => {
        const { state, tip } = tangentTrack();
        exitTangentEdit(); // this test's own scope: no leftover handles to grab
        const trackEid = [...state.query([Track])][0];
        const s = samples.get(trackEid);
        if (!s) throw new Error("no bake");
        const i = Handle.sample.get(tip);
        const nx = TX.ox + s.posX[i] * TX.sx;
        const ny = TX.oy + s.posY[i] * TX.sy;
        const hover = pickHover(state, TX, nx, ny);
        expect(hover.knob).toBeNull();
        expect(hover.node).toBe(tip);
    });

    test("a force marker lights only when no knob or node is under the pointer", () => {
        const { state, sec } = geoTrack();
        addNode(state, sec, 0, 0);
        addNode(state, sec, EXTEND_DIST, 0);
        state.step(0);
        convertSection(state, sec);
        state.step(1 / 60);
        const ms = forceMarkers(state);
        const m = ms[1]; // ms[0] (s=0) coincides with the START diamond — pickForceOrStart's own
        // tie rule would resolve that one to START, not the marker (the existing pickForceOrStart
        // pin above); the exit marker sits clear of it.
        const hover = pickHover(state, TX, TX.ox + m.x * TX.sx + 3, TX.oy + m.y * TX.sy - 2);
        expect(hover.knob).toBeNull();
        expect(hover.node).toBeNull();
        expect(hover.force).toBe(m.id);
        expect(hover.section).toBeNull();
    });

    test("the section span lights only when nothing else is under the pointer", () => {
        const { state, sec } = geoTrack();
        addNode(state, sec, 0, 0);
        addNode(state, sec, EXTEND_DIST, 0);
        state.step(0);
        // the segment midpoint, off any node/knob/marker pick radius.
        const midX = TX.ox + (EXTEND_DIST / 2) * TX.sx;
        const midY = TX.oy;
        const hover = pickHover(state, TX, midX, midY);
        expect(hover.knob).toBeNull();
        expect(hover.node).toBeNull();
        expect(hover.force).toBeNull();
        expect(hover.section).toBe(sec);
    });
});

// ── the hover seam (kex2d-followups stage 3, follow-up 7): `pickHover`'s four reads are now
// written and cleared through ONE pair of functions — `editor.writeHover`/`clearHover` — instead
// of four literal field assignments repeated at every site. `writeHover` is pointermove's one
// write; `clearHover` is shared by all three clear sites (`editor.beginDrag`'s whole-gesture
// suppression, `attachControls`'s pointerleave, and its remount teardown). A site clearing three
// siblings but missing `hoverKnob` was exactly the bug class the seam closes (kex2d-idioms 10b's
// stale-hover class, one field short) — there's now one call to get right, not four assignments to
// keep in sync. The seam functions themselves live in `editor.ts` beside the hover fields they
// mutate (`tests/editor.test.ts` pins their pure behavior); this file keeps only what needs a real
// `attachControls` wiring — `beginDrag`'s clear, and the pointerleave/detach closures below.

describe("editor.beginDrag clears the hover seam for the whole of any gesture", () => {
    test("a real beginDrag call clears all four hover reads, through clearHover", () => {
        // `beginDrag` is exported and DOM-free apart from reaching for `window.addEventListener`
        // to arm the release listeners (unreachable headless — no `window` under `bun test`); shim
        // it locally, scoped to this test, so the REAL production function runs end to end rather
        // than a restatement of it.
        const g = globalThis as Record<string, unknown>;
        g.window = { addEventListener() {}, removeEventListener() {} };
        try {
            editor.hoverSection = 1;
            editor.hoverNode = 2;
            editor.hoverForce = 3;
            editor.hoverKnob = { eid: 4, side: "in" };
            const fakeEl = {
                setPointerCapture() {},
                addEventListener() {},
                removeEventListener() {},
            } as unknown as Element;
            beginDrag(fakeEl, 1);
            expect(editor.hoverKnob).toBeNull();
            expect(editor.hoverSection).toBeNull();
            expect(editor.hoverNode).toBeNull();
            expect(editor.hoverForce).toBeNull();
        } finally {
            delete g.window;
        }
    });
});

// controls.ts's pointerleave and remount-teardown clears now run through the SAME `clearHover`
// seam, which makes them reachable BEHAVIORALLY instead of needing a source grep (the promotion
// this stage exists for, `kex2d-followups.md`'s locked decision): shim a minimal canvas + window
// (the same shape `beginDrag`'s shim above uses), call the REAL `attachControls`, capture the two
// closures it registers or returns, and fire them — no restatement of the clearing logic, the
// production listener runs end to end and the assert reads the resulting editor state, not the
// source text.
describe("attachControls's pointerleave and remount teardown both clear the hover seam", () => {
    /** a canvas double that RECORDS every listener `attachControls` registers, keyed by event
     *  type, so a test can fire the exact production closure instead of grepping for it. */
    function fakeCanvas(): { el: HTMLCanvasElement; listeners: Map<string, () => void> } {
        const listeners = new Map<string, () => void>();
        const el = {
            style: {},
            addEventListener(type: string, fn: () => void) {
                listeners.set(type, fn);
            },
            removeEventListener() {},
            setPointerCapture() {},
            hasPointerCapture: () => false,
            releasePointerCapture() {},
        } as unknown as HTMLCanvasElement;
        return { el, listeners };
    }

    function withWindow<T>(fn: () => T): T {
        const g = globalThis as Record<string, unknown>;
        g.window = { addEventListener() {}, removeEventListener() {} };
        try {
            return fn();
        } finally {
            delete g.window;
        }
    }

    function litHover(): void {
        editor.hoverSection = 1;
        editor.hoverNode = 2;
        editor.hoverForce = 3;
        editor.hoverKnob = { eid: 4, side: "in" };
    }

    function expectCleared(): void {
        expect(editor.hoverKnob).toBeNull();
        expect(editor.hoverSection).toBeNull();
        expect(editor.hoverNode).toBeNull();
        expect(editor.hoverForce).toBeNull();
    }

    test("a real pointerleave dispatch clears all four fields", () => {
        withWindow(() => {
            const { el, listeners } = fakeCanvas();
            const { detach } = attachControls(el, new State());
            litHover();
            const leave = listeners.get("pointerleave");
            if (!leave) throw new Error("no pointerleave listener registered");
            leave();
            expectCleared();
            detach();
        });
    });

    test("detach (remount teardown) clears all four fields — the same real closure", () => {
        withWindow(() => {
            const { el } = fakeCanvas();
            const { detach } = attachControls(el, new State());
            litHover();
            detach();
            expectCleared();
        });
    });
});

// ── the S2 dismissal law (kex2d-selection-laws): a dismissal reads the unified member set, ────
// never one kind's view ────────────────────────────────────────────────────────────────────
// editor-ui.md § Multi context UI: "Esc clears the whole set as one dismissal rung, not N." one
// press on a cross-kind selection clears every member of every kind, from EITHER surface — the
// viewport's Escape rung and its empty-click / empty-marquee twins used to hand-pair partial
// per-kind sweeps (node/force/section/start) and leave a co-selected strip, strip keyframe, or
// one-shot standing; the timeline's per-kind rungs peeled one kind at a time. the viewport arms
// below fire the REAL listeners `attachControls` registers (the window keydown closure, the
// canvas pointerdown/up pair), and the timeline arms call the rung ladders `Timeline.svelte`'s
// own keydown handler calls (`forceEscape`/`stripEscape`/`oneShotEscape`, `controls.ts` — the
// production dismissal paths, not restatements). every selection is built through the production
// selectors (`selectForce` + `"toggle"` = the shift-click pair, `selectStrip`/`selectStripKf` =
// the band click / plain keyframe click, `enterTangentEdit`/`enterForceEdit` = the summons).
describe("S2 — one dismissal reads the member set: one press clears a cross-kind selection", () => {
    afterEach(() => {
        deselectAll();
        endDragGesture(); // the window shims swallow `beginDrag`'s own release listeners
        marquee.rect = null;
    });

    /** the whole member set, every kind at once: each kind view empty, no active member left
     *  for a key to route through. */
    function expectNothingSelected(): void {
        expect(editor.nodes.ids.size).toBe(0);
        expect(editor.forces.ids.size).toBe(0);
        expect(editor.sections.ids.size).toBe(0);
        expect(editor.strips.ids.size).toBe(0);
        expect(editor.stripKfs.ids.size).toBe(0);
        expect(editor.start).toBe(false);
        expect(editor.oneShot).toBe(false);
        expect(activeKind()).toBeNull();
    }

    /** a canvas double recording every listener `attachControls` registers (keyed by event
     *  type) and carrying the DOM reads its pointer handlers take — `getBoundingClientRect` for
     *  `pointerToCanvas`, `clientWidth/Height` for `viewTransform`. */
    function recordingCanvas(): {
        el: HTMLCanvasElement;
        on: (type: string) => (e: unknown) => void;
    } {
        const listeners = new Map<string, (e: unknown) => void>();
        const el = {
            style: {},
            clientWidth: 1000,
            clientHeight: 800,
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
            addEventListener(type: string, fn: (e: unknown) => void) {
                listeners.set(type, fn);
            },
            removeEventListener() {},
            setPointerCapture() {},
            hasPointerCapture: () => false,
            releasePointerCapture() {},
        } as unknown as HTMLCanvasElement;
        return {
            el,
            on: (type: string) => {
                const fn = listeners.get(type);
                if (!fn) throw new Error(`no ${type} listener registered`);
                return fn;
            },
        };
    }

    /** a window double recording the keydown/blur listeners `attachControls` registers on
     *  `window` — the headless suite has no `window` of its own (the same shim shape the hover
     *  describe above uses, minus the discard). the `keydown` handed to the arm resolves the
     *  recorded listener LAZILY, on each press — the arm registers `attachControls` itself
     *  inside the shim's lifetime. */
    function withRecordingWindow(fn: (keydown: (e: unknown) => void) => void): void {
        const listeners = new Map<string, (e: unknown) => void>();
        const g = globalThis as Record<string, unknown>;
        g.window = {
            addEventListener(type: string, l: (e: unknown) => void) {
                listeners.set(type, l);
            },
            removeEventListener() {},
        };
        try {
            fn((e: unknown) => {
                const keydown = listeners.get("keydown");
                if (!keydown) throw new Error("no keydown listener registered");
                keydown(e);
            });
        } finally {
            delete g.window;
        }
    }

    /** the shared viewport fixture: a two-node geo track, baked, behind TX's own affine (zoom
     *  40, origin (500, 400)) — the nodes land at screen (500, 400) and (1460, 400), so
     *  everything near (10, 10) is empty space. */
    function bakedTrack(): { state: State; sec: number } {
        const { state, sec } = geoTrack();
        addNode(state, sec, 0, 0);
        addNode(state, sec, EXTEND_DIST, 0);
        state.step(0);
        setCamera({ zoom: 40, ox: 500, oy: 400 });
        return { state, sec };
    }

    // ── the viewport surface: Escape ──

    test("one VIEWPORT Escape clears a cross-kind set (force + node, active node) — one press, every kind", () => {
        withRecordingWindow((keydown) => {
            const { el } = recordingCanvas();
            const { detach } = attachControls(el, new State());
            // the production shift-click pair: a plain click replace-selects the force marker,
            // the shift-click toggle ADDS the node without sweeping — {force, node}, active
            // node, so the viewport rung (controls.ts) is the handler whose guard passes.
            selectForce(3);
            select(7, "toggle");
            expect(activeKind()).toBe("node");
            keydown({ key: "Escape", preventDefault() {} });
            expectNothingSelected();
            detach();
        });
    });

    test("the tangent-edit peel still comes first — one press exits the mode, only the next clears", () => {
        withRecordingWindow((keydown) => {
            const { el } = recordingCanvas();
            const { detach } = attachControls(el, new State());
            // the production summon (double-click) replace-selects node 7 and layers tangent
            // edit; the shift-click pair then ADDS the force — cross-kind, mode still open
            // (a toggle never reconciles the sub-mode away).
            enterTangentEdit(7);
            selectForce(3, "toggle");
            expect(editor.tangentEdit).toBe(7);
            keydown({ key: "Escape", preventDefault() {} }); // press 1: the mode peels...
            expect(editor.tangentEdit).toBeNull();
            expect(editor.nodes.ids.size).toBe(1); // ...and the SET survives the press
            expect(editor.forces.ids.size).toBe(1);
            // press 2 routes to the timeline's force rung (the active member is the force):
            // the cross-kind clear, through the same ladder `Timeline.svelte` calls.
            forceEscape();
            expectNothingSelected();
            detach();
        });
    });

    // ── the viewport surface: the empty clear ──

    test("a VIEWPORT empty CLICK clears a cross-kind set (strip + section) — the unarmed release", () => {
        withRecordingWindow(() => {
            const { el, on } = recordingCanvas();
            const { state, sec } = bakedTrack();
            const { detach } = attachControls(el, state);
            // the production pair: the timeline band click `selectStrip`, the clip shift-click
            // `selectSection` toggle — {strip, section}, cross-kind.
            selectStrip(5);
            selectSection(sec, "toggle");
            expect(editor.strips.ids.size).toBe(1);
            expect(editor.sections.ids.size).toBe(1);
            on("pointerdown")({
                button: 0,
                pointerId: 1,
                clientX: 10,
                clientY: 10,
                shiftKey: false,
            });
            on("pointerup")({});
            endDragGesture(); // stand in for `beginDrag`'s own release listener, while the shim lives
            expectNothingSelected();
            detach();
        });
    });

    test("a VIEWPORT empty MARQUEE (armed, no hits) clears a cross-kind set too", () => {
        withRecordingWindow(() => {
            const { el, on } = recordingCanvas();
            const { state } = bakedTrack();
            const { detach } = attachControls(el, state);
            selectStrip(5);
            selectForce(3, "toggle"); // the chart shift-click — {strip, force}, cross-kind
            on("pointerdown")({
                button: 0,
                pointerId: 1,
                clientX: 10,
                clientY: 10,
                shiftKey: false,
            });
            on("pointermove")({ pointerId: 1, clientX: 60, clientY: 60 }); // past DRAG_PX: armed
            on("pointerup")({});
            endDragGesture(); // stand in for `beginDrag`'s own release listener, while the shim lives
            expectNothingSelected();
            detach();
        });
    });

    test("a strip is not Delete-able after a viewport empty click — the production delete op finds nothing", () => {
        withRecordingWindow(() => {
            const { el, on } = recordingCanvas();
            const { state } = bakedTrack();
            const strip = addStrip(history, state, 0, 10, 12); // the band's own authoring act
            if (strip === null) throw new Error("strip refused");
            const { detach } = attachControls(el, state);
            selectStrip(strip); // the production band-click selector
            expect(editor.strips.ids.size).toBe(1);
            on("pointerdown")({
                button: 0,
                pointerId: 1,
                clientX: 10,
                clientY: 10,
                shiftKey: false,
            });
            on("pointerup")({});
            endDragGesture(); // stand in for `beginDrag`'s own release listener, while the shim lives
            expectNothingSelected();
            // the op the Delete key routes to (Timeline's strip rung calls this exact op): with
            // the member set empty there is nothing Delete-able — the strip ENTITY survives.
            expect(mixedSetDelete(state)).toBe(false);
            expect(stripAt(state, strip)).not.toBeNull();
            detach();
        });
    });

    // ── the timeline surface: the per-kind rungs ──

    test("one TIMELINE Escape rung clears a cross-kind set (node + force, active force)", () => {
        // the production pair: the viewport body click `select`, then the chart shift-click
        // `selectForce` toggle ADDS the keyframe — {node, force}, active force, so the
        // timeline's force rung is the handler whose guard passes.
        select(7);
        selectForce(3, "toggle");
        expect(activeKind()).toBe("force");
        forceEscape();
        expectNothingSelected();
    });

    test("one TIMELINE Escape rung clears a cross-kind set (force + strip, active strip)", () => {
        selectForce(3);
        selectStrip(5, "toggle"); // the band shift-click
        expect(activeKind()).toBe("strip");
        stripEscape();
        expectNothingSelected();
    });

    test("one TIMELINE Escape rung clears a cross-kind set (oneShot + strip, active strip)", () => {
        selectOneShot(true); // the one-shot's own select — replace, clears the rest
        selectStrip(5, "toggle"); // ...and the band shift-click adds the strip, active strip
        expect(activeKind()).toBe("strip");
        stripEscape();
        expectNothingSelected();
    });

    // ── the within-kind peel ladders survive ──

    test("within the force kind the ladder is unchanged: handle peels, then handle edit, then the set", () => {
        selectForce(5);
        enterForceEdit(5); // the production double-click summon
        selectForceHandle("in"); // grabbing a summoned handle
        forceEscape(); // press 1: back to the keyframe readout
        expect(editor.forceHandle).toBeNull();
        expect(editor.forceEdit).toBe(5);
        expect(editor.forces.ids.size).toBe(1);
        forceEscape(); // press 2: handle edit exits, the point stays selected
        expect(editor.forceEdit).toBeNull();
        expect(editor.forces.ids.size).toBe(1);
        forceEscape(); // press 3: the selection clears
        expectNothingSelected();
    });

    test("within the velocity domain the ladder is unchanged: a strip keyframe peels before its strip", () => {
        // the production plain click on a strip keyframe — `selectStripKf`'s containment sweep
        // keeps the owning strip, so {strip, stripKf} by construction: nesting, not siblings.
        selectStrip(1);
        selectStripKf(10);
        expect(editor.strips.ids.size).toBe(1);
        expect(editor.stripKfs.ids.size).toBe(1);
        stripEscape(); // press 1: the keyframe selection peels, the strip stays
        expect(editor.stripKfs.ids.size).toBe(0);
        expect(editor.strips.ids.size).toBe(1);
        stripEscape(); // press 2: the strip clears
        expectNothingSelected();
    });

    test("the oneShot rung still clears its own singleton within the kind", () => {
        selectOneShot(true);
        oneShotEscape();
        expectNothingSelected();
    });

    // ── the cross-kind read itself ──

    test("crossKind reads the member set: the velocity pair is nesting, a force beside it a sibling", () => {
        selectStrip(1);
        selectStripKf(10); // the containment pair — {strip, stripKf} by construction
        expect(crossKind(["strip", "stripKf"])).toBe(false); // nesting, not cross-kind
        expect(crossKind(["force"])).toBe(true); // both members sit outside the force domain
        selectForce(3, "toggle"); // a genuine sibling joins
        expect(crossKind(["strip", "stripKf"])).toBe(true);
    });
});
