import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// Boot the kex2d page and drive the GEO-AUTHORING flow end to end (seed a shaped track →
// see the recovered F_n force curve → extend the chain → undo → reshape a node and watch
// the curve react), asserting the UI wiring against
// window.__kex at each step and screenshotting the states. The DEV-only __kex hook
// (src/main.ts) reads node/undo/track state and drives the geo edits; the flow drives the
// real UI (keyboard extend/trim, undo). The force-authoring flow is the next test.
// Screenshots land in KEX_OUT (a Windows path when staged; copied back).

const PORT = process.env.KEX_PORT ?? "3014";
const OUT = process.env.KEX_OUT ?? "shots";
const SETTLE_MS = Number(process.env.KEX_SETTLE_MS ?? "2500");

// window.__kex is the DEV harness hook (src/main.ts); the harness is outside the project
// tsconfig, so these page-context reads use `any` freely.

// two laid-out DOM rects overlap iff they intersect on BOTH axes — the popover-vs-workspace
// no-overlap assert reads the real rendered boxes (a selector test proves nothing about where a
// box actually paints).
type Rect = { x: number; y: number; width: number; height: number };
function overlaps(a: Rect, b: Rect): boolean {
    return (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
    );
}

// Appending a section PANS the timeline to reveal the new clip — the x-axis is a document
// axis, so a content edit never rescales/refits it (kex2d-ux-foundations stage C). The
// overflowing track then scrolls earlier clips off-screen, so this frames the whole chain
// back into view via a real zoom-out wheel (explicit navigation — `zoomAt` clamps the
// zoom-out to the whole-track fit), the way an author would after an append. Positional
// `.clip.nth()` locators below rely on every section being on-screen.
async function frameTimeline(page: Page): Promise<void> {
    const bb = await page.locator(".dock .body").boundingBox();
    if (!bb) throw new Error("timeline body not laid out");
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height * 0.7); // over the chart body
    await page.mouse.wheel(0, 3000); // deltaY ≫ 0 → zoom out, floored at the whole-track fit
    await page.waitForTimeout(SETTLE_MS);
}

// Pointer-true click on a context-submenu flyout item: really HOVER the parent row to open the
// flyout, then click the target item at its MEASURED CENTER — but first assert
// document.elementFromPoint there actually resolves to that item. A Playwright selector
// .click() fires the handler on an element even when an ancestor's overflow clips it out of
// paint AND hit-testing — which is exactly how the submenu-clip bug shipped invisible (the
// flyout was laid out at left:100% but unreachable by a real pointer). A coordinate click gated
// on elementFromPoint is what a human pointer can actually reach, so this flow is the permanent
// regression net for the whole context-submenu clip class.
async function clickFlyout(page: Page, menu: string, parent: string, item: string): Promise<void> {
    const m = page.locator(menu);
    // exact match: a parent label can substring-collide with one of its own flyout rows.
    await m.getByRole("menuitem", { name: parent, exact: true }).hover(); // real hover opens the flyout
    const target = m.getByRole("menuitem", { name: item });
    await expect(target).toBeVisible();
    const b = await target.boundingBox();
    if (!b) throw new Error(`flyout item "${item}" not laid out`);
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    const reachable = await page.evaluate(
        (p: { x: number; y: number; label: string }) => {
            const el = document.elementFromPoint(p.x, p.y);
            return el?.closest(".menu-item")?.textContent?.trim() === p.label;
        },
        { x, y, label: item },
    );
    expect(
        reachable,
        `flyout item "${item}" must be hit-testable at its own center (not clipped out of paint)`,
    ).toBe(true);
    await page.mouse.click(x, y); // coordinate click a real pointer can land
}

// Pointer-true click on a TOP-LEVEL menu row (no parent hover needed — the row isn't behind a
// flyout). Same elementFromPoint-gated coordinate click as clickFlyout, so a Delete/Reset row
// gets the same regression net a submenu row does: a selector `.click()` fires a handler on a
// clipped, humanly-unreachable element just as readily here as behind a flyout.
async function clickMenuItem(page: Page, menu: string, item: string): Promise<void> {
    // not exact — a row can carry a trailing shortcut span ("Delete Del"), so match by prefix.
    const target = page.locator(menu).getByRole("menuitem", { name: item });
    await expect(target).toBeVisible();
    const b = await target.boundingBox();
    if (!b) throw new Error(`menu item "${item}" not laid out`);
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    const reachable = await page.evaluate(
        (p: { x: number; y: number; label: string }) => {
            const el = document.elementFromPoint(p.x, p.y);
            return (el?.closest(".menu-item")?.textContent?.trim().startsWith(p.label)) ?? false;
        },
        { x, y, label: item },
    );
    expect(
        reachable,
        `menu item "${item}" must be hit-testable at its own center (not clipped out of paint)`,
    ).toBe(true);
    await page.mouse.click(x, y);
}

test("geo authoring flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();
    await expect(page.locator(".player")).toBeVisible();

    // read helpers over the DEV hook. expect.poll drives every wait — no fixed sleeps.
    const nodeCount = () => page.evaluate((): number => (window as any).__kex.nodeCount());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const poses = () => page.evaluate((): number[][] => (window as any).__kex.poses());

    // seed the airtime hill and wait for its first bake (the recovered force curve).
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await expect.poll(nodeCount).toBe(7);
    await page.waitForTimeout(SETTLE_MS); // let the cart + curve settle for the baseline shot

    // read-only baseline: the shaped track + its recovered F_n force curve.
    await page.screenshot({ path: join(OUT, "full.png") });
    const vp = page.viewportSize();
    if (vp) {
        await page.screenshot({
            path: join(OUT, "timeline.png"),
            clip: { x: 0, y: vp.height - 340, width: vp.width, height: 340 },
        });
    }

    // ── 1. Extend: select the chain end, press Enter → one node, one undo entry. ──
    await page.evaluate(() => (window as any).__kex.selectEnd());
    await page.keyboard.press("Enter");
    await expect.poll(nodeCount).toBe(8);
    expect(await undoDepth()).toBe(1);
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
    await page.keyboard.press("f"); // hover defaults to the viewport, so `f` routes there
    await page.waitForTimeout(SETTLE_MS);

    const canvas = page.locator("#app > canvas");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    const selectedOrder = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedOrder());
    const nodeAt = (order: number) =>
        page.evaluate(
            (o: number): { x: number; y: number } | null => (window as any).__kex.nodeAt(o),
            order,
        );

    // select node 3 (the crest) by a real body click; the polar knob buttons summon on it.
    const n3 = await nodeAt(3);
    if (!n3) throw new Error("node 3 not located");
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
    const n2 = await nodeAt(2);
    const lb = await page.locator(".manip-length").boundingBox();
    if (!n2 || !lb) throw new Error("length knob button / node 2 not located");
    const lk = { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 }; // the button center (page coords)
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
    const tipPos = await nodeAt(6); // the chain end (7 nodes → order 6)
    if (!tipPos) throw new Error("tip not located");
    await page.mouse.click(cb.x + tipPos.x, cb.y + tipPos.y); // select the tip → its knobs summon
    await expect.poll(selectedOrder).toBe(6);
    const ab = await page.locator(".manip-angle").boundingBox();
    if (!ab) throw new Error("angle knob not laid out");
    const ak = { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 };
    await page.mouse.move(ak.x, ak.y);
    await page.mouse.down();
    await page.mouse.move(ak.x + 28, ak.y - 28, { steps: 10 }); // rotate the tip to a snapped incline
    await page.waitForTimeout(120); // let the per-RAF tick project the drag readout
    const dragAngle = await readoutAngle();
    await page.mouse.up();
    await page.waitForTimeout(120); // let the resting readout settle
    const restAngle = await readoutAngle();
    expect(dragAngle).not.toBeNull();
    expect(restAngle).toBe(dragAngle); // drag == rest, exactly — no 25→25.5 drift on release

    // ── 4. Append (feel round 12 — extend restored to the ring): a PLAIN click never appends; the
    // ring's extend button (a real `.rbtn` at the chain end) appends, Enter's twin; and the node menu
    // carries Delete + Add, in that order. double-click now enters tangent edit (the tangent flow),
    // not append. the chain end is order 6 (7 nodes). ──
    const chainEnd = await nodeAt(6);
    if (!chainEnd) throw new Error("chain-end node not located");
    // a plain click selects the chain end but does NOT append.
    await page.mouse.click(cb.x + chainEnd.x, cb.y + chainEnd.y);
    await expect.poll(selectedOrder).toBe(6);
    expect(await nodeCount()).toBe(7); // no append on a plain click
    // the chain end shows the three-button ring: measure (−60°) · extend (front) · pitch (+60°).
    await expect(page.locator(".rbtn.extend")).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, "geo-3-ring.png") });
    // the ring's extend button appends one node; undo drops it.
    await page.locator(".rbtn.extend").click();
    await expect.poll(nodeCount).toBe(8);
    await page.keyboard.press("Control+z");
    await expect.poll(nodeCount).toBe(7);
    // the node menu (right-click the chain end) carries the structural ops (delete stays off-ring),
    // ordered by access frequency: Delete before Add. the rows are terse — the menu is ON the node,
    // so the noun would only restate its subject.
    await page.mouse.click(cb.x + chainEnd.x, cb.y + chainEnd.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await expect
        .poll(async () =>
            (await page.locator(".nodemenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Delete Del", "Add Enter", "Handles", "Tangents ▸"]); // ▸ = the submenu affix
    await page.keyboard.press("Escape"); // dismiss the menu

    // ── 5. Interior angle drag==rest (feel round 9): the SAME invariant on an INTERIOR node. its angle
    // knob snaps the chord, but the readout reports the node's (frozen) exit heading — drag AND rest,
    // the same number. before the fix the drag showed the chord (moving), the rest the heading. ──
    const interiorPos = await nodeAt(3); // an interior node of the seeded hill
    if (!interiorPos) throw new Error("interior node not located");
    await page.mouse.click(cb.x + interiorPos.x, cb.y + interiorPos.y);
    await expect.poll(selectedOrder).toBe(3);
    const iab = await page.locator(".manip-angle").boundingBox();
    if (!iab) throw new Error("interior angle knob not laid out");
    const iak = { x: iab.x + iab.width / 2, y: iab.y + iab.height / 2 };
    await page.mouse.move(iak.x, iak.y);
    await page.mouse.down();
    await page.mouse.move(iak.x + 26, iak.y + 26, { steps: 10 }); // rotate the interior node
    await page.waitForTimeout(120);
    const iDrag = await readoutAngle();
    await page.mouse.up();
    await page.waitForTimeout(120);
    const iRest = await readoutAngle();
    expect(iDrag).not.toBeNull();
    expect(iRest).toBe(iDrag); // interior drag == rest — one consistent quantity (the exit heading)

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the TANGENT-EDIT flow (kex2d-authoring-surface stage 9): seed a shaped geo track →
// frame it → DOUBLE-CLICK an interior node to enter tangent edit (feel round 12 restored the
// double-click summon; the node is inferred, no stored tangent) → RIGHT-CLICK
// the node to open the NODE context menu (Handles + a Tangents ▸ submenu) → open the submenu → set
// FREE → drag its out-handle → assert Free independence and a re-bake → Reset via the submenu clears
// the node back to live (Auto). The summon is a real canvas double-click, the node menu a real canvas
// right-click (both located via __kex.nodeAt); the handle drag is a real canvas pointer drag located
// through
// __kex.tangentHandles (canvas-drawn handles carry no DOM box). Handle drags no longer snap, so
// the drag lands where the pointer goes. The submenu items (Free, Reset) are clicked pointer-true
// via clickFlyout — a coordinate click gated on elementFromPoint reachability, the regression net
// for the context-submenu clip class (a selector .click() would fire on a clipped, unreachable row).
test("tangent edit flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const nodeCount = () => page.evaluate((): number => (window as any).__kex.nodeCount());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const editing = () => page.evaluate((): boolean => (window as any).__kex.editing());
    const nodeAt = (order: number) =>
        page.evaluate(
            (o: number): { x: number; y: number } | null => (window as any).__kex.nodeAt(o),
            order,
        );
    const tangent = () =>
        page.evaluate(
            (): { mode: number; inX: number; inY: number; outX: number; outY: number } | null =>
                (window as any).__kex.tangent(),
        );
    const handles = () =>
        page.evaluate(
            (): { side: string; x: number; y: number }[] => (window as any).__kex.tangentHandles(),
        );

    // seed the shaped hill, then frame it so the interior node's handles separate at pixel
    // scale (the default ±280 m framing leaves the ~23 m hill a squiggle — `F` fits it; hover
    // defaults to the viewport, so no pre-move is needed to route the key there).
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await expect.poll(nodeCount).toBe(7);
    await page.keyboard.press("f");
    await page.waitForTimeout(SETTLE_MS);

    const canvas = page.locator("#app > canvas");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");

    // ── 1. DOUBLE-CLICK the crest (interior node, order 3) → tangent edit (feel round 12 restored the
    // double-click summon from Alt-click — it's more discoverable). its arc-rule ghost handles draw;
    // the inferred node carries no stored tangent (Auto). ──
    const npos = await nodeAt(3);
    if (!npos) throw new Error("node 3 not located");
    await page.mouse.dblclick(cb.x + npos.x, cb.y + npos.y);
    await expect.poll(editing).toBe(true);
    expect(await tangent()).toBeNull(); // inferred — the default add flow stamps nothing
    await page.waitForTimeout(300); // let the handles settle before the shot
    await page.screenshot({ path: join(OUT, "tangent-1-summon.png") });

    // ── 2. RIGHT-CLICK the node → the NODE context menu (Handles + Tangents ▸) → open the
    // Tangents submenu → set FREE (a corner becomes expressible). ──
    await page.mouse.click(cb.x + npos.x, cb.y + npos.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await page.locator(".nodemenu").getByRole("menuitem", { name: "Tangents", exact: true }).hover();
    await expect(page.locator(".nodemenu").getByRole("menuitem", { name: "Free" })).toBeVisible();
    await page.waitForTimeout(300); // the menu + submenu fade-in, for the shot
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
    expect(
        Math.hypot(dragged.outX - summoned.outX, dragged.outY - summoned.outY),
    ).toBeGreaterThan(0.1);
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
    await page.waitForTimeout(120); // let the per-RAF tick project the readout
    const near = await readoutText();
    await page.mouse.move(cb.x + out2.x + ux * 55, cb.y + out2.y + uy * 55, { steps: 6 });
    await page.waitForTimeout(120);
    const far = await readoutText();
    await page.mouse.up();
    expect(degToken(near)).not.toBeNull(); // the readout is present through the handle drag
    expect(lenToken(near)).not.toBeNull();
    expect(degToken(far)).toBe(degToken(near)); // constant heading along the ray
    expect(lenToken(far)).toBe(lenToken(near)); // constant length = the node's chord, NOT the handle's

    // ── 4. RIGHT-CLICK → Tangents ▸ → Reset → the node clears back to live (Auto inference
    // resumes), so it carries no stored tangent again. available here (a tangent exists to clear). ──
    await page.mouse.click(cb.x + npos.x, cb.y + npos.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await clickFlyout(page, ".nodemenu", "Tangents", "Reset");
    await expect.poll(async () => (await tangent()) === null).toBe(true); // cleared to live

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
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
test("start handle edit flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const editing = () => page.evaluate((): boolean => (window as any).__kex.editing());
    const selectedOrder = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedOrder());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const startAt = () =>
        page.evaluate((): { x: number; y: number } | null => (window as any).__kex.startAt());
    const tangent = () =>
        page.evaluate(
            (): { mode: number; inX: number; inY: number; outX: number; outY: number } | null =>
                (window as any).__kex.tangent(),
        );
    const handles = () =>
        page.evaluate(
            (): { side: string; x: number; y: number }[] => (window as any).__kex.tangentHandles(),
        );

    // the default flat seed bakes on load — no seedHill, so the START diamond at the origin sits
    // clear of shape nodes (node 1 is a full EXTEND_DIST out). frame it so the entry handle
    // separates at pixel scale (hover defaults to the viewport, so `f` routes there).
    await expect.poll(tTotal).toBeGreaterThan(0);
    await page.keyboard.press("f");
    await page.waitForTimeout(SETTLE_MS);

    const canvas = page.locator("#app > canvas");
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
    await page.waitForTimeout(300);
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
    await expect(page.locator(".nodemenu").getByRole("menuitem", { name: "Handles" })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, "start-3-menu.png") });
    await page.locator(".nodemenu").getByRole("menuitem", { name: "Reset" }).click();
    await expect.poll(async () => (await tangent()) === null).toBe(true); // cleared to live

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Screenshot the TIMELINE TOOL RAIL (kex2d-authoring-surface): the thin icon-only strip on the
// dock's left edge that is the snap magnet's home (the Premiere vertical tool-strip precedent, a
// dock affordance — not a viewport overlay, not a second dock). Assert the toggle's lit/dimmed
// state rides `aria-pressed` (positive, not absence-of-error), and capture the default-on and
// toggled-off looks. `S` toggles it globally (the AE magnet key, not hover-gated).
test("tool rail shot", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const rail = page.locator(".tool-rail");
    const snap = rail.locator(".rail-tool");
    await expect(rail).toBeVisible();
    // default-on: the magnet toggle reads pressed and lit.
    await expect(snap).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(300);
    await rail.screenshot({ path: join(OUT, "tool-rail-on.png") });

    // ── S toggles it off (global, the AE magnet key) → aria-pressed flips, the icon dims. ──
    await page.keyboard.press("s");
    await expect(snap).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(150);
    await rail.screenshot({ path: join(OUT, "tool-rail-off.png") });

    // S again restores the default — keep the toggle honest across the flow.
    await page.keyboard.press("s");
    await expect(snap).toHaveAttribute("aria-pressed", "true");

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the FORCE-AUTHORING flow: a geo track →
// convert to force via the real mode toggle (resets to an empty 1g profile) → author
// an airtime bump by force points → convert back to geo (resets to the flat seed) →
// undo, which restores the force track with its points byte-identical. The mode toggle
// and undo run through the real UI; point placement uses the __kex hook for precision.
test("force authoring flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const kind = () => page.evaluate((): number => (window as any).__kex.kind());
    const nodeCount = () => page.evaluate((): number => (window as any).__kex.nodeCount());
    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const forces = () => page.evaluate((): { s: number; g: number }[] => (window as any).__kex.forces());
    const forceEases = () => page.evaluate((): number[] => (window as any).__kex.forceEases());
    const forceTangents = () =>
        page.evaluate((): (null | object)[] => (window as any).__kex.forceTangents());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    // seed a shaped geo track so the convert inherits a real arclength.
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    expect(await kind()).toBe(0); // TrackKind.Geo

    // ── 1. Convert to force via the real section context menu (right-click the clip →
    // "Convert to Force") → stage B seeds two continuation keyframes at the recovered entry
    // force, not an empty profile. this is the FIRST (and only) section, so its entry sample
    // is 0 — no upstream edge — and the seed falls back to DEFAULT_G (1g): assert the seed
    // CONTRACT itself (two keys at (0, F_entry) and (length, F_entry)), not just the count. ──
    await page.locator(".clip").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Convert to Force" }).click();
    await expect.poll(kind).toBe(1); // TrackKind.Force
    await expect.poll(nodeCount).toBe(0);
    await expect.poll(forceCount).toBe(2); // the two seeds (stage B), not an empty profile
    expect(await forces()).toEqual([
        { s: 0, g: 1 }, // (0, F_entry) — F_entry = DEFAULT_G, the track-start fallback
        { s: 24, g: 1 }, // (length, F_entry) — length = DEFAULT_FORCE_LEN (EXTEND_DIST)
    ]);
    await expect.poll(tTotal).toBeGreaterThan(0); // the flat force track baked
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: join(OUT, "force-1-empty.png") });

    // ── 2. Author an airtime bump by force points → the recovered curve reacts. seedForceBump
    // adds 3 points on top of the 2 seeds → 5. ──
    await page.evaluate(() => (window as any).__kex.seedForceBump());
    await expect.poll(forceCount).toBe(5);
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: join(OUT, "force-2-bump.png") });
    const vp = page.viewportSize();
    if (vp) {
        await page.screenshot({
            path: join(OUT, "force-timeline.png"),
            clip: { x: 0, y: vp.height - 340, width: vp.width, height: 340 },
        });
    }

    // ── 2b. Double-click the chart inserts a point ON the authored profile (the
    // envelope-insertion identity): between the leading seed (s=0) and the first bump
    // shoulder (s≈4.8) the profile holds a flat 1g, so the new point's g must be 1 regardless
    // of the cursor's y (which lands well off 1g here). the seeds now flank that gap, so the
    // target x is measured off the force clip's own box (10% in), clear of both keyframes'
    // fat hit-circles, rather than a fixed offset from the dock edge. identify the CREATED
    // point (not just rows[0], which is now always the s=0 seed) by diffing before/after. ──
    const body = page.locator(".dock .body");
    const box = await body.boundingBox();
    const fcb = await page.locator(".clip").first().boundingBox();
    if (!box || !fcb) throw new Error("timeline body / force clip not laid out");
    const before6 = await forces();
    await page.mouse.dblclick(fcb.x + fcb.width * 0.1, box.y + box.height * 0.35);
    await expect.poll(forceCount).toBe(6);
    // the create selects the point, so its popover is up — capture it for the feel pass
    // (let its 120ms fade-in finish, or the shot catches a ghost).
    await page.waitForTimeout(300);
    if (vp) {
        await page.screenshot({
            path: join(OUT, "force-popover.png"),
            clip: { x: 0, y: vp.height - 340, width: vp.width, height: 340 },
        });
    }
    const after6 = await forces();
    const created = after6.find((p) => !before6.some((b) => Math.abs(b.s - p.s) < 1e-6));
    if (!created) throw new Error("the newly inserted point wasn't found by s-diff");
    expect(created.g).toBeCloseTo(1, 5); // resolved on the profile, not at the cursor
    await page.keyboard.press("Control+z");
    await expect.poll(forceCount).toBe(5);

    // ── 2b′. A Ctrl/Cmd drag frees the VALUE but never the per-axis gesture-start magnet (the
    // reframed contract, kex2d-force-ux): held within SNAP_PX horizontally, the crest's s pins
    // back to its exact grab while its g moves continuously off the 0.1 g grid. This is the
    // positive end-to-end proof the axis magnet survives the bypass; snapAxis's bypass-magnet
    // unit test is the oracle. Undo restores the crest for the rest of the flow. ──
    await frameTimeline(page); // frame the section so the .fhit boxes are well-placed
    const beforeCtrl = [...(await forces())].sort((a, b) => a.s - b.s);
    const crestHit = await page.locator(".fhit").nth(2).boundingBox(); // middle by x = interior
    if (!crestHit) throw new Error("crest hit target not laid out");
    const cxC = crestHit.x + crestHit.width / 2;
    const cyC = crestHit.y + crestHit.height / 2;
    await page.mouse.move(cxC, cyC);
    await page.mouse.down();
    await page.keyboard.down("Control"); // bypass held live, read per pointermove
    await page.mouse.move(cxC + 6, cyC - 55, { steps: 8 }); // dx < SNAP_PX (magnet), dy large
    await page.mouse.up();
    await page.keyboard.up("Control");
    const afterCtrl = [...(await forces())].sort((a, b) => a.s - b.s);
    expect(afterCtrl[2].s).toBeCloseTo(beforeCtrl[2].s, 2); // s pinned to its grab despite Ctrl
    expect(Math.abs(afterCtrl[2].g - beforeCtrl[2].g)).toBeGreaterThan(0.1); // g moved freely
    await page.keyboard.press("Control+z"); // restore the crest
    await expect.poll(async () => (await forces()).sort((a, b) => a.s - b.s)[2].g).toBeCloseTo(
        beforeCtrl[2].g,
        5,
    );
    await page.keyboard.press("Escape"); // deselect: clear the crest's .ptip before 2c right-clicks

    // ── 2c. Seeded-keys extension (stage E): set the leading seed's easing via the real,
    // pointer-true keyframe menu, then drag its out-handle to author an explicit tangent
    // (the segment reads Custom), then undo both. exercises the __kex ease/tangent hooks
    // stage C landed against a keyframe that only exists because of stage B's seeding. ──
    await frameTimeline(page); // bring the whole section into view for the diamond DOM boxes
    expect((await forceEases())[0]).toBe(1); // Easing.Cubic — the fresh-seed default
    await page.locator(".fpt").first().click({ button: "right" }); // the leading seed (s=0)
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Quintic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceEases())[0]).toBe(2); // Easing.Quintic

    await page.locator(".fpt").first().dblclick(); // handle-edit sub-mode on the same seed
    await expect.poll(() => page.evaluate((): boolean => (window as any).__kex.forceEditing())).toBe(
        true,
    );
    const seedKnob = await page.locator(".thit").first().boundingBox(); // its one out-handle
    if (!seedKnob) throw new Error("seed handle knob not laid out");
    await page.mouse.move(seedKnob.x + seedKnob.width / 2, seedKnob.y + seedKnob.height / 2);
    await page.mouse.down();
    await page.mouse.move(
        seedKnob.x + seedKnob.width / 2 + 24,
        seedKnob.y + seedKnob.height / 2 - 40,
        { steps: 6 },
    );
    await page.mouse.up();
    await expect.poll(async () => (await forceTangents())[0] !== null).toBe(true);
    expect(await undoDepth()).toBeGreaterThan(0);

    // undo the handle drag, then the easing set — both revert cleanly.
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await forceTangents())[0] === null).toBe(true);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await forceEases())[0]).toBe(1); // back to Cubic

    // ── 2d. Handle-drag gesture-start axis magnet (F1, the geo `latchAngle` mechanism):
    // the seed derives from Cubic, so its out-handle ghost is FLAT (dg=0) → a horizontal
    // grab ray. dragging it far along x with a small vertical wander (|dy| < LATCH_PX = 8)
    // stays latched to the ray, so the authored out-handle keeps dg≈0 — the "keep it flat"
    // affordance. the big diagonal in 2c above left the corridor and freed dg, so this is
    // the positive proof that the magnet fires (red without the latch: dy maps to ~0.08 g). ──
    await page.keyboard.press("Escape"); // exit any lingering handle-edit, then re-enter clean
    await page.locator(".fpt").first().dblclick();
    await expect.poll(() =>
        page.evaluate((): boolean => (window as any).__kex.forceEditing()),
    ).toBe(true);
    const flatKnob = await page.locator(".thit").first().boundingBox();
    if (!flatKnob) throw new Error("seed handle knob not laid out for the magnet drag");
    const fkx = flatKnob.x + flatKnob.width / 2;
    const fky = flatKnob.y + flatKnob.height / 2;
    await page.mouse.move(fkx, fky);
    await page.mouse.down();
    await page.mouse.move(fkx + 40, fky - 5, { steps: 6 }); // dx large, |dy| < LATCH_PX
    await page.mouse.up();
    const magnetTan = (await forceTangents())[0] as { outDs: number; outDg: number } | null;
    if (!magnetTan) throw new Error("magnet drag authored no handle");
    expect(Math.abs(magnetTan.outDg)).toBeLessThan(1e-4); // g pinned flat by the axis magnet
    expect(magnetTan.outDs).toBeGreaterThan(0); // s grew — it moved, not a no-op
    await page.keyboard.press("Control+z"); // revert so the flow resumes from the derived seed
    await expect.poll(async () => (await forceTangents())[0] === null).toBe(true);

    // ── 3. Convert back to geo (context menu again) → destructive reset to the flat
    // two-node seed. ──
    await page.locator(".clip").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Convert to Geo" }).click();
    await expect.poll(kind).toBe(0);
    await expect.poll(nodeCount).toBe(2); // the flat seed
    expect(await forceCount()).toBe(0);
    await page.screenshot({ path: join(OUT, "force-3-geo.png") });

    // ── 4. Undo the convert → the force track + its points restored byte-identical (the
    // two seeds + the three bump points — the easing/handle edits above were already undone,
    // so this is exactly the pre-convert-to-geo state). ──
    await page.keyboard.press("Control+z");
    await expect.poll(kind).toBe(1);
    await expect.poll(forceCount).toBe(5);

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the FORCE EASING MENU + HANDLE-EDIT flow (kex2d-force-ux stage C, extended at stage
// E): seed a force section with keyframes → RIGHT-CLICK a diamond for the keyframe menu →
// open the Easing ▸ submenu and set Linear POINTER-TRUE (clickFlyout — the regression net for
// the context-submenu clip class) → assert the leading keyframe's tag flipped → RIGHT-CLICK
// the CURVE SPAN between two keyframes (not a diamond) → the same leading-keyframe menu (the
// segment-span hit-target, a C-review coverage hole) → DOUBLE-CLICK a diamond to summon its
// handles (the diamond hit beats insertion) → drag a handle to author an explicit tangent (the
// segment reads Custom) → reopen the menu and assert the Custom row reads checked (another
// C-review hole) → Reset via the menu, pointer-true (`clickMenuItem`), clears it back to the
// derived easing → Delete, also pointer-true, removes the keyframe. Every menu interaction is
// a real pointer event; __kex is read only for assertions.
test("force easing menu flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const forceEases = () => page.evaluate((): number[] => (window as any).__kex.forceEases());
    const forceEditing = () => page.evaluate((): boolean => (window as any).__kex.forceEditing());
    const forceHandleSel = () =>
        page.evaluate((): string | null => (window as any).__kex.forceHandleSel());
    const forceTangents = () =>
        page.evaluate(
            (): (null | { outDs: number; outDg: number })[] =>
                (window as any).__kex.forceTangents(),
        );

    // seed a force section with an airtime bump (the two continuation seed keyframes stage B
    // stamps on convert, plus three bump points) → a chain with interior keyframes to edit.
    await page.evaluate(() => (window as any).__kex.seedForceBump());
    await expect.poll(forceCount).toBeGreaterThanOrEqual(3);
    const nPts = await forceCount();
    await frameTimeline(page); // bring the whole force section into view for the diamond DOM boxes
    await expect(page.locator(".fpt")).toHaveCount(nPts);

    // ── 1. Right-click the leading (first) keyframe → the force keyframe menu, in row order
    // Delete · Easing ▸ (the Handles + Reset rows are gone — both subsumed into the Easing list:
    // Custom steps in, a preset steps back out). ──
    await page.locator(".fpt").first().click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await expect
        .poll(async () =>
            (await page.locator(".fmenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Delete Del", "Easing ▸"]);
    await page.waitForTimeout(200);
    if (page.viewportSize())
        await page.screenshot({
            path: join(OUT, "force-easing-menu.png"),
            clip: { x: 0, y: (page.viewportSize()?.height ?? 0) - 340, width: page.viewportSize()?.width ?? 0, height: 340 },
        });

    // ── 2. Open Easing ▸ and set Linear — pointer-true through clickFlyout (a coordinate
    // click gated on elementFromPoint reachability, the context-submenu clip regression net).
    // the leading keyframe's tag flips to Linear (0); Cubic (default) is 1. ──
    expect((await forceEases())[0]).toBe(1); // Easing.Cubic default
    await clickFlyout(page, ".fmenu", "Easing", "Linear");
    await expect(page.locator(".fmenu")).toHaveCount(0); // picking a row closes the menu
    await expect.poll(async () => (await forceEases())[0]).toBe(0); // Easing.Linear

    // ── 2b. Right-click the CURVE SPAN between keyframe 0 (s=0) and keyframe 1 (the first
    // bump shoulder, s = 0.2·length) — a chart point, not a diamond — → the same LEADING
    // keyframe's menu (the Blender convention: a segment addresses the keyframe before it).
    // Setting Quintic through it is a value change, so it proves the addressing. `openForceMenu`
    // also SELECTS its target (keyframe 0, from step 1), so its `.ptip` popover is still floating
    // over the chart near it — Escape deselects and closes the popover first, or it eats the click. ──
    await page.keyboard.press("Escape");
    await expect(page.locator(".ptip")).toHaveCount(0);
    const fcb = await page.locator(".clip").first().boundingBox();
    const kf0 = await page.locator(".fpt").nth(0).boundingBox(); // s=0 seed (~1g)
    const kf1 = await page.locator(".fpt").nth(1).boundingBox(); // first bump shoulder (1g)
    if (!fcb || !kf0 || !kf1) throw new Error("force clip / keyframes not laid out");
    // the segment hit-target is gated to the drawn curve (chartCtx's FHIT_R vertical tolerance),
    // so the click must land ON the span. x ≈ 0.1·length sits halfway between kf0 (s=0) and
    // kf1 (s=0.2·length); the near-flat ~1g span there tracks the two flanking diamonds, so the
    // mean of their centre-y lands on the curve.
    const midX = fcb.x + fcb.width * 0.1;
    const midY = (kf0.y + kf0.height / 2 + (kf1.y + kf1.height / 2)) / 2;
    await page.mouse.click(midX, midY, { button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Quintic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceEases())[0]).toBe(2); // Easing.Quintic — keyframe 0 moved, not keyframe 1
    expect((await forceEases())[1]).toBe(1); // keyframe 1's own tag (Cubic, untouched) proves it

    // ── 2c. A right-click in EMPTY chart space (over the force section horizontally but ~1g
    // from the curve vertically) opens NO keyframe menu — the segment hit-target is the drawn
    // curve, not the whole force-section column. ──
    const crest = await page.locator(".fpt").nth(2).boundingBox(); // airtime crest (0g)
    if (!crest) throw new Error("crest keyframe not laid out");
    await page.mouse.click(midX, crest.y + crest.height / 2, { button: "right" });
    await page.waitForTimeout(50);
    await expect(page.locator(".fmenu")).toHaveCount(0);
    expect((await forceEases())[0]).toBe(2); // unchanged — the empty-space click was inert

    // ── 3. Double-click an interior keyframe → handle-edit sub-mode summons its two handles
    // (the direct gesture into handle edit; a diamond hit beats the chart's insertion double-
    // click, and it does NOT insert a point). ──
    await page.locator(".fpt").nth(1).dblclick();
    await expect.poll(forceEditing).toBe(true);
    await expect(page.locator(".thit")).toHaveCount(2); // in + out handles (an interior keyframe)
    await expect.poll(forceCount).toBe(nPts); // the double-click summoned, it did NOT insert

    // ── 3b. Dead-zone: a CLICK on a handle knob with a sub-threshold jitter (2-3 px, under
    // DRAG_PX) selects the handle but writes NO tangent and records NO history — it must not
    // materialize a ghost to explicit on a jittery click (the F2 review finding: the write was
    // gated only on the release verdict, not the dead zone). the IN handle (reaches backward,
    // away from step 4's out-drag). ──
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const beforeJitter = await undoDepth();
    const inKnob = await page.locator(".thit").first().boundingBox();
    if (!inKnob) throw new Error("in-handle knob not laid out");
    await page.mouse.move(inKnob.x + inKnob.width / 2, inKnob.y + inKnob.height / 2);
    await page.mouse.down();
    await page.mouse.move(inKnob.x + inKnob.width / 2 + 2, inKnob.y + inKnob.height / 2 - 2, { steps: 2 });
    await page.mouse.up();
    await expect.poll(forceHandleSel).toBe("in"); // the jittery click SELECTED the handle
    expect((await forceTangents())[1]).toBeNull(); // …but wrote NO explicit tangent
    expect(await undoDepth()).toBe(beforeJitter); // …and recorded NO history entry
    await page.keyboard.press("Escape"); // peel: deselect the handle, stay in handle edit
    await expect.poll(forceHandleSel).toBeNull();

    // ── 4. Drag the OUT handle → the keyframe's OUT side gains an explicit tangent, so its
    // FOLLOWING segment (the one its menu addresses) reads Custom. a real canvas pointer drag,
    // located by the .thit grab circle. the out handle reaches into the larger next span, clear
    // of the diamond. ──
    const knob = await page.locator(".thit").last().boundingBox();
    if (!knob) throw new Error("handle knob not laid out");
    await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
    await page.mouse.down();
    await page.mouse.move(knob.x + knob.width / 2 + 24, knob.y + knob.height / 2 - 40, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await forceTangents())[1] !== null).toBe(true);

    // (a) the DRAG selected the dragged side (the Blender rule — any interaction addresses the
    // handle). On pre-F3 code a drag left selection untouched, so this is the red-first pin.
    await expect.poll(forceHandleSel).toBe("out");
    // (b) the offset grid snapped Δg to a 0.1-g multiple (a real, nonzero offset). Remove the
    // grid quantize and the ~40-px drag's continuous Δg is essentially never a 0.1 multiple → red.
    const outDgSnap = (await forceTangents())[1]?.outDg ?? 0;
    expect(Math.abs(outDgSnap)).toBeGreaterThan(0.05);
    expect(Math.abs(outDgSnap * 10 - Math.round(outDgSnap * 10))).toBeLessThan(1e-6);
    // (b2) Δs, by contrast, is CONTINUOUS (F3d): a handle's horizontal offset is curvature
    // shaping, not a placement on the arclength, so it is NOT grid-quantized. The ~24-px drag's
    // Δs lands off the 1-m grid; re-enable the Δs quantize and it snaps to an integer → red.
    const outDsCont = (await forceTangents())[1]?.outDs ?? 0;
    expect(Math.abs(outDsCont)).toBeGreaterThan(0.05); // a real, nonzero reach
    expect(Math.abs(outDsCont - Math.round(outDsCont))).toBeGreaterThan(1e-3); // off the 1-m grid
    // …and the readout swapped to the handle, printing that snapped value in vocabulary form
    // (trailing zeros trimmed) — the popover shows the handle's own (Δs, Δg), not the keyframe's.
    const hgReadout = page.locator('.ptip input[aria-label="Handle g offset (g)"]');
    await expect(hgReadout).toBeVisible();
    expect(Number(await hgReadout.inputValue())).toBeCloseTo(outDgSnap, 6);
    // (d) the popover re-anchored at the SELECTED KNOB (attention lives where the drag just
    // ended). Its above/below-vs-dodge placement is pinned in the dedicated 4d scenarios below,
    // on the crest — two constructed cases where the vertical fit is deterministic.

    await page.waitForTimeout(200);
    if (page.viewportSize())
        await page.screenshot({
            path: join(OUT, "force-handle-edit.png"),
            clip: { x: 0, y: (page.viewportSize()?.height ?? 0) - 340, width: page.viewportSize()?.width ?? 0, height: 340 },
        });

    // ── 4c. The handle (Δs, Δg) fields carry the slider/scrub affordance, the same drag-to-slide
    // as the keyframe d/F fields. Grab the Δg key label and slide it right: the OUT tangent's Δg
    // revises through the shared write path (composeTangent), one undo entry. On the old type-only
    // fields (no onpointerdown handler) the drag over the label writes nothing → outDg unchanged →
    // red. ──
    const dgKey = page
        .locator(".ptip .fld")
        .filter({ has: page.locator('input[aria-label="Handle g offset (g)"]') })
        .locator(".key");
    const dgKeyBox = await dgKey.boundingBox();
    if (!dgKeyBox) throw new Error("Δg scrub handle not laid out");
    const beforeScrubDg = (await forceTangents())[1]?.outDg ?? 0;
    const beforeScrubUndo = await undoDepth();
    await page.mouse.move(dgKeyBox.x + dgKeyBox.width / 2, dgKeyBox.y + dgKeyBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dgKeyBox.x + dgKeyBox.width / 2 + 40, dgKeyBox.y + dgKeyBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await forceTangents())[1]?.outDg ?? 0).not.toBe(beforeScrubDg);
    expect(await undoDepth()).toBe(beforeScrubUndo + 1); // the whole scrub → one entry

    // ── 4b. Ctrl/Cmd frees the Δg grid (Δs is already continuous by default, F3d — the modifier's
    // remaining job is the Δg quantum). Reset step 4's handle to derived, re-enter, and drag the OUT
    // knob with the modifier held to an off-round pixel target: the bypass keeps Δg continuous, so it
    // lands off the 0.1-g grid (a continuous real hits the grid with vanishing probability); a broken
    // bypass snaps Δg → the assert goes red. Fresh-from-flat so the grab-ray latch releases on the
    // large move. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await clickFlyout(page, ".fmenu", "Easing", "Cubic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceTangents())[1] === null).toBe(true);
    await page.locator(".fpt").nth(1).dblclick();
    await expect.poll(forceEditing).toBe(true);
    const gk = await page.locator(".thit").last().boundingBox();
    if (!gk) throw new Error("out handle knob not laid out for the bypass drag");
    await page.mouse.move(gk.x + gk.width / 2, gk.y + gk.height / 2);
    await page.mouse.down({ button: "left" });
    await page.keyboard.down("Control");
    await page.mouse.move(gk.x + gk.width / 2 + 13, gk.y + gk.height / 2 - 37, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect.poll(async () => (await forceTangents())[1] !== null).toBe(true);
    const free = (await forceTangents())[1];
    expect(Math.abs(free?.outDg ?? 0)).toBeGreaterThan(0.05); // a real, nonzero vertical reach
    const dgOnGrid = Math.abs((free?.outDg ?? 0) * 10 - Math.round((free?.outDg ?? 0) * 10)) < 1e-6; // G_GRID = 0.1 g
    expect(dgOnGrid).toBe(false); // the bypass freed Δg off its 0.1-g grid

    // ── 4d. Handle popover placement (F3c): vertical-primary, matching the keyframe popover's
    // above/below reading. The box sits above/below the knob, horizontally centred on it, on the
    // side AWAY from the diamond; only an edge that would flip it back over the workspace dodges it
    // horizontally outward (the collision fallback, never the default). Two constructed cases on the
    // CREST (nth 2, an interior keyframe near the chart BOTTOM): an up-handle with room = the
    // default above; a down-handle pinned to the bottom edge = the dodge. ──
    await page.keyboard.press("Escape"); // leave keyframe 1's handle edit clean before the crest
    await page.keyboard.press("Escape");
    const body = await page.locator(".dock .body").boundingBox();
    if (!body) throw new Error("timeline body not laid out");
    const CHART_TOP = 46; // RULER_H (26) + GAP_H (20) — Timeline.svelte
    const CHART_BOT_PAD = 8; // BOT_PAD
    const TIP_REACH = 68; // TIP_H (56) + TIP_GAP (12) — the vertical room the box needs to fit
    const chartTopY = body.y + CHART_TOP;
    const chartBotY = body.y + body.height - CHART_BOT_PAD;

    await page.locator(".fpt").nth(2).dblclick(); // enter handle edit on the crest
    await expect.poll(forceEditing).toBe(true);
    await expect(page.locator(".thit")).toHaveCount(2);
    const crestDia = await page.locator(".fpt").nth(2).locator(".fhit").boundingBox();
    if (!crestDia) throw new Error("crest diamond not laid out");
    const crestX = crestDia.x + crestDia.width / 2;
    const crestY = crestDia.y + crestDia.height / 2;

    // (i) DEFAULT above: drag the OUT knob straight UP to the midpoint between the top fit-line and
    // the crest — the box has clear room above, so it reads like the keyframe popover: above the
    // knob, centred, on the side away from the (below) diamond. NOT dodged to a side.
    const upY = (chartTopY + TIP_REACH + crestY) / 2;
    const uk = await page.locator(".thit").last().boundingBox();
    if (!uk) throw new Error("crest out knob not laid out for the up drag");
    await page.mouse.move(uk.x + uk.width / 2, uk.y + uk.height / 2);
    await page.mouse.down();
    await page.mouse.move(crestX + 2, upY, { steps: 8 }); // straight up (the grab-ray latch keeps s≈0)
    await page.mouse.up();
    await expect.poll(async () => ((await forceTangents())[2]?.outDg ?? 0) > 0.05).toBe(true); // points UP
    {
        const tipBox = await page.locator(".ptip").boundingBox();
        const knobBox = await page.locator(".thit").last().boundingBox();
        const inKnob = await page.locator(".thit").first().boundingBox();
        const dia = await page.locator(".fpt").nth(2).locator(".fhit").boundingBox();
        if (!tipBox || !knobBox || !inKnob || !dia)
            throw new Error("default-placement boxes not laid out");
        const knobCx = knobBox.x + knobBox.width / 2;
        const knobCy = knobBox.y + knobBox.height / 2;
        expect(dia.y + dia.height / 2).toBeGreaterThan(knobCy); // handle up → the diamond is BELOW the knob
        expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(knobCy + 1); // …so the box is ABOVE the knob
        expect(knobCx).toBeGreaterThanOrEqual(tipBox.x); // horizontally centred on the knob (not dodged)
        expect(knobCx).toBeLessThanOrEqual(tipBox.x + tipBox.width);
        expect(overlaps(tipBox, knobBox)).toBe(false); // clears every workspace element it hangs off
        expect(overlaps(tipBox, inKnob)).toBe(false);
        expect(overlaps(tipBox, dia)).toBe(false);
    }

    // (ii) DODGE (the F3b refutation, now pinned): drag the OUT knob DOWN past the chart bottom so
    // it clamps to the edge, just below the near-bottom crest diamond. The preferred vertical side
    // (below, away from the diamond) no longer fits, and flipping back ABOVE would land the box over
    // the diamond — so it dodges horizontally OUTWARD (out → right) instead. Red-first: a naive
    // always-vertical placement flips above and OVERLAPS the crest diamond, so the no-overlap assert
    // goes red without the dodge (verified against a no-dodge mutation on the bridge).
    const dk = await page.locator(".thit").last().boundingBox();
    if (!dk) throw new Error("crest out knob not laid out for the dodge");
    await page.mouse.move(dk.x + dk.width / 2, dk.y + dk.height / 2);
    await page.mouse.down();
    await page.mouse.move(crestX + 14, chartBotY + 60, { steps: 8 }); // past the bottom → clamps to the edge
    await page.mouse.up();
    await expect.poll(async () => ((await forceTangents())[2]?.outDg ?? 0) < -0.05).toBe(true); // points DOWN
    {
        const tipBox = await page.locator(".ptip").boundingBox();
        const knobBox = await page.locator(".thit").last().boundingBox();
        const inKnob = await page.locator(".thit").first().boundingBox();
        const dia = await page.locator(".fpt").nth(2).locator(".fhit").boundingBox();
        if (!tipBox || !knobBox || !inKnob || !dia)
            throw new Error("dodge-placement boxes not laid out");
        const knobCy = knobBox.y + knobBox.height / 2;
        expect(tipBox.x).toBeGreaterThan(knobBox.x + knobBox.width); // dodged to the OUTWARD side (right)
        expect(tipBox.x - (knobBox.x + knobBox.width)).toBeLessThan(24); // …adjacent, not floating away
        // the box rides at the knob's vertical level (a side dodge, not above/below) — the in-view
        // clamp may push it up to a half-height when the knob is pinned to the very chart edge.
        expect(Math.abs(knobCy - (tipBox.y + tipBox.height / 2))).toBeLessThanOrEqual(32);
        // the load-bearing pin (the F3b scenario): the dodge clears the diamond fat-pick box and the
        // arm's knobs. A naive vertical flip would land over the diamond just above → this goes red.
        expect(overlaps(tipBox, dia)).toBe(false);
        expect(overlaps(tipBox, knobBox)).toBe(false);
        expect(overlaps(tipBox, inKnob)).toBe(false);
    }

    await page.keyboard.press("Escape"); // deselect the handle
    await page.keyboard.press("Escape"); // exit crest handle edit → clean for step 5
    await expect.poll(forceEditing).toBe(false);

    // ── 5. Reopen the menu on the now-Custom keyframe → its Easing ▸ submenu's Custom row reads
    // checked (derived provenance — the segment is bounded by an explicit handle). ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await page.locator(".fmenu").getByRole("menuitem", { name: "Easing", exact: true }).hover();
    const customRow = page.locator(".fmenu").getByRole("menuitem", { name: "Custom", exact: true });
    await expect(customRow).toBeVisible();
    await expect(customRow).toHaveClass(/checked/);

    // ── 6. Pick a PRESET row (Cubic) through the menu → it clears the explicit handles back to
    // the derived preset (what Reset did, now folded into choosing a named row — the way back up
    // the layers is the list). pointer-true through clickFlyout. ──
    await clickFlyout(page, ".fmenu", "Easing", "Cubic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceTangents())[1] === null).toBe(true); // handles cleared

    // ── 7. Pick CUSTOM through the menu → it materializes explicit handles from the current
    // derived ones (no drag) and steps into handle edit. the segment reads Custom again, from
    // the list this time. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Custom");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(forceEditing).toBe(true); // Custom entered handle edit
    await expect.poll(async () => (await forceTangents())[1] !== null).toBe(true); // handles materialized
    await expect(page.locator(".thit")).toHaveCount(2);

    // ── 8. Select a handle (click its knob) → the contextual readout swaps from the keyframe
    // to the handle, and its typed (Δs, Δg) fields appear. type a Δg → the tangent write path
    // applies it (history-bracketed); undo restores. the OUT handle (reaches into the larger
    // next span) is well clear of the diamond. ──
    await page.locator(".thit").last().click(); // no-move click selects, does not drag
    await expect.poll(forceHandleSel).toBe("out");
    const dgField = page.locator('.ptip input[aria-label="Handle g offset (g)"]');
    await expect(dgField).toBeVisible(); // the readout swapped to the handle
    await dgField.fill("0.6");
    await dgField.press("Enter"); // Enter blurs → onchange commits through the tangent path
    await expect.poll(async () => (await forceTangents())[1]?.outDg ?? 0).toBeCloseTo(0.6, 2);
    await page.keyboard.press("Control+z"); // undo the typed entry
    await expect.poll(async () => Math.abs((await forceTangents())[1]?.outDg ?? 1)).toBeLessThan(0.01);

    // ── 9. The TERMINAL keyframe (the last one, governing no following segment) drops the
    // Easing ▸ entry entirely — its menu is Delete alone (there is no transition to ease). ──
    await page.locator(".fpt").last().click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await expect
        .poll(async () =>
            (await page.locator(".fmenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Delete Del"]); // no Easing ▸ on the terminal keyframe
    await page.keyboard.press("Escape"); // close the menu
    await expect(page.locator(".fmenu")).toHaveCount(0);

    // ── 10. Delete, pointer-true, removes an interior keyframe. ──
    await page.keyboard.press("Escape"); // deselect the terminal keyframe
    const beforeDelete = await forceCount();
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickMenuItem(page, ".fmenu", "Delete");
    await expect.poll(forceCount).toBe(beforeDelete - 1);

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
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
test("context menu stays in the viewport near the bottom edge", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    // seed a force section with an airtime bump → keyframes spanning the g-range, so the 0g crest
    // sits LOW in the chart (near the viewport bottom, where its menu would overflow).
    await page.evaluate(() => (window as any).__kex.seedForceBump());
    await expect.poll(forceCount).toBeGreaterThanOrEqual(3);
    await expect.poll(tTotal).toBeGreaterThan(0);
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

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Handle drags must behave like keyframe/node drags at the view edges, through the SAME mechanisms:
// (1) a handle HELD past the chart edge EDGE-PANS the value axis (the shared growValueAxis path,
// factored from the keyframe drag), and (2) on RELEASE the range ACCOMMODATES the handle endpoint so
// a knob never sits outside the visible range (yTarget's content extent, extended to explicit handle
// endpoints — the same accommodate keyframes get through the curve scan). The gRange hook reads the
// displayed g-range (yView); a real canvas pointer drives the drag past the edge. Each half carries
// its own mutation: unwire the handle branch → no pan; drop the handle-endpoint inclusion → no fit.
test("handle drag edge-pans the value axis and a released handle stays in range", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const forceEditing = () => page.evaluate((): boolean => (window as any).__kex.forceEditing());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const forces = () =>
        page.evaluate((): { s: number; g: number }[] => (window as any).__kex.forces());
    const forceTangents = () =>
        page.evaluate((): (null | { outDg: number })[] => (window as any).__kex.forceTangents());
    const gRange = () => page.evaluate((): [number, number] => (window as any).__kex.gRange());

    // seed a force bump → an interior shoulder keyframe (nth 1) whose OUT handle has room downward.
    await page.evaluate(() => (window as any).__kex.seedForceBump());
    await expect.poll(forceCount).toBeGreaterThanOrEqual(3);
    await expect.poll(tTotal).toBeGreaterThan(0);
    await frameTimeline(page);

    const body = await page.locator(".dock .body").boundingBox();
    if (!body) throw new Error("timeline body not laid out");
    const chartBotY = body.y + body.height - 8; // BOT_PAD (Timeline.svelte)

    await page.locator(".fpt").nth(1).dblclick(); // enter handle edit → its two handles summon
    await expect.poll(forceEditing).toBe(true);
    await expect(page.locator(".thit")).toHaveCount(2);

    // ── 1. Edge-pan: grab the OUT knob, drag it straight DOWN well past the chart bottom, and HOLD.
    // The shared edge-grow fires per frame while the cursor is held beyond the edge, so the displayed
    // range's floor keeps dropping (the held handle rides the growing axis). Mutation: revert the
    // handle branch in the yView effect to `return` (unwire the path) → the axis holds → the floor
    // never drops → this times out red. ──
    const [lo0] = await gRange();
    const knob = await page.locator(".thit").last().boundingBox();
    if (!knob) throw new Error("out handle knob not laid out");
    const knobX = knob.x + knob.width / 2;
    await page.mouse.move(knobX, knob.y + knob.height / 2);
    await page.mouse.down();
    await page.mouse.move(knobX, chartBotY + 140, { steps: 8 }); // straight down, past the bottom, HELD
    await expect.poll(async () => (await gRange())[0]).toBeLessThan(lo0 - 1.0); // the view panned down
    await page.mouse.up();
    await expect.poll(async () => (await forceTangents())[1] !== null).toBe(true);

    // ── 2. Release accommodate: the OUT handle now overshoots far below the drawn curve (its knob
    // sat at the panned floor). The range must include its ENDPOINT (keyframe g + Δg) — yFit pads
    // FIT_PAD (0.4 g) past the content extent, so the settled floor lands strictly BELOW the
    // endpoint. Mutation: drop the handle-endpoint inclusion in yTarget → the view fits the curve
    // only (its dip sits well above the overshoot knob), so the floor never reaches the endpoint and
    // instead lazily contracts back up → this times out red. ──
    const g1 = (await forces())[1].g;
    const endpointG = g1 + ((await forceTangents())[1]?.outDg ?? 0);
    await expect.poll(async () => (await gRange())[0]).toBeLessThan(endpointG - 0.2);

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the MULTI-SECTION chain shape: a geo track → append a section → convert it to
// force (a mixed geo→force chain) → delete the force tail → undo. The ops run through the
// __kex hooks; sectionCount / sectionKinds assert the chain shape. (Split/join left the
// editor — deferred to the conversion tier — so they're no longer exercised here; the
// substrate ops stay covered by the unit suite.)
test("multi-section flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    expect(await sectionCount()).toBe(1);

    // ── 1. Append a geo section, then convert it to force → a mixed geo→force chain. ──
    await page.evaluate(() => (window as any).__kex.append(0)); // SectionKind.Geo
    await expect.poll(sectionCount).toBe(2);
    await page.evaluate(() => (window as any).__kex.convertAt(1));
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1"); // geo, force
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: join(OUT, "sections-mixed.png") });

    // ── 2. Delete the force tail → 1 (downstream rebases); undo restores it. ──
    await page.evaluate(() => (window as any).__kex.deleteAt(1));
    await expect.poll(sectionCount).toBe(1);
    await page.keyboard.press("Control+z");
    await expect.poll(sectionCount).toBe(2);

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the CLIP STRIP flow (section-editor spec stage 1): the section lane in the
// dock's marker band. seed one geo section → append a force section via the real `+`
// flyout → select the geo clip → drag the force clip's right-edge extent trim → undo.
// Every affordance is driven through the real DOM (clip rect, flyout, trim handle); the
// __kex hook is read only for assertions, never to perform the op.
test("section clip strip flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const sectionIds = () => page.evaluate((): number[] => (window as any).__kex.sectionIds());
    const sectionLengths = () =>
        page.evaluate((): number[] => (window as any).__kex.sectionLengths());
    const selectedSection = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedSection());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    const vp = page.viewportSize();
    const strip = () =>
        vp ? { x: 0, y: vp.height - 340, width: vp.width, height: 340 } : undefined;

    // seed one geo section → one geo clip in the lane.
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await expect(page.locator(".clip")).toHaveCount(1);
    await page.waitForTimeout(SETTLE_MS);
    if (vp) await page.screenshot({ path: join(OUT, "clip-1-strip.png"), clip: strip() });

    // ── 1. Append a force section via the real + flyout → a mixed geo→force chain. ──
    await page.locator(".clip-add").click();
    await page.getByRole("menuitem", { name: "Append force section" }).click();
    await expect.poll(sectionCount).toBe(2);
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1"); // geo, force
    // the append selects the new (force) section — its clip reads selected.
    await expect.poll(selectedSection).toBe((await sectionIds())[1]);
    await frameTimeline(page); // append never pans; frame the grown chain into view
    await expect(page.locator(".clip")).toHaveCount(2);
    await page.waitForTimeout(300);
    if (vp) await page.screenshot({ path: join(OUT, "clip-2-append.png"), clip: strip() });

    // ── 2. Click the geo clip → editor.section becomes the first section (one object,
    // two surfaces: the same selection the viewport span drives). ──
    const ids = await sectionIds();
    await page.locator(".clip").nth(0).click();
    await expect.poll(selectedSection).toBe(ids[0]);

    // ── 3. Drag the force clip's right-edge trim handle → the section lengthens (one
    // history entry). the force clip is the only one with a trim handle. ──
    const before = await sectionLengths();
    const trim = page.locator(".clip-trim");
    await expect(trim).toHaveCount(1);
    const tb = await trim.boundingBox();
    if (!tb) throw new Error("trim handle not laid out");
    const cy = tb.y + tb.height / 2;
    await trim.hover(); // move to the handle center with actionability, then drag right
    // hold Ctrl to bypass the snapping magnet (default-on, kex2d-ux-foundations stage E) —
    // this flow tests the extent trim itself, not snapping, so the drag lands where the
    // cursor does, deterministically. the snap resolver is unit-covered in timeline.test.ts.
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2 + 50, cy, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect.poll(async () => (await sectionLengths())[1]).toBeGreaterThan(before[1]);
    if (vp) await page.screenshot({ path: join(OUT, "clip-3-trim.png"), clip: strip() });

    // undo restores the pre-drag extent, one entry.
    await page.keyboard.press("Control+z");
    await expect
        .poll(async () => (await sectionLengths())[1])
        .toBeCloseTo(before[1], 3);

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the SECTION MENU + DIRECT-BY-POSITION flow (section-editor stage 2): a mixed
// geo→force chain → prove empty-chart click deselects → add a force keyframe by cursor
// position WITHOUT selecting the section → right-click Convert and Delete via the real
// context menu. The whole point is that authoring and section ops no longer depend on a
// "current section" selection. Everything is driven through the real DOM.
test("section menu + keyframe flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const sectionIds = () => page.evaluate((): number[] => (window as any).__kex.sectionIds());
    const forceCounts = () =>
        page.evaluate((): number[] => (window as any).__kex.sectionForceCounts());
    const selectedSection = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedSection());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const vp = page.viewportSize();
    const strip = () =>
        vp ? { x: 0, y: vp.height - 340, width: vp.width, height: 340 } : undefined;

    // seed a geo section, append a force one via the real + flyout → a mixed chain.
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await page.locator(".clip-add").click();
    await page.getByRole("menuitem", { name: "Append force section" }).click();
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1");
    await frameTimeline(page); // append never pans; frame the grown chain into view

    const body = page.locator(".dock .body");
    const bb = await body.boundingBox();
    if (!bb) throw new Error("timeline body not laid out");

    // ── 1. Empty-chart click deselects the section (the stage-1 feel finding). ──
    const ids = await sectionIds();
    await page.locator(".clip").nth(0).click(); // select the geo clip
    await expect.poll(selectedSection).toBe(ids[0]);
    await page.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height * 0.62); // empty chart body
    await expect.poll(selectedSection).toBe(null);

    // ── 2. Add a force keyframe BY POSITION over the force section, with nothing
    // selected — double-click the chart directly below the force clip's center. ──
    const before = await forceCounts(); // [n_geo(0), 0]
    const fcb = await page.locator(".clip").nth(1).boundingBox(); // the force clip
    if (!fcb) throw new Error("force clip not laid out");
    await page.mouse.dblclick(fcb.x + fcb.width / 2, bb.y + bb.height * 0.5);
    await expect.poll(async () => (await forceCounts())[1]).toBeGreaterThan(before[1]);
    await page.waitForTimeout(300);
    if (vp) await page.screenshot({ path: join(OUT, "section-2-keyframe.png"), clip: strip() });

    // ── 3. Right-click the force clip → "Convert to Geo" (real context menu). ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    if (vp) await page.screenshot({ path: join(OUT, "section-3-menu.png"), clip: strip() });
    await page.getByRole("menuitem", { name: "Convert to Geo" }).click();
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,0");
    await page.keyboard.press("Control+z"); // convert is one undo entry
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1");

    // ── 4. Right-click a clip → Delete (real context menu). ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(sectionCount).toBe(1);

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the CONTENT-ANCHORED PLAYHEAD PARKING flow (section-editor stage 3, fork 4): a
// mixed geo→force chain with a force keyframe → park the playhead over the force section
// via a REAL ruler scrub → drag the keyframe's g so the bake re-times → assert the parked
// playhead's arclength held (glued to the track feature) while the ride re-timed. Without
// content-anchoring the playhead is pinned to ride-time and would slide under the re-time.
test("playhead parking flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const forceCounts = () =>
        page.evaluate((): number[] => (window as any).__kex.sectionForceCounts());
    const cartArc = () => page.evaluate((): number | null => (window as any).__kex.cartArc());
    const parked = () => page.evaluate((): boolean => (window as any).__kex.parked());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const vp = page.viewportSize();
    const strip = () =>
        vp ? { x: 0, y: vp.height - 340, width: vp.width, height: 340 } : undefined;

    // seed a geo section, append a force one via the real + flyout → a mixed chain.
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await page.locator(".clip-add").click();
    await page.getByRole("menuitem", { name: "Append force section" }).click();
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1");
    await frameTimeline(page); // append never pans; frame the grown chain into view

    const body = page.locator(".dock .body");
    const bb = await body.boundingBox();
    if (!bb) throw new Error("timeline body not laid out");

    // ── 1. Author a keyframe by double-clicking the chart over the force section — the
    // handle the later re-time will drag. appendSection already seeded two continuation
    // keyframes (stage B) at the section's entry/exit; this adds a third, interior one. ──
    const fcb = await page.locator(".clip").nth(1).boundingBox(); // the force clip
    if (!fcb) throw new Error("force clip not laid out");
    await expect.poll(async () => (await forceCounts())[1]).toBe(2); // the two seeds
    await page.mouse.dblclick(fcb.x + fcb.width / 2, bb.y + bb.height * 0.5);
    await expect.poll(async () => (await forceCounts())[1]).toBe(3); // + the authored keyframe

    // ── 2. Park the playhead over the force section via a real RULER scrub — a click in
    // the ruler band (above the clip lane) at the force section's x. it parks (held) at
    // that content anchor and stops the cart. ──
    await page.mouse.click(fcb.x + fcb.width / 2, bb.y + 13); // ruler band y (< RULER_H)
    await expect.poll(parked).toBe(true);
    const arc1 = await cartArc();
    const tt1 = await tTotal();
    if (arc1 === null) throw new Error("cartArc null after park");
    if (vp) await page.screenshot({ path: join(OUT, "park-1-anchored.png"), clip: strip() });

    // ── 3. Drag the keyframe's g (vertical drag on its fat hit circle) → the force
    // profile changes, the bake re-times (tTotal shifts). three points now exist (the two
    // seeds + the authored one); grab the AUTHORED one — the middle by s (and so by x), sorted
    // between the entry seed (s=0) and the exit seed (s=length). ──
    const fhit = page.locator(".fhit");
    await expect(fhit).toHaveCount(3);
    const hb = await fhit.nth(1).boundingBox();
    if (!hb) throw new Error("force point hit target not laid out");
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 60, { steps: 10 });
    await page.mouse.up();

    // the ride re-timed (the bake's total time changed)…
    await expect.poll(async () => Math.abs((await tTotal()) - tt1) > 1e-3).toBe(true);
    // …but the parked playhead stayed glued to the same track arclength (the fix — a
    // ride-time-pinned playhead would have slid when the timing changed).
    const arc2 = await cartArc();
    if (arc2 === null) throw new Error("cartArc null after re-time");
    expect(arc2).toBeCloseTo(arc1, 1);
    expect(await parked()).toBe(true);
    if (vp) await page.screenshot({ path: join(OUT, "park-2-held.png"), clip: strip() });

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the V0 AUTHORING flow (section-editor stage 4, fork 5): select the fixed START
// anchor in the viewport → its initial-speed popover → scrub the label AND type a value,
// each one undo entry → assert __kex.v0. The default flat seed keeps the START diamond
// clear of shape nodes (its one node sits a full EXTEND_DIST out) so it picks cleanly.
// Real affordances throughout; __kex is read only for assertions.
test("v0 authoring flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const v0 = () => page.evaluate((): number => (window as any).__kex.v0());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    // the default flat seed bakes on load — no seedHill, so the START diamond at the world
    // origin has no shape node on top of it.
    await expect.poll(tTotal).toBeGreaterThan(0);
    const v0Default = await v0();

    // ── 1. Click the START anchor → its v0 popover appears. the default camera centers the
    // world origin horizontally and vertically in the region above the dock (240 + 16px
    // inset kept clear), NOT the canvas center — so the click follows that framing. ──
    const DOCK_RESERVE = 256;
    const canvas = page.locator("#app > canvas");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    await page.mouse.click(cb.x + cb.width / 2, cb.y + (cb.height - DOCK_RESERVE) / 2);
    await expect(page.locator(".vtip")).toBeVisible();
    await page.waitForTimeout(300); // let the popover's 120ms fade-in finish before the shot
    await page.screenshot({ path: join(OUT, "v0-1-selected.png") });

    // ── 2. Scrub the v₀ label to the right → the speed rises, one undo entry. ──
    const key = page.locator(".vtip .key");
    const kb = await key.boundingBox();
    if (!kb) throw new Error("v0 scrub handle not laid out");
    await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
    await page.mouse.down();
    await page.mouse.move(kb.x + kb.width / 2 + 120, kb.y + kb.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(v0).toBeGreaterThan(v0Default);
    expect(await undoDepth()).toBe(1); // the whole scrub → one entry

    // undo restores the default speed.
    await page.keyboard.press("Control+z");
    await expect.poll(v0).toBeCloseTo(v0Default, 3);
    await expect.poll(undoDepth).toBe(0);

    // ── 3. Type an exact speed in the field → it commits verbatim, one undo entry. ──
    await page.locator(".vtip input").fill("25");
    await page.keyboard.press("Enter");
    await expect.poll(v0).toBeCloseTo(25, 3);
    expect(await undoDepth()).toBe(1);
    await page.screenshot({ path: join(OUT, "v0-2-typed.png") });

    // undo restores the default speed.
    await page.keyboard.press("Control+z");
    await expect.poll(v0).toBeCloseTo(v0Default, 3);

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the MIXED-LAYOUT DOGFOOD (section-editor stage 5): compose the whole chain the
// spec set out to author — a geo lead-in, a force airtime hill appended after it, then a
// geo turnaround appended after that — end to end through the REAL affordances (the `+`
// flyout, double-clicks over the force arc, the fat-hit crest drag). This is the
// reproducible artifact behind the stage-5 verdict; the hands-on feel pass — where the
// author sculpts the geometry and judges where the surface fights — stays the user's.
// Precise geometry isn't asserted: the claim is the composed chain builds through real
// clicks and bakes, and the authored hill re-times the ride.
test("mixed layout dogfood flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const forceCounts = () =>
        page.evaluate((): number[] => (window as any).__kex.sectionForceCounts());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const vp = page.viewportSize();
    const strip = () =>
        vp ? { x: 0, y: vp.height - 340, width: vp.width, height: 340 } : undefined;

    // seed a shaped geo lead-in (section 0) — the shaped track the chain grows from.
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await expect.poll(sectionCount).toBe(1);

    // ── 1. Append a force section after the lead-in via the real + flyout. ──
    await page.locator(".clip-add").click();
    await page.getByRole("menuitem", { name: "Append force section" }).click();
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1");
    await frameTimeline(page); // append never pans; frame the grown chain into view

    const body = page.locator(".dock .body");
    const bb = await body.boundingBox();
    if (!bb) throw new Error("timeline body not laid out");

    // ── 2. Author an airtime hill on the force section by real double-clicks over its arc
    // — three points (1g shoulders + a crest), the gotcha's minimum for a dip (one point
    // is a constant, so it takes three to make a localized bump). appendSection already
    // seeded two continuation keyframes (stage B) at the section's entry/exit → 2 + 3 = 5. ──
    const fcb = await page.locator(".clip").nth(1).boundingBox();
    if (!fcb) throw new Error("force clip not laid out");
    await expect.poll(async () => (await forceCounts())[1]).toBe(2); // the two seeds
    const cy = bb.y + bb.height * 0.5;
    for (const f of [0.25, 0.5, 0.75]) await page.mouse.dblclick(fcb.x + fcb.width * f, cy);
    await expect.poll(async () => (await forceCounts())[1]).toBe(5); // + the three hill points

    // pull the crest below 1g via its fat hit target → an airtime dip that re-times the
    // ride (the bake's total time shifts). five points now sort by x as: entry seed, the two
    // 1g shoulders flanking the crest, the crest itself, exit seed — the crest is the MIDDLE
    // of the five, not the middle of the three authored points.
    const tBefore = await tTotal();
    const hits = page.locator(".fhit");
    await expect(hits).toHaveCount(5);
    const centers = await hits.evaluateAll((els) =>
        els
            .map((el) => el.getBoundingClientRect())
            .map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))
            .sort((a, b) => a.x - b.x),
    );
    const crest = centers[2];
    await page.mouse.move(crest.x, crest.y);
    await page.mouse.down();
    await page.mouse.move(crest.x, crest.y + 22, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await tTotal()) - tBefore) > 1e-3).toBe(true);
    await page.waitForTimeout(300);
    if (vp) await page.screenshot({ path: join(OUT, "dogfood-1-hill.png"), clip: strip() });

    // ── 3. Append a geo turnaround after the hill via the real + flyout → the composed
    // chain: geo lead-in, force hill, geo turnaround. (The turnaround's geometry is the
    // hands-on sculpt; here the claim is the three-section mixed chain composed and bakes.)
    await page.locator(".clip-add").click();
    await page.getByRole("menuitem", { name: "Append geometry section" }).click();
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1,0");
    await expect.poll(tTotal).toBeGreaterThan(0);
    await frameTimeline(page); // append never pans; frame the grown chain into view
    await expect(page.locator(".clip")).toHaveCount(3);
    await page.screenshot({ path: join(OUT, "dogfood-2-chain.png") });
    if (vp) await page.screenshot({ path: join(OUT, "dogfood-3-timeline.png"), clip: strip() });

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// The geometry→force atom observability page:
// the ∂F/∂P sparsity heatmap, the round-trip overlay, and the conditioning plot.
// Pure canvas2D (no GPU) rendered on module load; capture the page + each panel.
test("geometry atoms lab", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/geometry-lab.html`, { waitUntil: "load" });
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(500); // let the canvases paint

    await page.screenshot({ path: join(OUT, "geometry-lab.png"), fullPage: true });
    const names = ["geometry-sparsity", "geometry-roundtrip", "geometry-conditioning"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// The Stage-2 loop-solve observability page:
// draft-vs-solved geometry under the band, the force curve entering the band,
// and the infeasible pin losing loudly. Pure canvas2D rendered on module load.
test("loop solve lab", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/loop-lab.html`, { waitUntil: "load" });
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(500); // let the canvases paint

    await page.screenshot({ path: join(OUT, "loop-lab.png"), fullPage: true });
    const names = ["loop-geometry", "loop-force", "loop-infeasible"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// The Stage-3 FVD-limit observability page:
// the sketch→oracle overlay on the loop, tracking across aggressiveness, and
// warm-start cost per target edit. Pure canvas2D rendered on module load.
test("FVD limit lab", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/fvd-lab.html`, { waitUntil: "load" });
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(500); // let the canvases paint

    await page.screenshot({ path: join(OUT, "fvd-lab.png"), fullPage: true });
    const names = ["fvd-overlay", "fvd-tracking", "fvd-warmstart"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// The collocation solver observability page:
// the LM convergence curve, the solved-vs-analytic overlay, and the solved-vs-
// target force. Pure canvas2D (no GPU) rendered on module load.
test("collocation solver lab", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/collocate-lab.html`, { waitUntil: "load" });
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(500); // let the canvases paint

    await page.screenshot({ path: join(OUT, "collocate-lab.png"), fullPage: true });
    const names = ["collocate-convergence", "collocate-overlay", "collocate-force"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the VIEWPORT KIND-COLOR shot (kex2d-ux-foundations stage D): a geo section
// appended by a force section, both feasible — zooms the viewport in on the boundary
// (real wheel zoom-at-cursor, not a fixed-scale clip) so the track polyline's per-
// section kind color reads at pixel scale, not just the clip strip. The other flows'
// full-page shots leave the polyline too small (and handle-occluded) to judge by eye.
// The chain's force section runs into "insufficient velocity" (the flat 1g profile
// drains the hill's energy) — a happy accident that also exercises the two priority
// fixes: the tail draws dashed red over the kind color, and (2nd shot) still draws
// dashed red under the selected-section accent overlay, not painted over by it.
test("viewport kind color shot", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    // a shaped geo lead-in, then an appended force section (default flat 1g profile).
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).__kex.append(1)); // SectionKind.Force
    await expect.poll(sectionCount).toBe(2);

    // the kind-colored curve, in the dock's chart — geo span cool blue, force span
    // accent gold, the same language as the clip strip right above it.
    await page.waitForTimeout(300);
    const vp = page.viewportSize();
    if (vp) {
        await page.screenshot({
            path: join(OUT, "kind-color-curve.png"),
            clip: { x: 0, y: vp.height - 340, width: vp.width, height: 340 },
        });
    }

    // zoom the viewport in on the chain start (a real wheel zoom-at-cursor, over the
    // canvas — the default framing already centers the track's origin there).
    const canvas = page.locator("#app > canvas");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    const DOCK_RESERVE = 256;
    const cx = cb.x + cb.width / 2;
    const cy = cb.y + (cb.height - DOCK_RESERVE) / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -1800); // deltaY < 0 → zoom in
    await page.waitForTimeout(SETTLE_MS);

    const zoomedClip = { x: cb.x, y: cb.y, width: cb.width, height: cb.height - DOCK_RESERVE };
    await page.screenshot({ path: join(OUT, "kind-color.png"), clip: zoomedClip });

    // select the force section (it holds the infeasible tail) — the accent overlay
    // must not paint solid over the dashed-red infeasible sub-segment (the priority
    // fix: infeasible-red > selection accent).
    await page.locator(".clip").nth(1).click();
    await expect.poll(() => page.evaluate(() => (window as any).__kex.selectedSection())).not.toBe(
        null,
    );
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, "kind-color-selected.png"), clip: zoomedClip });

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

