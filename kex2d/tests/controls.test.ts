import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    applyMultiDelta,
    armDrag,
    beyondDeadZone,
    DRAG_PX,
    dragFreeTo,
    formatDeg,
    formatLen,
    freezeChains,
    latchAngle,
    LATCH_PX,
    manipKnobs,
    nodeFrame,
    nodeMetrics,
    normDeg,
    pickForce,
    pickForceOrStart,
    polarNudge,
    sectionEditable,
    sectionOpsAllowed,
    sectionsDeletable,
    selectedMetrics,
    suffixRun,
} from "../src/controls";
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
    Track,
} from "../src/track";

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
    if (!nf || nf.kind !== "polar") throw new Error("the tip must carry a polar frame");
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
    if (!nf || nf.kind !== "polar") throw new Error("the tip must carry a polar frame");
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
    if (!nf || nf.kind !== "chord") throw new Error("an interior node must carry a chord frame"); // the retired law: no more polar frame on an interior node
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

// the section-structure surface — delete, EITHER convert direction, and the ruler's domain
// switch — is blocked entirely while a live pin session is open (kex2d-optimize-mode: the
// consent-boundary law; delete was stage 1's blocker, convert + domain stage 4's adversarial
// finding 2 — both were reachable in-mode and would have landed a track rewrite inside the
// open session, seen red in the capture flow's disabled-row asserts before the guard wired
// in). The window keydown handlers and `pickDomain` have no DOM-free unit-test seam, so the
// guard is extracted as this one predicate and tested directly; every surface pairs the grayed
// affordance with the same guard at the action layer.
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
