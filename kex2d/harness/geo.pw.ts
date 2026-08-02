// kex2d's GEO-authoring + viewport capture flows. Shared helpers, the `__kex` typed hook, and the
// boot fixture live in `./flow` (the staged helpers module, `kex2d-harness.md` "Growth") — this
// file, `force.pw.ts`, `section.pw.ts`, and `lab.pw.ts` are the staged flow files that import it.
// The boot-fixture pageerror-gate pin below must stay the FIRST test in THIS file (`kex2d-harness.md`
// "The pageerror gate") — it needs no ordering relative to the other staged flow files, only within
// its own.

import {
    test,
    expect,
    join,
    OUT,
    SHOT_MS,
    kexCall,
    type Kex,
    nodePoint,
    seedHill,
    knobCenter,
    frameTimeline,
    clickFlyout,
    clickMenuItem,
    menuGrammar,
    marqueeDrag,
    dockStrip,
    DOCK_RESERVE,
    FORCE_LEN,
    frames,
} from "./flow";

// The boot fixture's own pin — the one flow here whose subject is the HARNESS, not the app.
//
// The `pageerror` gate above works only because the listener is attached in fixture SETUP, before
// any navigation. Move it after `goto` and a crash during page load lands in nobody's array: every
// flow screenshots straight past a broken boot and the whole suite stays green. That ordering was
// proven red once by hand and nothing pinned it after; this is the standing pin.
//
// `test.fail` inverts the verdict: the flow is EXPECTED to fail, so the run counts it green only
// when the fixture's teardown assert fires on a boot-time throw. The throw is injected with
// `addInitScript`, which the page evaluates before any script of its own on every navigation, so it
// lands during `goto` — squarely inside the window the mutation opens. Both halves of the gate are
// pinned, and by the SAME red: drop the listener (or attach it late) and nothing is collected, drop
// the teardown assert and nothing is failed, and either way the flow PASSES and Playwright reports
// "Expected to fail, but passed". So does an injection that stopped reaching the page — the pin is
// mutation-proven in both directions, listener-after-`goto` and injection-removed.
//
// The body is two statements because an inverted verdict cannot say WHY it failed: an assert of its
// own would satisfy `test.fail` just as well as the gate. It boots a LAB page for the same reason —
// that path skips the fixture's `.dock` wait (see `boot` above), so the app's own health is not
// part of this pin's failure surface. What remains is `goto` itself, which fails only when the dev
// server is gone; that takes every other flow red with it, so the run can't come back green on it.
//
// It costs the suite one boot and no screenshot. Playwright counts an expected failure under
// `expected` — the summary's "N passed" — so `capture.ts`'s suite-count oracle reads this flow
// exactly like any other, and a skip of it still fails the run. Its per-test line prints with the
// failure mark (`x`) on a GREEN run, which is why the title says so.
test.fail("boot pageerror gate pin (expected to fail)", async ({ page, boot }) => {
    await page.addInitScript(() => {
        throw new Error("boot-fixture pin: injected boot-time throw");
    });
    await boot("/geometry-lab.html"); // an uncaught init-script throw doesn't stop the page load
});

test("geo authoring flow", async ({ page, boot }) => {
    await boot();
    await expect(page.locator(".player")).toBeVisible();

    // read helpers over the DEV hook. expect.poll drives every wait — no fixed sleeps.
    const nodeCount = () => kexCall(page, "nodeCount");
    const undoDepth = () => kexCall(page, "undoDepth");
    const tTotal = () => kexCall(page, "tTotal");
    const poses = () => kexCall(page, "poses");

    // seed the airtime hill and wait for its first bake (the recovered force curve).
    await seedHill(page);
    await expect.poll(nodeCount).toBe(7);
    await page.waitForTimeout(SHOT_MS);

    // read-only baseline: the shaped track + its recovered F_n force curve.
    await page.screenshot({ path: join(OUT, "full.png") });
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "timeline.png"), clip: strip });

    // ── 1. Extend: select the chain end, press Enter → one node, one undo entry. ──
    await kexCall(page, "selectEnd");
    await page.keyboard.press("Enter");
    await expect.poll(nodeCount).toBe(8);
    expect(await undoDepth()).toBe(1);
    await page.waitForTimeout(SHOT_MS); // the clip strip re-projects per RAF — settle before the shot
    await page.screenshot({ path: join(OUT, "geo-1-extend.png") });

    // ── 2. Undo: Ctrl+Z drops the extended node, clearing the entry. ──
    await page.keyboard.press("Control+z");
    await expect.poll(nodeCount).toBe(7);
    await expect.poll(undoDepth).toBe(0);

    // ── 3. Reshape via the POLAR LENGTH MANIPULATOR button (the free-drag replacement). Frame the
    // hill so the nodes + knob buttons separate at pixel scale, then: (a) the node BODY is
    // select-only — a drag across it selects but never moves the node; (b) the LENGTH knob is a real
    // `.rbtn` button (feel round 6) — pressing it and dragging along the chord lengthens it, re-baking
    // the recovered force. Located by its real DOM box (pointer-true), not by canvas coords. ──
    // `f` frames the hovered surface; hover defaults to the viewport, so it routes there. Nothing
    // is awaited after it anywhere in this file: `frameViewport` writes the camera singleton
    // synchronously, and every screen point below (`__kex.nodeAt`/`startAt`) reads that same
    // singleton — not a projected DOM value.
    await page.keyboard.press("f");

    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    const selectedOrder = () => kexCall(page, "selectedOrder");

    // select node 3 (the crest) by a real body click; the polar knob buttons summon on it.
    const n3 = await nodePoint(page, 3);
    await page.mouse.click(cb.x + n3.x, cb.y + n3.y);
    await expect.poll(selectedOrder).toBe(3);
    await expect(page.locator(".manip-length")).toBeVisible(); // the DOM knob buttons appeared

    // (a) SELECT-ONLY body drag: dragging across the node body moves nothing (movement is only
    // through the manipulator buttons). the section-local pose holds byte-identical.
    const before = await poses();
    await page.mouse.move(cb.x + n3.x, cb.y + n3.y);
    await page.mouse.down();
    await page.mouse.move(cb.x + n3.x + 40, cb.y + n3.y + 40, { steps: 8 });
    await page.mouse.up();
    expect((await poses())[3]).toEqual(before[3]); // the body drag didn't move the node

    // (b) press the real LENGTH knob button and drag outward along the chord (away from node 2) → the
    // chord lengthens, the crest moves, and the recovered force + ride time shift. pointer-true: a
    // real pointerdown on the button's own box, then a real drag; the button captures on the canvas.
    const tBefore = await tTotal();
    const n2 = await nodePoint(page, 2);
    const lk = await knobCenter(page, cb, 3, "length"); // the button center (page coords)
    const rl = Math.hypot(n3.x - n2.x, n3.y - n2.y);
    const ux = (n3.x - n2.x) / rl;
    const uy = (n3.y - n2.y) / rl; // the chord ray screen direction; dragging along it lengthens it
    await page.mouse.move(lk.x, lk.y);
    await page.mouse.down();
    await page.mouse.move(lk.x + ux * 50, lk.y + uy * 50, { steps: 12 });
    await page.mouse.up();
    // the crest moved a real distance (the chord grew)…
    await expect
        .poll(async () => {
            const p = (await poses())[3];
            return Math.hypot(p[0] - before[3][0], p[1] - before[3][1]);
        })
        .toBeGreaterThan(0.1);
    // …and the reshaped geometry re-baked — the recovered force, so the ride time, shifted.
    await expect.poll(async () => Math.abs((await tTotal()) - tBefore) > 1e-4).toBe(true);
    await page.screenshot({ path: join(OUT, "geo-2-reshape.png") });

    // ── 3c. Angle-knob drag==rest pin (feel round 8): rotating the TIP's angle knob shows the snapped
    // exit incline; on release the resting readout must show the SAME number — the round-3 law at the
    // write end (the fix for a 25° drag that rested at 25.5°: the snap now quantizes the same authored
    // exit heading the write re-heads to). read the readout's degree token during the drag, then after
    // release, and assert they match. ──
    const readoutAngle = async (): Promise<string | null> => {
        const txt = await page.locator(".snap-readout").first().textContent();
        const m = txt?.match(/-?\d+(?:\.\d+)?°/); // the degree token, e.g. "-30°" or "25.5°"
        return m ? m[0] : null;
    };
    const tipPos = await nodePoint(page, 6); // the chain end (7 nodes → order 6)
    await page.mouse.click(cb.x + tipPos.x, cb.y + tipPos.y); // select the tip → its knobs summon
    await expect.poll(selectedOrder).toBe(6);
    // the selection just moved off node 3, so the knob box has to be waited onto THIS node's ring
    // (`knobCenter`) — the stale box is empty canvas, and pressing it deselects on release.
    const ak = await knobCenter(page, cb, 6, "angle");
    await page.mouse.move(ak.x, ak.y);
    await page.mouse.down();
    await page.mouse.move(ak.x + 28, ak.y - 28, { steps: 10 }); // rotate the tip to a snapped incline
    await frames(page); // the readout is projected by the per-RAF tick, so read one frame on
    const dragAngle = await readoutAngle();
    await page.mouse.up();
    await frames(page);
    const restAngle = await readoutAngle();
    expect(dragAngle).not.toBeNull();
    expect(restAngle).toBe(dragAngle); // drag == rest, exactly — no 25→25.5 drift on release

    // ── 4. Append (feel round 12 — extend restored to the ring): a PLAIN click never appends; the
    // ring's extend button (a real `.rbtn` at the chain end) appends, Enter's twin; and the node menu
    // carries Delete + Add, in that order. double-click now enters tangent edit (the tangent flow),
    // not append. the chain end is order 6 (7 nodes). ──
    const chainEnd = await nodePoint(page, 6);
    // a plain click selects the chain end but does NOT append.
    await page.mouse.click(cb.x + chainEnd.x, cb.y + chainEnd.y);
    await expect.poll(selectedOrder).toBe(6);
    expect(await nodeCount()).toBe(7); // no append on a plain click
    // the chain end shows the three-button ring: measure (−60°) · extend (front) · pitch (+60°).
    await expect(page.locator(".rbtn.extend")).toBeVisible();
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "geo-3-ring.png") });
    // the ring's extend button appends one node; undo drops it.
    await page.locator(".rbtn.extend").click();
    await expect.poll(nodeCount).toBe(8);
    await page.keyboard.press("Control+z");
    await expect.poll(nodeCount).toBe(7);
    // the undo RESPAWNS this section's nodes, so re-locate the chain end instead of reusing the
    // pre-append point: `nodeCount` is satisfied by the synchronous restore, a frame before the
    // re-bake rebuilds the node→sample map the pointer picks through (`nodePoint`). It has to land
    // back where it was — the undo restores the geometry byte-identical — so assert that too.
    const chainEndBack = await nodePoint(page, 6);
    expect(Math.hypot(chainEndBack.x - chainEnd.x, chainEndBack.y - chainEnd.y)).toBeLessThan(1);
    // the node menu (right-click the chain end) carries the structural ops (delete stays off-ring),
    // in the GRAMMAR's canonical order (kex2d-menu-grammar stage 2): create · modify · lifecycle,
    // with the destructive row terminal — so Add leads and Delete closes, reversing the old
    // free-form frequency order. The dividers between the three groups are DERIVED from the group
    // changes, not authored. the rows are terse — the menu is ON the node, so the noun would only
    // restate its subject.
    await page.mouse.click(cb.x + chainEndBack.x, cb.y + chainEndBack.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await expect
        .poll(async () =>
            (await page.locator(".nodemenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Add Enter", "Handles", "Tangents ▸", "Reset", "Delete Del"]); // ▸ = the submenu affix; Reset top-level (the Reset idiom law)
    // …and the RENDERED rows are the real `nodeMenu` builder's rows for THIS node's live state,
    // taxonomy and derived dividers included, checked at the root and inside `Tangents ▸`. The
    // expectation is computed from `src/menus.ts` in the page, so a builder reorder can't be
    // "fixed" by editing a literal here (kex2d-menu-grammar decision 8).
    await menuGrammar(page, ".nodemenu", {
        builder: "nodeMenu",
        // the chain-end node of the only section: a single selection, not the entry anchor, not in
        // tangent edit, appendable and trimmable, no pin session open.
        state: {
            multi: false,
            isEntry: false,
            ok: true,
            editing: false,
            isEnd: true,
            canTrim: true,
            suffixOk: false,
        },
        enums: { mode: "spline.TangentMode.Aligned" },
    });
    await page.keyboard.press("Escape"); // dismiss the menu
    await expect(page.locator(".nodemenu")).toHaveCount(0);
    // …and the node it was summoned on survives that press (one rung), so the NEXT Escape is the
    // one that deselects. A dismissal listener that outlives its own menu swallows this second
    // press and the node stays selected — the stale-swallow the permanent-listener shape kills.
    expect(await selectedOrder()).not.toBeNull();
    await page.keyboard.press("Escape");
    await expect.poll(selectedOrder).toBeNull();

    // ── 5. Interior OFFSET drag (kex2d-node-move-ux stage 2 — RETIRES feel round 9's chord-angle-snap
    // pin above: an INTERIOR node no longer drags a polar frame at all). Its ring's "angle" slot now
    // drives the neighbor-chord OFFSET (⊥ prev→next), with the "length" slot's SLIDE (∥) — both on a
    // plain 1 m grid, no angle grid reachable from here. Three invariants a swapped/reverted wiring
    // would fail: (a) BOTH neighbors (node 2, node 4) hold byte-identical through the gesture — the
    // "neighbors fully frozen" law, unprovable before this stage since the old interior drag orbited
    // node 2 itself; (b) the mid-drag readout switches to the plain ∥/⊥ metres wording (no degree
    // token any more); (c) the RESTING readout reverts to heading + chord — drag ≠ rest text now,
    // the opposite of the retired invariant, since the two surfaces report genuinely different
    // quantities (a transient control value vs the node's permanent authored state). ──
    const interiorPos = await nodePoint(page, 3); // an interior node of the seeded hill
    const crestBefore = (await poses())[3];
    const prevBefore = (await poses())[2];
    const nextBefore = (await poses())[4];
    await page.mouse.click(cb.x + interiorPos.x, cb.y + interiorPos.y);
    await expect.poll(selectedOrder).toBe(3);
    const iak = await knobCenter(page, cb, 3, "angle"); // waited onto node 3's own ring
    await page.mouse.move(iak.x, iak.y);
    await page.mouse.down();
    await page.mouse.move(iak.x + 26, iak.y + 26, { steps: 10 }); // drag the interior offset
    await frames(page);
    const dragText = await page.locator(".snap-readout").first().textContent();
    expect(dragText).toContain("⊥"); // the interior offset control, mid-drag
    expect(dragText).toContain("∥"); // …shown alongside the (unchanged) slide value
    expect(dragText).not.toMatch(/-?\d+(?:\.\d+)?°/); // no degree token — no angle grid here any more
    await page.mouse.up();
    await frames(page);
    const restText = await page.locator(".snap-readout").first().textContent();
    expect(restText).not.toContain("⊥"); // rest reverts to heading + chord (the unchanged law)
    // both neighbors held exactly still through the whole gesture.
    const after = await poses();
    expect(after[2]).toEqual(prevBefore);
    expect(after[4]).toEqual(nextBefore);
    // and the dragged node itself actually moved (a real offset write landed) — compared against
    // its OWN pre-drag pose, section-local (never against `interiorPos`, a screen-canvas point).
    const moved = after[3];
    expect(Math.hypot(moved[0] - crestBefore[0], moved[1] - crestBefore[1])).toBeGreaterThan(0.05);

    // ── 6. POLAR ARROW-NUDGE (the TIP) — the manipulators' KEYBOARD twin (kex2d-geo-ux): left/right
    // step the chord ANGLE around the previous node, up/down step the chord LENGTH along it, each
    // press its own undo entry. Driven on the chain end (node 6, prev node 5) — kex2d-node-move-ux
    // stage 2 forks the single-node nudge by node kind, and this pin covers the TIP half (`polarNudge`,
    // UNCHANGED); the interior half (`chordNudge`, slide/offset) is 6d below. `polarNudge`'s math is
    // unit-covered; what is not is the KEY WIRING — which key reaches which axis, in which direction,
    // and that a press brackets exactly one history entry. Section 0's entry frame is the identity, so
    // a stored pose IS its world point and the chord from node 5 to node 6 is the polar pair (r, a) the
    // two axes address. Each axis is pinned by BOTH halves: the quantity it moves, and the one it must
    // leave exactly alone — a swapped mapping passes "something moved" and fails these. The step is
    // `NUDGE_PX`(2)/zoom ≈ 0.05 m here, two decades above the f32 hold tolerances below. Mutations: stub
    // the arrow branch → nothing moves → red; swap the axis map (ArrowUp → "angle") → both holds go
    // red. ──
    const tipPoint = await nodePoint(page, 6);
    await page.mouse.click(cb.x + tipPoint.x, cb.y + tipPoint.y); // select the tip for the nudge below
    await expect.poll(selectedOrder).toBe(6);
    const chord = async (): Promise<{ r: number; a: number }> => {
        const p = await poses();
        const dx = p[6][0] - p[5][0];
        const dy = p[6][1] - p[5][1];
        return { r: Math.hypot(dx, dy), a: Math.atan2(dy, dx) };
    };
    const nodeScreen = () => kexCall(page, "nodeAt", 6);
    // wait the bake onto its OWN last write — the honest evidence a press's write reached the
    // samples (`kex2d-harness.md`'s bake-readiness law, read side). Deliberately not inside `nudge`
    // any more, and not fired between every press: the nudge now resolves its polar geometry from
    // the AUTHORED `Handle.pos`, not the bake, so back-to-back presses no longer need a settle
    // between them to land correctly — a caller waits only where it's about to READ (6b proves the
    // no-wait case directly).
    const settle = async (before: { x: number; y: number } | null): Promise<void> => {
        await expect
            .poll(async () => {
                const p = await nodeScreen();
                return (
                    p !== null &&
                    before !== null &&
                    Math.hypot(p.x - before.x, p.y - before.y) > 0.5
                );
            })
            .toBe(true);
    };
    const c0 = await chord();
    const undo0 = await undoDepth();
    let at = await nodeScreen();
    await page.keyboard.press("ArrowRight");
    await settle(at);
    const cR = await chord();
    const stepA = cR.a - c0.a; // the single-step angle delta, reused by 6b below
    expect(stepA).toBeGreaterThan(5e-3); // right = a positive angle step…
    expect(Math.abs(cR.r - c0.r)).toBeLessThan(1e-3); // …and the chord length is untouched
    expect(await undoDepth()).toBe(undo0 + 1); // one press = one entry
    at = await nodeScreen();
    await page.keyboard.press("ArrowLeft");
    await settle(at);
    const cL = await chord();
    expect(cL.a).toBeCloseTo(c0.a, 3); // left is the same axis, the other way — back where it started
    expect(await undoDepth()).toBe(undo0 + 2);
    at = await nodeScreen();
    await page.keyboard.press("ArrowUp");
    await settle(at);
    const cU = await chord();
    expect(cU.r - c0.r).toBeGreaterThan(5e-3); // up = a positive length step…
    expect(Math.abs(cU.a - c0.a)).toBeLessThan(1e-3); // …and the chord angle is untouched
    expect(await undoDepth()).toBe(undo0 + 3);
    at = await nodeScreen();
    await page.keyboard.press("ArrowDown");
    await settle(at);
    const cD = await chord();
    expect(cD.r).toBeCloseTo(c0.r, 3); // down is the same axis, the other way
    expect(await undoDepth()).toBe(undo0 + 4);

    // ── 6b. BACK-TO-BACK NUDGES — the bake-readiness law's WRITE side (`kex2d-harness.md`): the
    // nudge resolves its polar geometry from the AUTHORED `Handle.pos`, not the bake's node→sample
    // map, so a fast double-tap — no settle between the two key events, exactly how a quickly
    // repeated arrow key fires — must accumulate BOTH steps. Before the fix (reading `nodeWorld`,
    // the bake), the second press read the frame the first press's write hadn't reached yet and
    // overwrote it, landing one step short of two (measured: a right-then-left pair landed a full
    // step short of where it started, not back at it). Two ArrowRight presses fired back-to-back
    // with zero wait between them, then ONE settle before reading: the accumulated angle must be
    // ~2× the single-step delta measured above, not ~1×. ──
    const before6b = await nodeScreen();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight"); // no settle between — the honest fast-repeat case
    await settle(before6b);
    const cRR = await chord();
    expect(cRR.a - cD.a).toBeCloseTo(2 * stepA, 2); // both steps landed, not one
    expect(Math.abs(cRR.r - cD.r)).toBeLessThan(1e-3); // …and the chord length stayed untouched
    expect(await undoDepth()).toBe(undo0 + 6); // two presses = two entries regardless

    // restore for the flows below — two ArrowLeft, same back-to-back shape.
    const before6c = await nodeScreen();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await settle(before6c);
    const cRestored = await chord();
    expect(cRestored.a).toBeCloseTo(cD.a, 3);
    expect(await undoDepth()).toBe(undo0 + 8);

    // ── 6d. CHORD ARROW-NUDGE (the INTERIOR half, kex2d-node-move-ux stage 2) — the SAME up/down =
    // length-role, left/right = angle-role key mapping, but on an interior node (3, neighbors 2 and 4)
    // it steps SLIDE (∥ the frozen 2→4 chord) and OFFSET (⊥) instead of orbiting node 2 — `chordNudge`
    // is unit-covered; the wiring is not. `axes()` mirrors `src/manipulator.ts chordFrame`'s
    // slide/offset projection verbatim (this file is staged standalone and imports nothing from
    // `src/`, `kex2d-harness.md` "Standalone staging") over the SAME section-0-identity-frame poses
    // the tip block above reads — `v` is the FIXED +90° rotation of `u`, NEVER sign-picked toward
    // the node (the stage-2 adversarial-pass fix: a sign-pick rebuilt every pointermove flips the
    // reported offset the instant a drag crosses the chord). `poses()` is section-local WORLD
    // coordinates (y grows upward), the SAME space `chordNudge` itself builds from
    // (`chordFrame(..., screenSpace: false)`) — this mirror's un-flipped `vx = -uy` is therefore
    // already the canonical handedness `chordFrame` folds every OTHER (screen-space) build site
    // to match (the follow-up adversarial-pass fix, `nodeFrame`'s cross-space handedness bug).
    // Keep this in lockstep with `chordFrame` — a drift here would pin the WRONG axis convention
    // silently, and a future edit here must track BOTH the sign-pick law above and which build
    // space (`screenSpace`) this mirror represents. Both neighbors must hold exactly still through
    // every press — the one invariant a tip nudge can't pin (a tip's "previous node" IS its
    // nudge's own pivot). ──
    const axes = async (): Promise<{ slide: number; offset: number }> => {
        const p = await poses();
        const prev = p[2];
        const next = p[4];
        const node = p[3];
        const dx = next[0] - prev[0];
        const dy = next[1] - prev[1];
        const len = Math.hypot(dx, dy);
        const ux = dx / len;
        const uy = dy / len;
        const vx = -uy; // fixed +90° rotation, world/local handedness (screenSpace: false) — never sign-picked
        const vy = ux;
        const sx = node[0] - prev[0];
        const sy = node[1] - prev[1];
        return { slide: sx * ux + sy * uy, offset: sx * vx + sy * vy };
    };
    const interiorNodePoint = await nodePoint(page, 3);
    await page.mouse.click(cb.x + interiorNodePoint.x, cb.y + interiorNodePoint.y);
    await expect.poll(selectedOrder).toBe(3);
    const nodeScreen3 = () => kexCall(page, "nodeAt", 3);
    const settle3 = async (before: { x: number; y: number } | null): Promise<void> => {
        await expect
            .poll(async () => {
                const p = await nodeScreen3();
                return (
                    p !== null &&
                    before !== null &&
                    Math.hypot(p.x - before.x, p.y - before.y) > 0.5
                );
            })
            .toBe(true);
    };
    const prevPin = (await poses())[2];
    const nextPin = (await poses())[4];
    const a0 = await axes();
    const undoI0 = await undoDepth();
    let atI = await nodeScreen3();
    await page.keyboard.press("ArrowUp"); // length-role key → SLIDE on an interior node
    await settle3(atI);
    const aUp = await axes();
    expect(aUp.slide - a0.slide).toBeGreaterThan(5e-3); // up = a positive slide step…
    expect(Math.abs(aUp.offset - a0.offset)).toBeLessThan(1e-3); // …offset untouched
    expect(await undoDepth()).toBe(undoI0 + 1);
    atI = await nodeScreen3();
    await page.keyboard.press("ArrowDown");
    await settle3(atI);
    const aDown = await axes();
    expect(aDown.slide).toBeCloseTo(a0.slide, 3); // back where it started
    expect(await undoDepth()).toBe(undoI0 + 2);
    atI = await nodeScreen3();
    await page.keyboard.press("ArrowRight"); // angle-role key → OFFSET on an interior node
    await settle3(atI);
    const aRight = await axes();
    expect(aRight.offset - aDown.offset).toBeGreaterThan(5e-3); // right = a positive offset step…
    expect(Math.abs(aRight.slide - aDown.slide)).toBeLessThan(1e-3); // …slide untouched
    expect(await undoDepth()).toBe(undoI0 + 3);
    atI = await nodeScreen3();
    await page.keyboard.press("ArrowLeft");
    await settle3(atI);
    const aLeft = await axes();
    expect(aLeft.offset).toBeCloseTo(aDown.offset, 3);
    expect(await undoDepth()).toBe(undoI0 + 4);
    // neither neighbor moved a single step through any of the four presses — frozen by construction.
    const neighborsAfter = await poses();
    expect(neighborsAfter[2]).toEqual(prevPin);
    expect(neighborsAfter[4]).toEqual(nextPin);

    // ── 7. BLUR CANCELS A LIVE MANIPULATOR DRAG, completely (`editor-ui.md`: "Window blur cancels an
    // in-flight gesture completely — revert the bracketed edit, clear guides and capture. No guide may
    // exist without a live, threshold-crossed drag"). A blur delivers no pointerup, so without the
    // teardown the gesture SURVIVES the focus loss: the ray stays painted over a track nothing is
    // dragging, and the next move resumes against the stale grab. This drives `cancelDrag`'s MANIP
    // branch alone — the tangent / marquee / pan branches, and the timeline's missing blur cancel
    // entirely, are not pinned here. Driven on the TIP (order 6) because the guide ray exists only
    // where an exit incline does — an interior node's own control (`offsetControl`/`slideControl`
    // over `chordFrame`) has no incline to display at all, so the same drag on node 3 would make the
    // ray assert vacuous; it also rides the magnet's default-on
    // state (a flow that pressed `S` first would take the ray poll red for an unrelated reason). The
    // blur is DISPATCHED: no Playwright gesture deterministically defocuses a headless page's window,
    // and the app's listener is a plain `window` blur listener, so the dispatched event is the same
    // handler on the same path (this is the one event here that isn't pointer-true, and it can't be).
    // The mid-drag reads are the positive controls — a cancel that "passes" because nothing was ever
    // live proves nothing. Mutations: empty `onBlur` → the pose stays moved, the ray stays up,
    // `data-dragging` stays 1 → red; `cancel()` → `commit(history)` in `cancelDrag`'s manip branch →
    // the pose holds AND an entry lands → red. ──
    const guides = () => kexCall(page, "guides");
    const tip = await nodePoint(page, 6);
    await page.mouse.click(cb.x + tip.x, cb.y + tip.y); // the chain end — a tip has an exit incline
    await expect.poll(selectedOrder).toBe(6);
    const bk = await knobCenter(page, cb, 6, "angle");
    const pre = (await poses())[6];
    const undoPre = await undoDepth();
    await page.mouse.move(bk.x, bk.y);
    await page.mouse.down();
    await page.mouse.move(bk.x + 30, bk.y + 30, { steps: 8 }); // well past DRAG_PX
    // `data-dragging` is the CAPTURE flag (`beginDrag`, raised at pointerdown), so it says a gesture
    // is open, not that it armed; the ray below is what says armed — `snapGuides.ray` is written past
    // `dragManipTo`'s `if (!manipArmed) return`. The pair's load-bearing half is the `toHaveCount(0)`
    // after the blur, which pins `endDragGesture()`.
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1);
    await expect.poll(async () => (await guides()).ray).toBe(true); // the guide ray IS up (armed)
    const mid = (await poses())[6];
    expect(Math.hypot(mid[0] - pre[0], mid[1] - pre[1])).toBeGreaterThan(0.01); // …and it moved
    expect(await undoDepth()).toBe(undoPre); // a live gesture has committed nothing yet

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    const reverted = (await poses())[6];
    for (const i of [0, 1, 2]) expect(reverted[i]).toBeCloseTo(pre[i], 5); // pose AND heading revert
    expect(await guides()).toEqual({ ray: false, angle: null, length: null }); // nothing left drawn
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0); // the capture flag cleared
    expect(await undoDepth()).toBe(undoPre); // a cancelled gesture never happened
    // and the drag does not RESUME on the next move — the stale-grab failure the teardown exists for
    // (the button is still physically down; only the gesture is gone). The point is the SAME physical
    // pointer path continued past the grab, not a box being aimed at, so the cached-`bk` law doesn't
    // apply: nothing here has to be hit, and re-locating would defeat what the move is testing.
    await page.mouse.move(bk.x + 60, bk.y + 60, { steps: 6 });
    const stale = (await poses())[6];
    for (const i of [0, 1]) expect(stale[i]).toBeCloseTo(pre[i], 5);
    await page.mouse.up(); // release cleanly — a torn-down gesture commits nothing on pointerup
    expect(await undoDepth()).toBe(undoPre);
});

// Drive the TANGENT-EDIT flow (kex2d-authoring-surface stage 9): seed a shaped geo track →
// frame it → DOUBLE-CLICK an interior node to enter tangent edit (feel round 12 restored the
// double-click summon; the node is inferred, no stored tangent) → RIGHT-CLICK
// the node to open the NODE context menu (Handles + a Tangents ▸ submenu + Reset) → open the
// submenu → set FREE → drag its out-handle → assert Free independence and a re-bake → the
// top-level Reset row clears the node back to live (Auto). The summon is a real canvas
// double-click, the node menu a real canvas right-click (both located via __kex.nodeAt); the
// handle drag is a real canvas pointer drag located through
// __kex.tangentHandles (canvas-drawn handles carry no DOM box). Handle drags no longer snap, so
// the drag lands where the pointer goes. The submenu item (Free) is clicked pointer-true
// via clickFlyout — a coordinate click gated on elementFromPoint reachability, the regression net
// for the context-submenu clip class (a selector .click() would fire on a clipped, unreachable
// row) — and Reset through clickMenuItem, the same net's top-level twin.
test("tangent edit flow", async ({ page, boot }) => {
    await boot();

    const nodeCount = () => kexCall(page, "nodeCount");
    const tTotal = () => kexCall(page, "tTotal");
    const undoDepth = () => kexCall(page, "undoDepth");
    const editing = () => kexCall(page, "editing");
    const tangent = () => kexCall(page, "tangent");
    const handles = () => kexCall(page, "tangentHandles");

    // seed the shaped hill, then frame it so the interior node's handles separate at pixel
    // scale (the default ±280 m framing leaves the ~23 m hill a squiggle — `F` fits it; hover
    // defaults to the viewport, so no pre-move is needed to route the key there).
    await seedHill(page);
    await expect.poll(nodeCount).toBe(7);
    await page.keyboard.press("f");

    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");

    // ── 1. DOUBLE-CLICK the crest (interior node, order 3) → tangent edit (feel round 12 restored the
    // double-click summon from Alt-click — it's more discoverable). its arc-rule ghost handles draw;
    // the inferred node carries no stored tangent (Auto). ──
    const npos = await nodePoint(page, 3);
    // a PLAIN click first, so the knobs-hidden assert below has a positive control: on a plain
    // selection the node-action ring's two polar knobs are up (they are what tangent edit replaces).
    await page.mouse.click(cb.x + npos.x, cb.y + npos.y);
    await expect(page.locator(".manip-length")).toBeVisible();
    await expect(page.locator(".manip-angle")).toBeVisible();
    await page.mouse.dblclick(cb.x + npos.x, cb.y + npos.y);
    await expect.poll(editing).toBe(true);
    expect(await tangent()).toBeNull(); // inferred — the default add flow stamps nothing
    // the KNOBS HIDE while tangent edit owns the node (`editor-ui.md` layered expressiveness: the
    // inner layer's handles own the surface; App.svelte's `manip` derived returns null on
    // `editor.tangentEdit === eid`). Both halves matter — visible on plain selection, gone here — so
    // inverting that guard fails one or the other. Mutation: `editor.tangentEdit !== eid` → red.
    await expect(page.locator(".manip-length")).toHaveCount(0);
    await expect(page.locator(".manip-angle")).toHaveCount(0);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "tangent-1-summon.png") });

    // ── 2. RIGHT-CLICK the node → the NODE context menu (Handles + Tangents ▸) → open the
    // Tangents submenu → set FREE (a corner becomes expressible). ──
    await page.mouse.click(cb.x + npos.x, cb.y + npos.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await page
        .locator(".nodemenu")
        .getByRole("menuitem", { name: "Tangents", exact: true })
        .hover();
    await expect(page.locator(".nodemenu").getByRole("menuitem", { name: "Free" })).toBeVisible();
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "tangent-1b-menu.png") });
    await clickFlyout(page, ".nodemenu", "Tangents", "Free");
    await expect(page.locator(".nodemenu")).toHaveCount(0); // picking an item closes the menu
    const summoned = await tangent();
    expect(summoned).not.toBeNull();
    if (!summoned) throw new Error("tangent null after mode set");
    expect(summoned.mode).toBe(2); // TangentMode.Free (seeded from the arc rule, then relabeled)

    // ── 3. Drag the OUT-handle (a real canvas pointer drag, located via __kex + the canvas
    // box) → the authored out-vector moves, the in-vector holds (Free independence). handle
    // drags no longer snap, so the pointer lands where it goes. ──
    const out = (await handles()).find((h) => h.side === "out");
    if (!out) throw new Error("out-handle not exposed on the edited interior node");

    const tBefore = await tTotal();
    await page.mouse.move(cb.x + out.x, cb.y + out.y);
    await page.mouse.down();
    await page.mouse.move(cb.x + out.x + 40, cb.y + out.y - 40, { steps: 12 });
    await page.mouse.up();

    const dragged = await tangent();
    expect(dragged).not.toBeNull();
    if (!dragged) throw new Error("tangent null after drag");
    expect(dragged.mode).toBe(2); // still Free
    // the dragged out-vector moved by a real distance…
    expect(Math.hypot(dragged.outX - summoned.outX, dragged.outY - summoned.outY)).toBeGreaterThan(
        0.1,
    );
    // …while the in-vector held its seeded value (Free's per-side independence).
    expect(dragged.inX).toBeCloseTo(summoned.inX, 5);
    expect(dragged.inY).toBeCloseTo(summoned.inY, 5);
    // the reshaped curve re-baked — the recovered force, and so the ride time, shifted.
    await expect.poll(async () => Math.abs((await tTotal()) - tBefore) > 1e-4).toBe(true);
    expect(await undoDepth()).toBeGreaterThan(0); // the mode set + handle drag are undoable
    await page.screenshot({ path: join(OUT, "tangent-2-drag.png") });

    // ── 3b. Handle-drag readout pin (feel round 14, superseding round 3): grab the out-handle and
    // drag OUT along the grab ray to two lengths. The DOM snap readout reports the NODE's own
    // quantities — its authored exit heading (`exitWorld`, = the out-vector direction here) and its
    // chord to prev — never the handle's angle/length. An on-ray drag rotates neither the out-vector
    // nor the node, so BOTH the angle AND the length text hold CONSTANT while the handle grows. The
    // constant LENGTH is the round-14 change: the old feed reported the handle's own length, which
    // grew from near to far. ──
    const out2 = (await handles()).find((h) => h.side === "out");
    if (!out2) throw new Error("out-handle not re-located for the on-ray readout pin");
    const rayX = out2.x - npos.x;
    const rayY = out2.y - npos.y;
    const rl = Math.hypot(rayX, rayY);
    const ux = rayX / rl;
    const uy = rayY / rl; // the unit node→knob screen ray; dragging along it stays on the ray
    const readoutText = async (): Promise<string | null> =>
        page.locator(".snap-readout").first().textContent();
    const degToken = (t: string | null) => t?.match(/-?\d+(?:\.\d+)?°/)?.[0] ?? null;
    const lenToken = (t: string | null) => t?.match(/-?\d+(?:\.\d+)? m/)?.[0] ?? null;
    await page.mouse.move(cb.x + out2.x, cb.y + out2.y);
    await page.mouse.down();
    await page.mouse.move(cb.x + out2.x + ux * 15, cb.y + out2.y + uy * 15, { steps: 6 });
    await frames(page); // the readout is projected by the per-RAF tick, so read one frame on
    const near = await readoutText();
    await page.mouse.move(cb.x + out2.x + ux * 55, cb.y + out2.y + uy * 55, { steps: 6 });
    await frames(page);
    const far = await readoutText();
    await page.mouse.up();
    expect(degToken(near)).not.toBeNull(); // the readout is present through the handle drag
    expect(lenToken(near)).not.toBeNull();
    expect(degToken(far)).toBe(degToken(near)); // constant heading along the ray
    expect(lenToken(far)).toBe(lenToken(near)); // constant length = the node's chord, NOT the handle's

    // ── 4. RIGHT-CLICK → Reset (top-level, the Reset idiom law) → the node RE-CREATES
    // (kex2d-idioms stage 9): its tangent clears back to live (Auto inference resumes) AND its
    // position returns to the default-chord continuation past its predecessor — so the node
    // visibly MOVES off its authored hill spot. enabled whenever the node is editable (a no-op
    // reset records nothing). ──
    await page.mouse.click(cb.x + npos.x, cb.y + npos.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await clickMenuItem(page, ".nodemenu", "Reset");
    await expect.poll(async () => (await tangent()) === null).toBe(true); // cleared to live
    // the re-create moved the node: the re-baked node→sample map lands it away from the authored
    // spot it held through steps 1–3 (npos — handle drags reshape tangents, never the position).
    await expect
        .poll(async () => {
            const p = await nodePoint(page, 3);
            return Math.hypot(p.x - npos.x, p.y - npos.y);
        })
        .toBeGreaterThan(5);

    // ── 5. Esc exits the sub-mode back to plain selection, and the knobs COME BACK — the summon is a
    // round trip, not a one-way hide (a guard that never restores would pass the step-1 assert alone).
    // Escape is LAYERED, so both layers below it have to be pinned or the press peels the wrong one:
    // the node menu has to be gone (a menu still mounted takes the key first — measured: this poll is
    // what made the exit land), and tangent edit has to still be ON, or the key falls through to the
    // selection rung and the knob asserts go red for the wrong reason.
    await expect(page.locator(".nodemenu")).toHaveCount(0);
    expect(await editing()).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(editing).toBe(false);
    await expect(page.locator(".manip-length")).toBeVisible();
    await expect(page.locator(".manip-angle")).toBeVisible();
});

// Drive the TANGENT-EDIT FREE BODY DRAG (kex2d-node-move-ux stage 3): once a node is the
// tangent-edited subject, grabbing its own BODY — not a handle — moves it directly and unsnapped,
// the summoned inner layer's own idiom (handle drags are already free/no-guide); this retires the
// default surface's select-only body rule for THIS one subject only. (a) a sub-DRAG_PX press/
// release still stays a plain click — the same dead zone the "select-only body drag" positive
// control above pins, replayed here to prove the gate survives inside tangent edit; (b) past the
// zone the node lands EXACTLY where a real, UNSNAPPED move puts it — the manipulator knobs always
// land on the 1 m / 5° grid, so the chord's fractional metre is the unsnapped-gesture signature —
// as one undo entry, guides left clear; (c) a window blur mid-drag cancels it completely, the
// `dragNode` branch of the same blur-teardown the manip drag's blur pin (above) drives for
// `dragManip`; (d) Escape mid-drag cancels it the same way WITHOUT also exiting tangent edit (the
// layered-dismissal law — one press peels one rung), a second Escape then reaching that rung; (e)
// Delete/Backspace never fires the structural trim mid-drag (the stale-eid hazard a destructive op
// racing a live gesture's raw eid would hit), driven on the chain TIP since only its own end-node
// trim can fire at all (an interior node's own trim is already blocked by `endSelected`).
test("tangent-edit free node-body drag", async ({ page, boot }) => {
    await boot();

    const nodeCount = () => kexCall(page, "nodeCount");
    const editing = () => kexCall(page, "editing");
    const selectedOrder = () => kexCall(page, "selectedOrder");
    const undoDepth = () => kexCall(page, "undoDepth");
    const poses = () => kexCall(page, "poses");
    const guides = () => kexCall(page, "guides");
    const cam = () => kexCall(page, "cam");

    await seedHill(page);
    await expect.poll(nodeCount).toBe(7);
    await page.keyboard.press("f");

    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");

    const npos = await nodePoint(page, 3);
    await page.mouse.dblclick(cb.x + npos.x, cb.y + npos.y);
    await expect.poll(editing).toBe(true);
    expect(await selectedOrder()).toBe(3);

    // (a) sub-DRAG_PX: still a plain click (the dead zone), same as the default surface.
    const before = await poses();
    const undo0 = await undoDepth();
    await page.mouse.move(cb.x + npos.x, cb.y + npos.y);
    await page.mouse.down();
    await page.mouse.move(cb.x + npos.x + 2, cb.y + npos.y + 1, { steps: 2 }); // < DRAG_PX (4px)
    await page.mouse.up();
    expect((await poses())[3]).toEqual(before[3]);
    expect(await undoDepth()).toBe(undo0);

    // (b) past the dead zone: land EXACTLY at a chosen world point, so "unsnapped" is checked
    // against the actual landing rather than merely "moved" (a re-snapped regression would still
    // pass a bare displacement assert). `poses()` is the LOCAL Handle.pos; this section's entry
    // frame is identity (the first section), so it's world-comparable to `cam()`'s affine directly.
    // Target the previous node's chord at exactly `floor(oldChord) + 2.5` — a fractional metre of
    // 0.5 by construction, the farthest point from any 1 m grid line, so the "away from the nearest
    // multiple" assert below can't flake regardless of what the pre-drag chord happened to be.
    const [zoom, ox, oy] = await cam();
    const p2 = (await poses())[2];
    const oldChord = Math.hypot(before[3][0] - p2[0], before[3][1] - p2[1]);
    const ux = (before[3][0] - p2[0]) / oldChord;
    const uy = (before[3][1] - p2[1]) / oldChord;
    const targetChord = Math.floor(oldChord) + 2.5;
    const targetWorld = { x: p2[0] + ux * targetChord, y: p2[1] + uy * targetChord };
    const targetScreen = { x: ox + targetWorld.x * zoom, y: oy - targetWorld.y * zoom }; // cameraTx
    await page.mouse.move(cb.x + npos.x, cb.y + npos.y);
    await page.mouse.down();
    await page.mouse.move(cb.x + targetScreen.x, cb.y + targetScreen.y, { steps: 10 });
    await page.mouse.up();
    const moved = (await poses())[3];
    const newChord = Math.hypot(moved[0] - p2[0], moved[1] - p2[1]);
    expect(Math.abs(newChord - targetChord)).toBeLessThan(0.05); // landed at the intended point
    const nearestMultiple = Math.round(newChord);
    expect(Math.abs(newChord - nearestMultiple)).toBeGreaterThan(0.1); // the unsnapped signature
    expect(await undoDepth()).toBe(undo0 + 1); // one drag → one undo entry
    expect(await guides()).toEqual({ ray: false, angle: null, length: null }); // no guide, ever

    // (c) blur mid-drag cancels completely — the dragNode teardown branch (positive control: the
    // node is verifiably mid-move, and nothing has committed yet, before the blur fires). the node
    // moved to a new screen point in (b), so re-locate it (a stale cached point would miss the
    // pick entirely and this whole step would vacuously no-op — `kex2d-harness.md`'s pointer law).
    const npos2 = await nodePoint(page, 3);
    const pre = (await poses())[3];
    const undoPre = await undoDepth();
    await page.mouse.move(cb.x + npos2.x, cb.y + npos2.y);
    await page.mouse.down();
    await page.mouse.move(cb.x + npos2.x + 30, cb.y + npos2.y + 30, { steps: 8 });
    const mid = (await poses())[3];
    expect(Math.hypot(mid[0] - pre[0], mid[1] - pre[1])).toBeGreaterThan(0.01); // it moved…
    expect(await undoDepth()).toBe(undoPre); // …but nothing committed yet

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    const reverted = (await poses())[3];
    expect(reverted[0]).toBeCloseTo(pre[0], 5);
    expect(reverted[1]).toBeCloseTo(pre[1], 5);
    expect(await guides()).toEqual({ ray: false, angle: null, length: null });
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0);
    expect(await undoDepth()).toBe(undoPre);
    await page.mouse.up(); // release cleanly — the gesture is already torn down

    // exit tangent edit on node 3 (a plain rest-state Escape — no live gesture) and switch subject
    // to the chain TIP for (d)/(e): the trim/delete branch only fires on the chain end
    // (`endSelected`), so the mid-drag Delete guard needs a subject where the op would otherwise
    // actually run.
    expect(await editing()).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(editing).toBe(false);

    const tip = await nodePoint(page, 6);
    await page.mouse.dblclick(cb.x + tip.x, cb.y + tip.y);
    await expect.poll(editing).toBe(true);
    expect(await selectedOrder()).toBe(6);

    // (d) Escape mid-drag cancels the free move WITHOUT exiting tangent edit — the layered-
    // dismissal law (`kex2d-harness.md`): one press peels one rung, so the handles stay up and a
    // SECOND Escape is what reaches the tangent-edit rung (the round trip the summon test above
    // already pins at rest — this proves it survives with a gesture also live).
    const preD = (await poses())[6];
    const undoD = await undoDepth();
    await page.mouse.move(cb.x + tip.x, cb.y + tip.y);
    await page.mouse.down();
    await page.mouse.move(cb.x + tip.x + 25, cb.y + tip.y + 25, { steps: 6 });
    const midD = (await poses())[6];
    expect(Math.hypot(midD[0] - preD[0], midD[1] - preD[1])).toBeGreaterThan(0.01); // really live
    await page.keyboard.press("Escape");
    const afterEscape = (await poses())[6];
    expect(afterEscape[0]).toBeCloseTo(preD[0], 5); // reverted…
    expect(afterEscape[1]).toBeCloseTo(preD[1], 5);
    expect(await undoDepth()).toBe(undoD); // …nothing committed…
    expect(await editing()).toBe(true); // …and tangent edit is STILL open (one rung, not two)
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0); // capture released
    await page.mouse.up(); // release cleanly — the gesture is already torn down

    await page.keyboard.press("Escape"); // the second press now reaches the tangent-edit rung
    await expect.poll(editing).toBe(false);
    await page.mouse.dblclick(cb.x + tip.x, cb.y + tip.y); // re-summon for (e)
    await expect.poll(editing).toBe(true);

    // (e) Delete/Backspace is a no-op mid-drag — the structural trim would destroy the very node
    // the drag holds a raw eid for (the stale-eid hazard). Node count and the live gesture both
    // hold through the keypress; releasing the pointer commits the (untouched) move exactly as a
    // Delete-free drag would — Delete was swallowed, not queued for after release.
    const preE = (await poses())[6];
    const nodeCountE = await nodeCount();
    const undoE = await undoDepth();
    await page.mouse.move(cb.x + tip.x, cb.y + tip.y);
    await page.mouse.down();
    await page.mouse.move(cb.x + tip.x + 25, cb.y + tip.y + 25, { steps: 6 });
    const midE = (await poses())[6];
    expect(Math.hypot(midE[0] - preE[0], midE[1] - preE[1])).toBeGreaterThan(0.01); // really live
    await page.keyboard.press("Delete");
    expect(await nodeCount()).toBe(nodeCountE); // nothing destroyed
    const stillMid = (await poses())[6];
    expect(stillMid[0]).toBeCloseTo(midE[0], 5); // the gesture itself kept running (no queueing)
    expect(stillMid[1]).toBeCloseTo(midE[1], 5);
    await page.mouse.up();
    expect(await nodeCount()).toBe(nodeCountE); // still nothing destroyed after release
    expect(await undoDepth()).toBe(undoE + 1); // the drag itself committed normally
});

// Drive the START-HANDLE EDIT flow (kex2d-geo-ux stage 1): the section entry (node 0) is now
// selectable + its tangent editable. The START diamond and the first section's node 0 are
// coincident at the origin, so a plain click selects the START (v0 popover) while a DOUBLE-CLICK
// reaches node 0's entry handle (feel round 12). Frame the default flat seed → double-click the START →
// assert node 0 (order 0) entered tangent edit with no stored tangent (Auto) → drag its OUT-handle (the single
// free entry handle) → assert an authored tangent + a re-bake → RIGHT-CLICK the START for node 0's
// menu (Handles + Reset ONLY — no mode submenu) → Reset clears it back to live. Every affordance is
// a real canvas pointer event located via __kex (canvas-drawn handles carry no DOM box); the node
// menu is asserted for the ABSENCE of a "Tangents" submenu, the node-0 menu's distinguishing shape.
test("start handle edit flow", async ({ page, boot }) => {
    await boot();

    const tTotal = () => kexCall(page, "tTotal");
    const editing = () => kexCall(page, "editing");
    const selectedOrder = () => kexCall(page, "selectedOrder");
    const undoDepth = () => kexCall(page, "undoDepth");
    const startAt = () => kexCall(page, "startAt");
    const tangent = () => kexCall(page, "tangent");
    const handles = () => kexCall(page, "tangentHandles");

    // the default flat seed bakes on load — no seedHill, so the START diamond at the origin sits
    // clear of shape nodes (node 1 is a full EXTEND_DIST out). frame it so the entry handle
    // separates at pixel scale (hover defaults to the viewport, so `f` routes there).
    await expect.poll(tTotal).toBeGreaterThan(0);
    await page.keyboard.press("f");

    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");

    // ── 1. DOUBLE-CLICK the START diamond → node 0 (order 0) enters tangent edit (feel round 12: the
    // double-click summon restored, uniform across all nodes). its single out-handle (the entry
    // handle) draws; node 0 is inferred (Auto). ──
    const sp = await startAt();
    if (!sp) throw new Error("START point not located");
    await page.mouse.dblclick(cb.x + sp.x, cb.y + sp.y);
    await expect.poll(editing).toBe(true);
    expect(await selectedOrder()).toBe(0); // the entry anchor, reached at the START
    expect(await tangent()).toBeNull(); // Auto — the default flow stamps nothing
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "start-1-summon.png") });

    // ── 2. Drag the OUT-handle up → the entry handle is authored (a single free handle) and the
    // first segment re-bakes (the recovered force, so the ride time, shifts). ──
    const out = (await handles()).find((h) => h.side === "out");
    if (!out) throw new Error("node-0 out-handle not exposed at the START");
    const tBefore = await tTotal();
    await page.mouse.move(cb.x + out.x, cb.y + out.y);
    await page.mouse.down();
    await page.mouse.move(cb.x + out.x, cb.y + out.y - 60, { steps: 12 }); // up = +world y
    await page.mouse.up();

    const dragged = await tangent();
    expect(dragged).not.toBeNull();
    if (!dragged) throw new Error("tangent null after the entry-handle drag");
    expect(dragged.mode).toBe(2); // TangentMode.Free — node 0's single free handle
    expect(Math.hypot(dragged.outX, dragged.outY)).toBeGreaterThan(0.1); // a real authored vector
    await expect.poll(async () => Math.abs((await tTotal()) - tBefore) > 1e-4).toBe(true);
    expect(await undoDepth()).toBeGreaterThan(0);
    await page.screenshot({ path: join(OUT, "start-2-drag.png") });

    // ── 3. RIGHT-CLICK the START → node 0's menu: Handles + Reset ONLY, no mode submenu (the
    // single-free-handle shape). assert the "Tangents" submenu is ABSENT, then Reset back to live. ──
    await page.mouse.click(cb.x + sp.x, cb.y + sp.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await expect(
        page.locator(".nodemenu").getByRole("menuitem", { name: "Tangents", exact: true }),
    ).toHaveCount(0); // no mode submenu on node 0
    await expect(
        page.locator(".nodemenu").getByRole("menuitem", { name: "Handles" }),
    ).toBeVisible();
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "start-3-menu.png") });
    await page.locator(".nodemenu").getByRole("menuitem", { name: "Reset" }).click();
    await expect.poll(async () => (await tangent()) === null).toBe(true); // cleared to live
});

// Regression net for the context-menu OVERFLOW class (kex2d-force-ux UX fix): a right-click on a
// keyframe near the BOTTOM of the timeline used to open its menu extending downward PAST the
// viewport, the bottom rows unreachable. `fitMenu` (menu.ts) now flips the menu up (and left near
// the right edge) so the whole box stays in the window. This drives it pointer-true: right-click
// the lowest-on-screen keyframe (its downward-opening menu is the one that overflowed), assert the
// `.fmenu` bounding rect fits every viewport edge, then open its Easing ▸ flyout from that
// (up-flipped) menu and assert the SUBMENU fits too — a flyout off a bottom-anchored menu is the
// second overflow surface. A selector `.click()` proves nothing here; a real box that spills past
// the viewport is exactly what a human pointer can't reach, so this reads the laid-out rect.
test("context menu stays in the viewport near the bottom edge", async ({ page, boot }) => {
    await boot();

    const forceCount = () => kexCall(page, "forceCount");
    const tTotal = () => kexCall(page, "tTotal");

    // seed a force section with an airtime bump → keyframes spanning the g-range, so the 0g crest
    // sits LOW in the chart (near the viewport bottom, where its menu would overflow). the bump's
    // own bake is what the diamonds are read off, and `tTotal > 0` is satisfied by the FLAT SEED's
    // bake (already landed on load), so wait out the flat one and then for it to CHANGE.
    await expect.poll(tTotal).toBeGreaterThan(0);
    const tFlat = await tTotal();
    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBeGreaterThanOrEqual(3);
    await expect.poll(tTotal).not.toBe(tFlat);
    await frameTimeline(page); // whole force section on-screen so every diamond has a DOM box
    const nPts = await forceCount();
    await expect(page.locator(".fpt")).toHaveCount(nPts);

    const vp = page.viewportSize();
    if (!vp) throw new Error("no viewport size");

    // find the lowest-on-screen keyframe (largest y = nearest the bottom edge) — its
    // downward-opening context menu is the one the flip fix rescues.
    const fpts = page.locator(".fpt");
    let lowest = 0;
    let lowestY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < nPts; i++) {
        const b = await fpts.nth(i).boundingBox();
        if (b && b.y + b.height / 2 > lowestY) {
            lowestY = b.y + b.height / 2;
            lowest = i;
        }
    }
    // the low keyframe really is near the bottom — otherwise this test can't exercise the overflow.
    expect(lowestY).toBeGreaterThan(vp.height * 0.6);

    await fpts.nth(lowest).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    const mb = await page.locator(".fmenu").boundingBox();
    if (!mb) throw new Error("force keyframe menu not laid out");
    // the whole menu box sits inside the window on all four edges (the bug: mb.y + mb.height > vp.height).
    expect(mb.y + mb.height).toBeLessThanOrEqual(vp.height);
    expect(mb.x + mb.width).toBeLessThanOrEqual(vp.width);
    expect(mb.y).toBeGreaterThanOrEqual(0);
    expect(mb.x).toBeGreaterThanOrEqual(0);

    // open the Easing ▸ flyout from the (up-flipped) menu → the submenu must fit too.
    await page.locator(".fmenu").getByRole("menuitem", { name: "Easing", exact: true }).hover();
    const sub = page.locator(".fmenu .submenu");
    await expect(sub).toBeVisible();
    const sb = await sub.boundingBox();
    if (!sb) throw new Error("Easing submenu flyout not laid out");
    expect(sb.y + sb.height).toBeLessThanOrEqual(vp.height);
    expect(sb.x + sb.width).toBeLessThanOrEqual(vp.width);
    expect(sb.y).toBeGreaterThanOrEqual(0);
    expect(sb.x).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Escape");
});

// Drive the VIEWPORT KIND-COLOR shot (kex2d-ux-foundations stage D): a geo section
// appended by a force section, both feasible — zooms the viewport in on the boundary
// (real wheel zoom-at-cursor, not a fixed-scale clip) so the track polyline's per-
// section kind color reads at pixel scale, not just the clip strip. The other flows'
// full-page shots leave the polyline too small (and handle-occluded) to judge by eye.
// The appended force section CONTINUES the hill's recovered entry force (the two
// continuation keyframes an append seeds), so the chain is feasible end to end and the
// shot reads as the kind-color boundary it exists to show. It used to capture an
// "insufficient velocity" dashed-red tail instead, from a flat 1g profile — that came
// from appending before the hill had baked, so the seeds continued the FLAT seed's exit,
// and it flipped run to run. The two infeasible-red priority renders that accident covered now
// have their own deliberate scenario — `viewport infeasible shot` below.
test("viewport kind color shot", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");

    // a shaped geo lead-in, then an appended force section (default flat 1g profile).
    await seedHill(page);
    await kexCall(page, "append", 1); // SectionKind.Force
    await expect.poll(sectionCount).toBe(2);

    // the kind-colored curve, in the dock's chart — geo span cool blue, force span
    // accent gold, the same language as the clip strip right above it.
    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "kind-color-curve.png"), clip: strip });

    // zoom the viewport in on the chain start (a real wheel zoom-at-cursor, over the
    // canvas — the default framing already centers the track's origin there).
    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    const cx = cb.x + cb.width / 2;
    const cy = cb.y + (cb.height - DOCK_RESERVE) / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -1800); // deltaY < 0 → zoom in

    // The zoom-at-cursor leaves the pointer ON the geo span (the default framing put the chain
    // start under it), which lights the HOVER rung — so the base-rung shot parks the pointer off
    // the track first, and the hover rung gets its own shot below. Measured: without this the
    // base shot's geo span came back #83b2e6, not #78a5d6.
    const zoomedClip = { x: cb.x, y: cb.y, width: cb.width, height: cb.height - DOCK_RESERVE };
    await page.mouse.move(cb.x + 4, cb.y + 4);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "kind-color.png"), clip: zoomedClip });

    // hover the geo span → it lifts one rung in its OWN kind color (`hovered` in colors.ts, the
    // canvas twin of the clip strip's hover fill) while the force span and the dock's own surfaces
    // hold their base color: hover is viewport-local, deliberately unsynced across surfaces. A shot
    // pair against `kind-color.png`, same clip and camera, only the pointer moved.
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "kind-color-hover.png"), clip: zoomedClip });

    // select the force section — the accent overlay is a BRIGHTENED analog of the section's own
    // gold, not a flat recolor, so the boundary still reads as a kind boundary while selected.
    // (The infeasible-red > selection priority is the `viewport infeasible shot` flow below; this
    // chain is feasible end to end.)
    await page.locator(".clip").nth(1).click();
    await expect.poll(() => kexCall(page, "selectedSection")).not.toBe(null);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "kind-color-selected.png"), clip: zoomedClip });
});

// Drive the INFEASIBLE-TRACK shot: the two stacked-language renders the kind-color flow above
// used to cover only by accident (an append racing the bake), authored deliberately here —
// (a) dashed infeasible red over a kind-colored chain, (b) that same red UNDER a selected
// section's accent overlay, which must not paint over it (`editor-ui.md` Kind color: priority is
// infeasible-red > selection > kind; red is the infeasible rung of the dash channel — Mode
// vocabulary).
//
// The scenario is a hill the launch can't climb, and every number in it is derived from the
// energy budget, not tuned: speed comes only from height (`v² = v0² − 2g·Δy`, g = 9.80665), so a
// launch at 16 m/s buys 13.0 m of rise before v hits V_WARN (1 m/s) and the track goes red. The
// chain spends it in two sections — a 2g pull-up (the seed section, converted to force, with one
// authored keyframe at mid-extent) climbs 5.8 m and leaves at 33° still doing 11.9 m/s, then the
// appended geo ramp continues straight at that angle and runs out of height 56% of the way up.
// Nothing in the authoring steps reads the bake (a convert at the track start seeds `DEFAULT_G`
// outright, and both a keyframe create and a geo append are pure component writes), so this chain
// can't drift run to run the way the raced append did.
//
// The red must land in the GEO ramp, and that placement is load-bearing, not cosmetic: a geo
// section's shape is AUTHORED (positions in, force recovered out), so it draws a clean straight
// line no matter how depleted the cart is, whereas a force section INTEGRATES `dθ = (F_n − cos θ)
// ·g·Δs/v²` — with v floored at V_FLOOR (0.01) that denominator amplifies the f32 residue into a
// scribble the moment the section's own speed collapses. So the pull-up stays comfortably
// feasible and only the ramp goes red.
test("viewport infeasible shot", async ({ page, boot }) => {
    await boot();

    const tTotal = () => kexCall(page, "tTotal");
    const v0 = () => kexCall(page, "v0");
    const kind = () => kexCall(page, "kind");
    const forceCount = () => kexCall(page, "forceCount");
    const sectionCount = () => kexCall(page, "sectionCount");
    const sectionIds = () => kexCall(page, "sectionIds");
    const selectedSection = () => kexCall(page, "selectedSection");
    const startAt = () => kexCall(page, "startAt");
    // the bake's own feasibility flags (src/main.ts) — the render's input, not a pixel read.
    type Span = { first: number; count: number; section: number | null; head: number };
    const infeasibleSpan = () => kexCall(page, "infeasibleSpan");

    // the default flat seed bakes on load — the START diamond at the world origin has no shape
    // node on top of it, so it picks cleanly (the v0 flow's framing).
    await expect.poll(tTotal).toBeGreaterThan(0);

    // ── 1. Author the launch speed through the REAL START popover: 16 m/s. ──
    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    const cx = cb.x + cb.width / 2;
    const cy = cb.y + (cb.height - DOCK_RESERVE) / 2;
    await page.mouse.click(cx, cy);
    await expect(page.locator(".vtip")).toBeVisible();
    await page.locator(".vtip input").fill("16");
    await page.keyboard.press("Enter");
    await expect.poll(v0).toBeCloseTo(16, 3);

    // ── 2. Flip the seed section to force and author the pull-up: the convert seeds two
    // continuation keyframes at `DEFAULT_G` (a section entering at the track start has no upstream
    // sample to recover a force from, so `bakeEntryForce` hands back the 1g fallback), and one
    // authored keyframe at mid-extent pulls 2g — enough to leave at 33°, gently enough that the
    // section's own speed never approaches the floor. ──
    await kexCall(page, "convert");
    await expect.poll(kind).toBe(1); // SectionKind.Force
    await expect.poll(forceCount).toBe(2); // the two seeded continuation keyframes
    await kexCall(page, "placeForce", FORCE_LEN / 2, 2);
    await expect.poll(forceCount).toBe(3);

    // ── 3. Append the geo ramp — a straight two-node seed placed rigidly at the pull-up's exit,
    // so it climbs at the exit angle until the energy runs out. ──
    await kexCall(page, "append", 0); // SectionKind.Geo
    await expect.poll(sectionCount).toBe(2);

    // ── 4. The chain is really infeasible, by the app's own signal. This is also the honest
    // bake-readiness wait: nothing in this chain is infeasible until the appended ramp is IN the
    // bake (the pull-up alone exits at 11.9 m/s), so a count or a `tTotal > 0` would pass on the
    // previous track — the flag flipping is the bake output changing. ──
    // the polled read is the one that gets USED (`nodePoint`'s rule): re-reading after the poll
    // would assert against a second, unvalidated evaluation.
    const seen: Span[] = [];
    await expect
        .poll(async () => {
            seen[0] = await infeasibleSpan();
            return seen[0].first;
        })
        .toBeGreaterThan(0);
    const span = seen[0];
    if (!span) throw new Error("the bake never reported an infeasible sample");
    const ids = await sectionIds();
    // the RAMP owns the red, and the pull-up is clean (a boundary sample resolves upstream, so
    // this equality also says the first infeasible sample is past the pull-up's last one).
    expect(span.section).toBe(ids[1]);
    // the chain is meaningfully red, not one blip: `count` is every infeasible sample track-wide,
    // and samples are `ds` = 0.5 m apart (DS_NOMINAL, src/track.ts), so 8 of them is 7 edges =
    // 3.5 m of dashed track — several dash periods at any framing that shows the chain.
    expect(span.count).toBeGreaterThanOrEqual(8);
    // …and the ramp still has a FEASIBLE head under the red, held to the same floor — without it
    // the accent in shot (b) would have nothing to paint and "red survives the accent" is vacuous.
    expect(span.head).toBeGreaterThanOrEqual(8);
    // and the user-facing half of the same signal, at the layer they see it.
    await expect(page.locator(".warning")).toBeVisible();

    // ── 5. (a) infeasible red over kind color. Drop the START selection first (its popover would
    // sit over the chain), then frame the track with a real `F`: the load framing spans ±280 m, so
    // the 43 × 19 m chain sits in it as a ~110 px squiggle — held, but far too small to judge a
    // dash pattern by eye. `F` fits it (the same reason the tangent flow frames its hill). ──
    await page.keyboard.press("Escape"); // Enter already blurred the field, so this deselects
    await expect(page.locator(".vtip")).toHaveCount(0);
    const originBefore = await startAt();
    if (!originBefore) throw new Error("START point not located");
    await page.mouse.move(cx, cy); // the hovered-surface router: `F` frames the viewport
    await page.keyboard.press("f");
    // …and the frame really landed: the load framing centers the world ORIGIN, the fit centers the
    // chain's BOX, so the START diamond travels far down-left. A swallowed key would otherwise
    // shoot the squiggle and pass. (Screen px, not world — this reads the same transform the
    // canvas draws through.)
    await expect
        .poll(async () => {
            const p = await startAt();
            return p ? Math.hypot(p.x - originBefore.x, p.y - originBefore.y) : 0;
        })
        .toBeGreaterThan(100);
    await page.waitForTimeout(SHOT_MS);
    const clip = { x: cb.x, y: cb.y, width: cb.width, height: cb.height - DOCK_RESERVE };
    await page.screenshot({ path: join(OUT, "infeasible-kind-color.png"), clip });

    // ── 6. (b) infeasible red UNDER the selection accent: select the ramp — the section that owns
    // the red — through its real clip. Its feasible head brightens; its infeasible tail must stay
    // dashed red, not be overpainted. ──
    await frameTimeline(page);
    await page.locator(".clip").nth(1).click();
    await expect.poll(selectedSection).toBe(ids[1]);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "infeasible-selected.png"), clip });
});

// Drive the VIEWPORT MULTISELECT flow (kex2d-multiselect stage 6): seed a shaped geo track →
// MARQUEE-select an interior run of nodes (a real rect drag from empty viewport space, past
// DRAG_PX) → SHIFT+MARQUEE toggles a member out then back in (the active-promotion rule, fired
// through a real gesture rather than the unit suite) → assert the canvas shows NO contextual chrome
// over the set (no knobs, no extend button, no readout — stage 8) and drive the per-node polar delta
// move through the ARROW-NUDGE instead, asserting every selected node moved in its own frame while
// the untouched neighbors on BOTH sides of the run held their authored position exactly (the chain-
// coupling locality: an unselected node's own control point never moves) → MARQUEE-select a valid
// Delete-able SUFFIX RUN (reaches the chain end) and delete it through the real node menu (Delete
// reads enabled) → MARQUEE-select an interior (non-suffix) run and assert the same Delete row
// reads disabled (grayed, never hidden) and a real click on it does nothing → finally, WHEEL
// DURING A GESTURE: a wheel tick held inside a live marquee leaves the camera scale exactly where
// it was, while the same tick at rest zooms (kex2d-ux-burndown stage 3 — this flow already owns the
// marquee, the gesture the guard exists for). Every gesture is a
// real pointer drag/click, located via exact node screen points (`__kex.nodeAt`); `nodeSelOrders`/
// `poses` are read-only asserts, never how a selection or move is performed.
test("viewport multiselect flow", async ({ page, boot }) => {
    await boot();

    const nodeCount = () => kexCall(page, "nodeCount");
    const nodeSelOrders = () => kexCall(page, "nodeSelOrders");
    const selectedOrder = () => kexCall(page, "selectedOrder");
    const poses = () => kexCall(page, "poses");

    await seedHill(page);
    await expect.poll(nodeCount).toBe(7);
    await page.keyboard.press("f"); // hover defaults to the viewport

    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");

    // every draggable node's screen point (orders 1-6; order 0 is the pinned entry anchor, never
    // a marquee target) — the rects below are computed from these EXACT points, never guessed
    // pixels, so a marquee's boundary can only ever hit the nodes it's meant to. A STRUCTURAL undo
    // (the delete undo below) destroys and respawns these nodes, and the map they're picked through
    // (`Handle.sample`) is rebuilt a frame later — so a cached point goes stale exactly when the
    // next marquee or right-click is about to use it. Re-locate through `nodePoint` (which waits the
    // re-bake out) after every respawning op; never reuse a point across one. A MOVE undo is the
    // other case — it rewrites poses in place, so the cached points come back valid and the wait is
    // for the bake to land on them again (step 3).
    const pt: Record<number, { x: number; y: number }> = {};
    const locate = async (): Promise<void> => {
        for (let o = 1; o <= 6; o++) pt[o] = await nodePoint(page, o);
    };
    await locate();
    const yAll = Object.values(pt).map((p) => p.y);
    const yLo = Math.min(...yAll) - 80; // well clear of PICK_R/SECTION_PICK_R at every rect corner
    const yHi = Math.max(...yAll) + 80;
    const mid = (a: number, b: number): number => (a + b) / 2;

    // ── 1. MARQUEE-select the interior run [2,3,4] (replace) — a rect bounded at the MIDPOINTS to
    // node 1 and node 5, so it can only ever hit 2/3/4 regardless of the hill's exact shape. ──
    const xLo1 = mid(pt[1].x, pt[2].x);
    const xHi1 = mid(pt[4].x, pt[5].x);
    await marqueeDrag(page, cb.x + xLo1, cb.y + yLo, cb.x + xHi1, cb.y + yHi);
    await expect.poll(nodeSelOrders).toEqual([2, 3, 4]);
    expect(await selectedOrder()).toBe(4); // the last hit — the active member (Blender active-object)
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "multiselect-viewport-marquee.png") });

    // ── 2. SHIFT+MARQUEE a rect bounding node 4 ALONE (midpoints to its two neighbors) toggles it
    // OUT of the set — the active-promotion rule (the most-recently-added survivor, node 3)
    // fires through a real gesture, not just the unit suite. the same rect toggles it back IN,
    // re-activating it. ──
    const xLo4 = mid(pt[3].x, pt[4].x);
    const xHi4 = mid(pt[4].x, pt[5].x);
    await marqueeDrag(page, cb.x + xLo4, cb.y + yLo, cb.x + xHi4, cb.y + yHi, true);
    await expect.poll(nodeSelOrders).toEqual([2, 3]);
    expect(await selectedOrder()).toBe(3); // promoted survivor
    await marqueeDrag(page, cb.x + xLo4, cb.y + yLo, cb.x + xHi4, cb.y + yHi, true);
    await expect.poll(nodeSelOrders).toEqual([2, 3, 4]);
    expect(await selectedOrder()).toBe(4); // re-added → active again

    // ── 2b. SHIFT-CLICK a node's BODY (not a marquee) toggles it — the exact gesture
    // `controls.ts`'s `onPointerDown` fires on `pickNode`'s hit (`select(eid, e.shiftKey ?
    // "toggle" : "replace")`, kexedit c897c70). shift-click the active MEMBER (node 4) toggles it
    // OUT (the survivor, node 3, promotes active); shift-click a NON-member (node 5) toggles it IN,
    // made active — then both are shift-clicked back to restore [2,3,4] active 4 for the move step
    // below. ──
    const shiftClickNode = async (o: number): Promise<void> => {
        await page.keyboard.down("Shift");
        await page.mouse.click(cb.x + pt[o].x, cb.y + pt[o].y);
        await page.keyboard.up("Shift");
    };
    await shiftClickNode(4);
    await expect.poll(nodeSelOrders).toEqual([2, 3]);
    expect(await selectedOrder()).toBe(3); // promoted survivor
    await shiftClickNode(5);
    await expect.poll(nodeSelOrders).toEqual([2, 3, 5]);
    expect(await selectedOrder()).toBe(5); // toggled in → active
    await shiftClickNode(5);
    await expect.poll(nodeSelOrders).toEqual([2, 3]);
    await shiftClickNode(4);
    await expect.poll(nodeSelOrders).toEqual([2, 3, 4]);
    expect(await selectedOrder()).toBe(4); // restored for the move step below

    // ── 3. The canvas shows NO contextual controls over a multi-set (stage 8, user-locked): both
    // manipulator knobs, the ring's extend button, and the metrics readout are all gone — every one
    // of them is single-subject. So the per-node polar delta lives on the KEYBOARD alone (capability
    // without chrome, Blender's gizmo-less move): one Shift+ArrowUp is one shared Δlength, applied
    // to each selected node in its own polar frame, as one undo entry. Every selected node (2, 3, 4)
    // must move — chained in ascending order — while the untouched nodes on BOTH sides of the run
    // (0, 1 upstream; 5, 6 downstream) hold their authored position exactly: an unselected node's
    // own control point never moves, only the selected suffix's does (the chain-coupling locality).
    // Mutation: drop the `nodeMulti` guards in App.svelte → the knobs/readout reappear → red. ──
    for (const sel of [".manip-length", ".manip-angle", ".rbtn.extend", ".snap-readout"])
        await expect(page.locator(sel)).toHaveCount(0);
    const before = await poses();
    await page.keyboard.press("Shift+ArrowUp"); // the length axis, coarse step
    const after = await poses();
    for (const o of [0, 1, 5, 6]) {
        expect(after[o][0]).toBeCloseTo(before[o][0], 5);
        expect(after[o][1]).toBeCloseTo(before[o][1], 5);
    }
    for (const o of [2, 3, 4]) {
        const moved = Math.hypot(after[o][0] - before[o][0], after[o][1] - before[o][1]);
        expect(moved).toBeGreaterThan(0.05);
    }
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "multiselect-viewport-move.png") });
    await page.keyboard.press("Control+z"); // one entry reverts the whole group
    await expect.poll(async () => (await poses())[4][0]).toBeCloseTo(before[4][0], 5);
    // A MOVE undo writes poses IN PLACE (`restoreNodes`) — no respawn, so `Handle.sample` never
    // resets and `nodePoint`'s off-origin predicate is instantly true against the still-NUDGED bake
    // (re-locating here returns pre-undo points, ~20px off). The cached `pt` ARE the post-undo
    // targets, so the honest wait is the bake landing back ON them.
    const orders = [1, 2, 3, 4, 5, 6];
    await expect
        .poll(async () => {
            // batched in-page (one round trip for all six orders) — the ONE spot where a call
            // stays inline rather than going through `kexCall`, since that helper is one accessor
            // per round trip and this reads six in a single `page.evaluate`.
            const now = await page.evaluate(
                (os: number[]): ({ x: number; y: number } | null)[] =>
                    os.map((o) => (window as unknown as { __kex: Kex }).__kex.nodeAt(o)),
                orders,
            );
            return now.every(
                (p, i) =>
                    p !== null && Math.hypot(p.x - pt[orders[i]].x, p.y - pt[orders[i]].y) < 1,
            );
        })
        .toBe(true);

    // ── 4. MARQUEE-select the Delete-able SUFFIX RUN [4,5,6] (reaches the chain end, excludes
    // node 0, leaves ≥ 2) → right-click a MEMBER (node 5, keeping the set) → the node menu's
    // Delete row reads ENABLED → a real pointer-true click removes all three in one entry. ──
    const xLo456 = mid(pt[3].x, pt[4].x);
    const xHi456 = pt[6].x + (pt[6].x - pt[5].x); // past the chain end, one more gap's worth
    await marqueeDrag(page, cb.x + xLo456, cb.y + yLo, cb.x + xHi456, cb.y + yHi);
    await expect.poll(nodeSelOrders).toEqual([4, 5, 6]);
    await page.mouse.click(cb.x + pt[5].x, cb.y + pt[5].y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    const validDelete = page.locator(".nodemenu").getByRole("menuitem", { name: "Delete" });
    await expect(validDelete).toBeEnabled();
    await clickMenuItem(page, ".nodemenu", "Delete");
    await expect.poll(nodeCount).toBe(4);
    await expect.poll(nodeSelOrders).toEqual([3]); // pruned to the surviving tip
    await page.keyboard.press("Control+z");
    await expect.poll(nodeCount).toBe(7); // the count is satisfied by the synchronous restore…
    await locate(); // …and this waits out the re-bake that rebuilds the points

    // ── 5. MARQUEE-select an INTERIOR (non-suffix) run [2,3] — contiguous, excludes node 0, but
    // doesn't reach the chain end — the SAME Delete row reads DISABLED (grayed, never hidden); a
    // real click on it does nothing (the row is inert, not just visually dim). ──
    const xLo23 = mid(pt[1].x, pt[2].x);
    const xHi23 = mid(pt[3].x, pt[4].x);
    await marqueeDrag(page, cb.x + xLo23, cb.y + yLo, cb.x + xHi23, cb.y + yHi);
    await expect.poll(nodeSelOrders).toEqual([2, 3]);
    await page.mouse.click(cb.x + pt[2].x, cb.y + pt[2].y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    const invalidDelete = page.locator(".nodemenu").getByRole("menuitem", { name: "Delete" });
    await expect(invalidDelete).toBeDisabled();
    const idb = await invalidDelete.boundingBox();
    if (idb) await page.mouse.click(idb.x + idb.width / 2, idb.y + idb.height / 2);
    await expect.poll(nodeCount).toBe(7); // the grayed row did nothing
    await page.keyboard.press("Escape");

    // ── 6. WHEEL IS A NO-OP DURING A LIVE GESTURE (kex2d-ux-burndown stage 3). Every gesture
    // caches screen px at grab and resolves the rest of the drag through the camera, so a
    // mid-gesture zoom hands it a map its grab never saw (`controls.ts` `onWheel` carries the
    // per-gesture damage). The contract is the camera itself: the whole `[zoom, ox, oy]` must come
    // out IDENTICAL across a held gesture — a no-op writes nothing — and the marquee is the gesture
    // driven here because this flow already owns it and it authors nothing, so the assert is about
    // the camera alone. The idle wheel after release is the positive control: the same event at the
    // same place, which MUST zoom, so a guard that merely killed the wheel outright can't pass the
    // pair (it is also what proves the mid-gesture tick was reaching this surface at all). The
    // timeline half of the one rule rides the timeline multiselect flow. Mutation: drop the
    // `editor.dragging` early-return in `controls.ts` `onWheel` → the held camera moves → red
    // (proven against that build: zoom 51.857 → 81.328 under the held marquee). ──
    const cam = () => kexCall(page, "cam");
    const held = await cam();
    await page.mouse.move(cb.x + xLo23, cb.y + yLo);
    await page.mouse.down();
    await page.mouse.move(cb.x + xHi23, cb.y + yHi, { steps: 6 }); // past DRAG_PX → a real marquee
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1); // the gesture IS live
    await page.mouse.wheel(0, -600); // a zoom-in tick a resting viewport would answer
    await frames(page, 2); // the wheel is dispatched, not awaited — let any write land
    expect(await cam()).toEqual(held);
    await page.mouse.up();
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => (await cam())[0]).toBeGreaterThan(held[0]);

    // ── 6b. `F` IS ALSO A NO-OP DURING A LIVE GESTURE (kex2d-gesture-residue stage 2, the
    // wheel guard's open twin — the onWheel comment above names it). Both guard on the SAME
    // `editor.dragging` flag. A fresh marquee is the vehicle (it authors nothing, same as 6);
    // the idle wheel just above left the camera zoomed PAST its whole-track `F`-frame target
    // (an earlier `f` press at boot, line 3085, already established that fit as the baseline),
    // so a real reframe under this section is detectable — pinning the guard against a camera
    // already equal to its own no-op target proves nothing (the false-negative this flow's
    // wheel case avoids by using a relative zoom instead). The idle `F` after release is the
    // positive control: it MUST reframe back toward the whole-track fit (zoom decreases), so a
    // guard that merely eats the key outright can't pass the pair. Mutation: drop the
    // `editor.dragging` guard in `controls.ts`'s `F` handler → the held camera reframes under
    // the marquee → red. ──
    await page.keyboard.press("Escape"); // clear the selection the first marquee committed on
    // release — a selected node's summoned ring sits in this rect's start corner, and a
    // pointerdown there grabs a manipulator knob instead of arming a fresh marquee.
    const zoomed = await cam();
    await locate(); // the idle zoom above moved every node's screen point — re-locate through
    // the bake-ready reader before building the new rect, the kex2d-harness law (never drive a
    // pointer through a box cached across a camera change).
    const xLo23z = mid(pt[1].x, pt[2].x);
    const xHi23z = mid(pt[3].x, pt[4].x);
    const yAllZ = Object.values(pt).map((p) => p.y);
    const yLoZ = Math.min(...yAllZ) - 80;
    const yHiZ = Math.max(...yAllZ) + 80;
    await page.mouse.move(cb.x + xLo23z, cb.y + yLoZ);
    await page.mouse.down();
    await page.mouse.move(cb.x + xHi23z, cb.y + yHiZ, { steps: 6 }); // past DRAG_PX → a real marquee
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1); // the gesture IS live
    await page.keyboard.press("f");
    await frames(page, 2);
    expect(await cam()).toEqual(zoomed);
    await page.mouse.up();
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0);
    await page.keyboard.press("f");
    await expect.poll(async () => (await cam())[0]).toBeLessThan(zoomed[0]);
});

// kex2d-menu-grammar decision 8's cross-check is blind to `enabled`/`checked` unless the DOM
// scrape and the builder-answer mapping both carry them (`flow.ts`'s `MenuRow`/`domLevel`). This
// flow is the case that gap let through silently: the node menu's whole pin-mode LOCKDOWN
// (`App.svelte`'s `ok: editor.pinning === null` — editor-ui.md's Sandbox-mode UX, "the mode is a
// consent boundary") is wired ENTIRELY through `enabled`, so a label/group/separator-only
// cross-check (and every other gate: the pure grammar oracle, both registries, all 31 other
// captures) stays green even if that wiring silently inverted to `ok: true`. Only comparing the
// rendered `disabled` state against the SAME builder's answer for the SAME descriptor catches it.
test("node menu grays under the pin-mode lockdown (kex2d-menu-grammar)", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await expect.poll(() => kexCall(page, "nodeCount")).toBe(7);

    // a second, FORCE section becomes the pin subject — `nodeAt`'s hook always addresses section
    // 0 (`main.ts`'s `sec()`), so the geo hill's nodes stay reachable no matter which section a
    // pin session is open on, which is exactly what makes this the lockdown's OWN cross-check
    // rather than a coincidence of which section the mode happens to be pinning.
    await kexCall(page, "append", 1); // SectionKind.Force
    await expect.poll(() => kexCall(page, "sectionCount")).toBe(2);
    await frameTimeline(page);

    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    const n = await nodePoint(page, 3); // an interior hill node — not the entry, not the chain end

    const nodeState = (ok: boolean) => ({
        multi: false,
        isEntry: false,
        ok,
        editing: false,
        isEnd: false,
        canTrim: false,
        suffixOk: false,
    });

    // ── baseline, no pin session anywhere: the edit rows are live. ──
    await page.mouse.click(cb.x + n.x, cb.y + n.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await menuGrammar(page, ".nodemenu", {
        builder: "nodeMenu",
        state: nodeState(true),
        enums: { mode: "spline.TangentMode.Aligned" },
    });
    await page.keyboard.press("Escape");
    await expect(page.locator(".nodemenu")).toHaveCount(0);
    await page.keyboard.press("Escape"); // clear the selection the right-click made

    // ── enter pin mode on the OTHER (force) section. ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await clickMenuItem(page, ".ctxmenu", "Pin");
    await expect(page.locator(".pinpanel")).toBeVisible();
    await expect.poll(() => kexCall(page, "pinning")).toBe(true);

    // ── the lockdown: the SAME geo node's menu now grays Handles/Tangents/Reset. The builder
    // answer for `ok: false` says every one of those rows is disabled — asserting that against the
    // rendered DOM is what an `ok: true` regression at App.svelte's node-menu wiring would break.
    // Re-locate through `nodePoint` rather than reusing `n`: the pin panel docking in reflows the
    // viewport, which moves this node's SCREEN point even though its model-space position hasn't
    // changed (the kex2d-harness law against driving a pointer through a box cached across a
    // camera/layout change). ──
    const n2 = await nodePoint(page, 3);
    await page.mouse.click(cb.x + n2.x, cb.y + n2.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await menuGrammar(page, ".nodemenu", {
        builder: "nodeMenu",
        state: nodeState(false),
        enums: { mode: "spline.TangentMode.Aligned" },
    });
    await page.keyboard.press("Escape"); // rung 1: closes the menu, the right-clicked node stays selected
    await expect(page.locator(".nodemenu")).toHaveCount(0);
    await page.keyboard.press("Escape"); // rung 2: clears the node selection

    // exit the mode cleanly — Esc discards without trace (the sandbox contract).
    await page.keyboard.press("Escape"); // rung 3: Exit
    await expect.poll(() => kexCall(page, "pinning")).toBe(false);
});
