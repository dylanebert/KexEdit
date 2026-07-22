import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    armDrag,
    beyondDeadZone,
    DRAG_PX,
    dragMetrics,
    formatDeg,
    formatLen,
    latchAngle,
    LATCH_PX,
    nodeFrame,
    nodeMetrics,
    normDeg,
    polarNudge,
    selectedMetrics,
} from "../src/controls";
import { ANGLE_STEP, LENGTH_MIN } from "../src/magnet";
import { angleControl, angleToPoint, lengthControl, lengthToPoint } from "../src/manipulator";
import { localize } from "../src/section";
import { TangentMode } from "../src/spline";
import {
    addNode,
    appendSection,
    BakeSystem,
    createSection,
    createTrack,
    EXTEND_DIST,
    exitWorld,
    Handle,
    handleAt,
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
// (exactly what `dragTo` does inside the controls).
function writeNode(state: State, eid: number, screen: { x: number; y: number }): void {
    const world = { x: (screen.x - TX.ox) / TX.sx, y: (screen.y - TX.oy) / TX.sy };
    const entry = sectionInfo.get(Handle.section.get(eid))?.entry;
    if (!entry) throw new Error("no entry");
    const local = localize(entry, { x: world.x, y: world.y, theta: 0 });
    Handle.pos.set(eid, local.x, local.y);
    reheadOnDrag(state, eid);
}

// the readout formatting seam (feel round 6): one degree formatter (`formatDeg`) + one length
// formatter (`formatLen`) every source funnels through, so a value formats identically regardless of
// which precedence source produced it. `formatDeg` reads a 5°-grid multiple as a clean integer, a
// continuous (Ctrl-bypass) value as one decimal, and normalizes a small negative that rounds to zero
// (never `-0.0°`).

test("a 5°-grid multiple reads as a clean integer despite the radian→degree round-trip", () => {
    // the angle control carries the incline in world radians (k·ANGLE_STEP, 5°); the readout feed
    // converts it rad→deg (`dragManipTo`), so a grid multiple must cancel to a clean integer.
    for (let k = -6; k <= 6; k++) {
        const incline = k * ANGLE_STEP;
        const label = formatDeg((-incline * 180) / Math.PI);
        expect(label).toBe(`${-k * 5}°`);
    }
});

test("a continuous (Ctrl-bypass) value keeps one decimal", () => {
    // a real atan2-over-samples value that must not spill its full f64 expansion into the readout.
    expect(formatDeg(-22.126334809373247)).toBe("-22.1°");
    expect(formatDeg(37.049999999999997)).toBe("37.0°");
});

test("-0 normalizes to a sign-free zero (the momentary `-0.0°` flicker)", () => {
    // a small negative that rounds to zero at one decimal must not show its sign — the readout
    // flickered `-0.0°` at ~0°. both the integer path (exact 0) and the decimal path (a tiny
    // negative) resolve to a positive zero.
    expect(formatDeg(0)).toBe("0°");
    expect(formatDeg(-0)).toBe("0°");
    expect(formatDeg(-0.04)).toBe("0.0°"); // rounds to 0.0 at one decimal — no leading minus
    expect(formatDeg(-1e-7)).toBe("0°"); // within the integer-noise band → clean integer zero
});

test("formatLen is the one length seam — integer metres, no sign on zero", () => {
    expect(formatLen(4.2)).toBe("4 m");
    expect(formatLen(4.6)).toBe("5 m");
    expect(formatLen(-0)).toBe("0 m"); // `${-0}` is "0" — never "-0 m"
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
    // node 3 m right + 3 m up → chord = hypot(3,3) ≈ 4.24 → "4 m". heading π/4 → +45°.
    const m = nodeMetrics({ x: 0, y: 0 }, { x: 3, y: 3 }, Math.PI / 4);
    expect(m.angleLabel).toBe("45°");
    expect(m.lengthLabel).toBe("4 m");
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

// the tangent-handle drag feed (`dragMetrics`): the dragged handle's OWN world angle + length from
// its screen-space tip offset. the y-flip lives inside it (screen sy < 0 → world Y-up), so an
// on-ray tip reports a constant angle regardless of how far out it's pulled — the constant-while-
// on-ray pin the flanking-sample re-derivation failed (that drifted as the reshaped curve moved the
// samples). here scale sx = 40 px/m, sy = −40 px/m (the view Y-flip).

test("dragMetrics reports a constant angle along a ray — only length grows", () => {
    // a screen tip along (+1, −1) (world +45°, the Y-flip): two lengths on the same ray.
    const near = dragMetrics(40, -40, 40, -40); // world (1, 1) → hypot ≈ 1.41 → "1 m"
    const far = dragMetrics(160, -160, 40, -40); // world (4, 4), same direction → hypot ≈ 5.66 → "6 m"
    expect(near.angleLabel).toBe("45°");
    expect(far.angleLabel).toBe("45°"); // angle held — the on-ray invariant
    expect(near.lengthLabel).toBe("1 m");
    expect(far.lengthLabel).toBe("6 m"); // only length moved
});

test("dragMetrics applies the world Y-flip (screen down = world up)", () => {
    // a screen tip straight DOWN (+y in screen) is world −y with sy < 0 → world DOWN → −90°.
    expect(dragMetrics(0, 40, 40, -40).angleLabel).toBe("-90°");
    // straight UP in screen (−y) → world UP → +90°.
    expect(dragMetrics(0, -40, 40, -40).angleLabel).toBe("90°");
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
    const f = nodeFrame(state, s, TX, tip);
    if (!f) throw new Error("no frame");
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
    const f = nodeFrame(state, s, TX, tip);
    if (!f) throw new Error("no frame");
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

// feel round 9 — the INTERIOR angle readout: the angle control snaps the CHORD (an interior node has
// no exit incline), but the readout reports the node's AUTHORED exit heading (`exitWorld`) — drag AND
// rest, the same quantity, no jump. an interior drag doesn't re-head the node, so that heading is
// frozen through the rotation (the accepted tradeoff: the knob snaps the chord, the readout reports
// the heading).
test("angle drag on an INTERIOR node reports the frozen exit heading, not the chord it snaps", () => {
    const { state, sec } = geoTrack();
    addNode(state, sec, 0, 0);
    addNode(state, sec, 10, 6); // node 1 — the interior we drag (frozen heading ≠ its chord)
    addNode(state, sec, 22, 8); // node 2
    addNode(state, sec, 30, 6); // node 3 (tip) — makes node 1 a clean interior (not last / last-1)
    state.step(0);
    const interior = handleAt(state, sec, 1);
    if (interior === null) throw new Error("no interior node");
    const s = samples.get(trackOf(state));
    if (!s) throw new Error("no samples");
    const f = nodeFrame(state, s, TX, interior);
    if (!f) throw new Error("no frame");
    expect(f.tangent).toBeNull(); // interior: no incline reference

    const headingBefore = exitWorld(interior);
    const raw = angleToPoint(f, 0.7);
    const res = angleControl(f, raw.x, raw.y, true);
    expect(res.incline).toBeNull();
    // the chord the knob snaps is a genuinely different quantity from the node's exit heading.
    expect(Math.abs(res.angle - headingBefore)).toBeGreaterThan(0.05);
    writeNode(state, interior, angleToPoint(f, res.angle));
    // the interior drag doesn't re-head this node — its exit heading is frozen (drag == rest).
    expect(exitWorld(interior)).toBeCloseTo(headingBefore, 9);
    // and the resting readout reports exitWorld (the heading) — the SAME quantity the drag feed shows.
    expect(selectedMetrics(state, interior)?.angleLabel).toBe(
        formatDeg((exitWorld(interior) * 180) / Math.PI),
    );
});
