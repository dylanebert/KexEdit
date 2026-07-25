import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test as base } from "@playwright/test";

// kex2d's capture flows. Each test boots the page, drives one authoring surface through REAL
// pointer and keyboard events, asserts the resulting state through the DEV-only `window.__kex` hook
// (src/main.ts — read-only for the asserts; it performs an op only where a gesture can't reach the
// setup), and screenshots what it built. Screenshots land in KEX_OUT (a Windows path when staged;
// copied back). Each test carries its own header saying what it drives and what it pins.

// Env knobs, validated not coerced: `capture.ts` forwards values it has already checked, and these
// guards cover a direct `playwright test` run. This file is staged to the Windows host STANDALONE
// (`wsl.ts`), so it can import nothing: `UsageError` and `intEnv` are MIRRORED VERBATIM from
// `harness/args.ts`, and `tests/harness.test.ts` pins them character-identical to it — a drifting
// copy is a guard that only LOOKS enforced.
class UsageError extends Error {}

function intEnv(
    env: Record<string, string | undefined>,
    name: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max)
        throw new UsageError(
            `${name} must be an integer in [${min}, ${max}] (got ${JSON.stringify(raw)})`,
        );
    return n;
}

const PORT = String(intEnv(process.env, "KEX_PORT", 3014, 1024, 65_535));
const OUT = process.env.KEX_OUT ?? "shots";

// The ONE fixed wait left in this file, and it is cosmetic: a shot taken the frame a surface
// appears catches it mid-fade (popovers fade in over 120ms, transitions run ~150ms on the shared
// easing token). Nothing deterministic is bought past that — the cart LOOPS, so the scene never
// settles — so this is used only immediately before a screenshot. Every other wait here is a
// condition (`coding.md` forbids sleep-as-condition-wait).
const SHOT_MS = intEnv(process.env, "KEX_SHOT_MS", 300, 0, 60_000);

// The boot every flow shares, and the uncaught-exception gate around it.
//
// `boot()` opens the app and waits for the dock — the app's own mounted-and-laid-out gate.
// `boot("/some-lab.html")` opens a lab page instead; a lab states its own readiness (its `.panel`
// count), so there is nothing shared to wait on there.
//
// The `pageerror` listener is attached in fixture SETUP, before any navigation, and the teardown
// asserts nothing landed in it: an uncaught exception in the app is a defect, and without this the
// flow screenshots straight past it. Console errors are deliberately NOT collected — the only live
// traffic there is the lab pages' favicon 404s, and an error that matters throws.
type Boot = (path?: string) => Promise<void>;

const test = base.extend<{ boot: Boot }>({
    boot: async ({ page }, use) => {
        mkdirSync(OUT, { recursive: true });
        const thrown: string[] = [];
        page.on("pageerror", (e) => thrown.push(e.stack ?? e.message));
        await use(async (path = "/") => {
            await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: "load" });
            if (path === "/") await expect(page.locator(".dock")).toBeVisible();
        });
        expect(thrown, `the page threw an uncaught exception:\n${thrown.join("\n")}`).toEqual([]);
    },
});

// Layout constants MIRRORED from the app, because this file is staged to the host STANDALONE
// (`wsl.ts`) and so can import nothing from `src/`. Each names its source; a change there is a
// change here.
const CHART_TOP = 46; // RULER_H (26) + GAP_H (20) — Timeline.svelte, the chartzone's own top
const CHART_BOT_PAD = 8; // BOT_PAD — Timeline.svelte
// The viewport's default framing centers the world origin in the region above the dock, not in the
// canvas — src/view.ts DOCK_RESERVE = DOCK_HEIGHT (240) + DOCK_INSET (16), read by App.svelte.
const DOCK_RESERVE = 256;
const FORCE_LEN = 24; // MIRRORS src/track.ts DEFAULT_FORCE_LEN (= EXTEND_DIST) — a force
// section's extent on convert/append, so mid-extent is FORCE_LEN / 2.
const RADIAL_R = 46; // MIRRORS src/radial.ts RADIAL_R — the knob orbit (see `knobCenter` below)
const TIP_REACH = 68; // TIP_H (56) + TIP_GAP (12) — Timeline.svelte, the vertical room a popover needs
const GROW_LO = -3; // Timeline.svelte GROW_CAP[0] = BAND[0] (−2) − GROW_HEADROOM (1) — the growth floor
// The shipped manipulator snap quanta as the popover DISPLAYS them — src/settings.ts
// ANGLE_STEP_DEFAULT (5°, stored in radians) and LENGTH_STEP_DEFAULT (1 m), plus the range ends the
// fields clamp to: ANGLE_STEP_MIN (1°) / ANGLE_STEP_MAX (180°).
const SNAP_DEG = "5";
const SNAP_LEN = "1";
const SNAP_DEG_MIN = "1";
const SNAP_DEG_MAX = "180";

// window.__kex is the DEV harness hook (src/main.ts); these page-context reads use `any` freely —
// the hook is a DEV-only surface with no shared type.

// two laid-out DOM rects overlap iff they intersect on BOTH axes — the popover-vs-workspace
// no-overlap assert reads the real rendered boxes (a selector test proves nothing about where a
// box actually paints).
type Rect = { x: number; y: number; width: number; height: number };
function overlaps(a: Rect, b: Rect): boolean {
    return (
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    );
}

// The rect every timeline shot clips to: the bottom band of the viewport, full width. Taller than
// the dock itself (DOCK_RESERVE) so the strip sits inside the frame with the chart's upper reaches
// above it. Null when the page reports no viewport size — the guard each caller wraps its shot in.
const STRIP_H = 340;
function dockStrip(page: Page): Rect | null {
    const vp = page.viewportSize();
    return vp ? { x: 0, y: vp.height - STRIP_H, width: vp.width, height: STRIP_H } : null;
}

// Await `n` PROJECTED frames — 2n rAF callbacks, so 2n real frames. The app writes its DOM from a
// per-RAF tick, so a value produced by a pointer event is readable only one callback after the tick
// that computed it: the first callback runs the tick, the second lands after the DOM write it
// schedules. That pair is the unit here, hence the doubling — a caller measuring *app* frames
// (per-frame growth, say) wants half the number it would otherwise write.
//
// Raced against a wall clock: a stalled rAF (an occluded or throttled headless page) would
// otherwise hang to the 60s test timeout with nothing to read. The budget is generous — this is a
// wedge detector, never a timing assert.
function frames(page: Page, n = 1): Promise<void> {
    const budget = 5000 + n * 100;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`rAF stalled: ${n} frames never ran in ${budget}ms`)),
            budget,
        );
    });
    const ran = page.evaluate(
        (k: number) =>
            new Promise<void>((resolve) => {
                let left = k * 2;
                const step = (): void => {
                    if (--left <= 0) resolve();
                    else requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
            }),
        n,
    );
    return Promise.race([ran, stalled]).finally(() => clearTimeout(timer));
}

// Where a canvas node sits on the page, waited to a real POST-BAKE value — for ops that RESPAWN
// nodes, and only those.
//
// `__kex.nodeAt` resolves a node through `Handle.sample` — the bake's node→sample map — and
// `controls.ts`'s `pickNode` shares that lookup. Raw setup pokes (`seedHill`) and every snapshot
// restore that respawns nodes (an undo of an extend/delete) land SYNCHRONOUSLY, but the map they
// invalidate is only rebuilt when `BakeSystem` runs on the next frame; until then a freshly spawned
// handle's `sample` still reads 0, so EVERY node reports the track origin. `nodeCount` and
// `tTotal > 0` are both satisfied by the synchronous write, so neither is a bake-readiness condition
// — a right-click placed on their evidence lands on empty space and opens no menu (the `.nodemenu`
// flake; measured 1/10 by logging `nodeAt(6)` against `startAt()` right before shot.pw.ts's
// chain-end right-click). Being off the origin is exactly the condition the pointer needs, so poll
// for it and never cache a node point across a respawning edit.
//
// It establishes NOTHING after an IN-PLACE write (`restoreNodes`: a move/nudge undo, a gesture
// cancel) — `Handle.sample` is untouched there, so the predicate is already true against the
// pre-undo bake and this hands back a stale point. Wait on the bake landing on the expected
// geometry instead (the group-nudge undo below).
async function nodePoint(page: Page, order: number): Promise<{ x: number; y: number }> {
    // the polled read is the one that gets RETURNED — re-reading after the poll would hand back a
    // second, unvalidated evaluation (a fresh edit landing between the two is exactly the stale
    // point this helper exists to prevent).
    let seen: { x: number; y: number } | null = null;
    await expect
        .poll(async () => {
            seen = await page.evaluate((o: number): { x: number; y: number } | null => {
                const kex = (window as any).__kex;
                const p = kex.nodeAt(o);
                const origin = kex.startAt();
                if (!p || !origin) return null;
                return Math.hypot(p.x - origin.x, p.y - origin.y) > 1 ? p : null;
            }, order);
            return seen !== null;
        })
        .toBe(true);
    const pt: { x: number; y: number } | null = seen;
    if (!pt) throw new Error(`node ${order} never left the track origin — the bake never landed`);
    return pt;
}

// Seed the shaped hill AND wait for it to bake.
//
// `seedHill` pokes components raw (test setup, not authoring), so it lands synchronously — while
// `tTotal` still answers with the DEFAULT FLAT SEED's own bake, which is already > 0 on load. So
// `await expect.poll(tTotal).toBeGreaterThan(0)` after the poke proves nothing, and whatever reads
// the bake next gets the flat seed: `append`/`convert` seed a force section from the RECOVERED
// ENTRY FORCE, so racing them produced two different tracks run to run (the `viewport kind color
// shot` captured a feasible 6.0s spiral instead of the insufficient-velocity tail it exists to
// show — caught by the shot flipping between otherwise-identical runs). Wait out the flat bake
// first so the ride time MOVING is the hill's own bake landing.
async function seedHill(page: Page): Promise<void> {
    const tTotal = (): Promise<number> =>
        page.evaluate((): number => (window as any).__kex.tTotal());
    await expect.poll(tTotal).toBeGreaterThan(0); // the flat seed's bake, before the poke
    const flat = await tTotal();
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).not.toBe(flat); // …and now the hill's
}

// The page-coordinate center of a selected node's polar manipulator knob, waited to a box that
// really belongs to THAT node.
//
// The ring's knob buttons are DOM, positioned from the per-RAF tick — so when the selection MOVES
// from one node to another, `.manip-*` keeps the PREVIOUS node's ring position for a frame while
// `__kex.selectedOrder` already answers with the new one (selection is written synchronously). A box
// read on that evidence is hundreds of px away (measured: 573 px, exactly the old node's ring), and
// pressing there lands on empty canvas — an armed marquee, which DESELECTS on release. That is the
// geo flow's vanishing `.snap-readout`: 4/10 failures at 4 workers, and the drag never touched the
// knob at all. `.rbtn.manip` centers on its ring point, so "on this node's ring" is the honest
// condition; it also subsumes the appear-from-nothing case Playwright's own auto-wait covers.
//
// ON the ring, not within reach of it: a knob center orbits at exactly `RADIAL_R` (`.rbtn.manip` is
// `translate(-50%,-50%)` onto `manipKnobs`' ring point, which is `nodeAt` + a `ringSlot` offset of
// that magnitude), so the honest predicate is |dist − RADIAL_R| < tol. A one-sided `dist > 70` would
// accept an adjacent node's ring anywhere out to 116px — the stale-ring failure this exists to catch
// measured 573px, but nothing bounds it that far.
// layout rounding only: both boxes' edges land on the device pixel grid (0.5px at
// deviceScaleFactor 2) on both axes, so the radius can move ~1px; 2px is well inside a 46px orbit.
const RING_TOL = 2;
async function knobCenter(
    page: Page,
    cb: { x: number; y: number },
    order: number,
    axis: "length" | "angle",
): Promise<{ x: number; y: number }> {
    const n = await nodePoint(page, order);
    const knob = page.locator(`.manip-${axis}`);
    let seen: { x: number; y: number } | null = null;
    await expect
        .poll(async () => {
            const b = await knob.boundingBox();
            if (!b) return false;
            const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
            const r = Math.hypot(c.x - (cb.x + n.x), c.y - (cb.y + n.y));
            if (Math.abs(r - RADIAL_R) > RING_TOL) return false;
            seen = c;
            return true;
        })
        .toBe(true);
    const c: { x: number; y: number } | null = seen;
    if (!c) throw new Error(`the ${axis} knob never landed on node ${order}'s ring`);
    return c;
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
    // "every section is IN the DOM and the chain's two outer edges are inside the body" is what the
    // positional `.clip.nth()` locators need, and it takes all three parts: the wheel writes `view`
    // synchronously, but the clip LIST is projected by the per-RAF tick and a clip outside the view
    // is culled from the DOM entirely — so right after an append `.clip.last()` still names the OLD
    // last clip and its right edge says nothing about the new one. The count closes that gap; the
    // two edges close the other one, since culling is OVERLAP-based (a clip hanging off either end
    // of the body is still rendered, still counted, and still not fully on-screen).
    const sections = await page.evaluate((): number => (window as any).__kex.sectionCount());
    const clips = page.locator(".clip");
    await expect
        .poll(async () => {
            if ((await clips.count()) !== sections) return false;
            const first = await clips.first().boundingBox();
            const last = await clips.last().boundingBox();
            if (!first || !last) return false;
            return first.x >= bb.x && last.x + last.width <= bb.x + bb.width;
        })
        .toBe(true);
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
            return el?.closest(".menu-item")?.textContent?.trim().startsWith(p.label) ?? false;
        },
        { x, y, label: item },
    );
    expect(
        reachable,
        `menu item "${item}" must be hit-testable at its own center (not clipped out of paint)`,
    ).toBe(true);
    await page.mouse.click(x, y);
}

// A marquee (box-select) drag from one page-space corner to another — shared by the viewport
// (canvas coordinates) and timeline (chart coordinates) multiselect flows: both surfaces resolve
// the SAME gesture (a left-drag past DRAG_PX, optionally toggling under Shift), so one raw-pointer
// helper drives either. Shift is held from BEFORE pointerdown (captured at grab —
// `marqueeShift`/`shift` in controls.ts/Timeline.svelte) through release, matching a real shift-drag.
async function marqueeDrag(
    page: Page,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    shift = false,
): Promise<void> {
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 10 });
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
}

test("geo authoring flow", async ({ page, boot }) => {
    await boot();
    await expect(page.locator(".player")).toBeVisible();

    // read helpers over the DEV hook. expect.poll drives every wait — no fixed sleeps.
    const nodeCount = () => page.evaluate((): number => (window as any).__kex.nodeCount());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const poses = () => page.evaluate((): number[][] => (window as any).__kex.poses());

    // seed the airtime hill and wait for its first bake (the recovered force curve).
    await seedHill(page);
    await expect.poll(nodeCount).toBe(7);
    await page.waitForTimeout(SHOT_MS);

    // read-only baseline: the shaped track + its recovered F_n force curve.
    await page.screenshot({ path: join(OUT, "full.png") });
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "timeline.png"), clip: strip });

    // ── 1. Extend: select the chain end, press Enter → one node, one undo entry. ──
    await page.evaluate(() => (window as any).__kex.selectEnd());
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

    const canvas = page.locator("#app > canvas");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    const selectedOrder = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedOrder());

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
    // ordered by access frequency: Delete before Add. the rows are terse — the menu is ON the node,
    // so the noun would only restate its subject.
    await page.mouse.click(cb.x + chainEndBack.x, cb.y + chainEndBack.y, { button: "right" });
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
    const interiorPos = await nodePoint(page, 3); // an interior node of the seeded hill
    await page.mouse.click(cb.x + interiorPos.x, cb.y + interiorPos.y);
    await expect.poll(selectedOrder).toBe(3);
    const iak = await knobCenter(page, cb, 3, "angle"); // waited onto node 3's own ring
    await page.mouse.move(iak.x, iak.y);
    await page.mouse.down();
    await page.mouse.move(iak.x + 26, iak.y + 26, { steps: 10 }); // rotate the interior node
    await frames(page);
    const iDrag = await readoutAngle();
    await page.mouse.up();
    await frames(page);
    const iRest = await readoutAngle();
    expect(iDrag).not.toBeNull();
    expect(iRest).toBe(iDrag); // interior drag == rest — one consistent quantity (the exit heading)

    // ── 6. POLAR ARROW-NUDGE — the manipulators' KEYBOARD twin (kex2d-geo-ux): left/right step the
    // chord ANGLE around the previous node, up/down step the chord LENGTH along it, each press its
    // own undo entry. `polarNudge`'s math is unit-covered; what is not is the KEY WIRING — which key
    // reaches which axis, in which direction, and that a press brackets exactly one history entry.
    // Section 0's entry frame is the identity, so a stored pose IS its world point and the chord from
    // node 2 to node 3 is the polar pair (r, a) the two axes address. Each axis is pinned by BOTH
    // halves: the quantity it moves, and the one it must leave exactly alone — a swapped mapping
    // passes "something moved" and fails these. The step is `NUDGE_PX`(2)/zoom ≈ 0.05 m here, two
    // decades above the f32 hold tolerances below. Mutations: stub the arrow branch → nothing moves →
    // red; swap the axis map (ArrowUp → "angle") → both holds go red. ──
    const chord = async (): Promise<{ r: number; a: number }> => {
        const p = await poses();
        const dx = p[3][0] - p[2][0];
        const dy = p[3][1] - p[2][1];
        return { r: Math.hypot(dx, dy), a: Math.atan2(dy, dx) };
    };
    // one press, waited into the BAKE before the next one reads it. The nudge resolves its polar
    // frame from the SAMPLES (`nodeWorld`), which `BakeSystem` rewrites the frame AFTER the authored
    // write — so two presses inside one frame both step from the same stale geometry and the second
    // overwrites the first (measured: a right-then-left pair landed a full step short of where it
    // started, not back at it). The bake-readiness law again, on the WRITE side: an op that resolves
    // through the bake needs it to have landed, exactly as a pointer aimed at a node does. The step
    // is defined in screen px (`NUDGE_PX` = 2, converted through the zoom), so the node's own screen
    // point moving is the honest evidence the write reached the samples.
    const nodeScreen = () =>
        page.evaluate((): { x: number; y: number } | null => (window as any).__kex.nodeAt(3));
    const nudge = async (key: string): Promise<void> => {
        const at = await nodeScreen();
        if (!at) throw new Error("node 3 has no bake point to nudge from");
        await page.keyboard.press(key);
        await expect
            .poll(async () => {
                const p = await nodeScreen();
                return p !== null && Math.hypot(p.x - at.x, p.y - at.y) > 0.5;
            })
            .toBe(true);
    };
    const c0 = await chord();
    const undo0 = await undoDepth();
    await nudge("ArrowRight");
    const cR = await chord();
    expect(cR.a - c0.a).toBeGreaterThan(5e-3); // right = a positive angle step…
    expect(Math.abs(cR.r - c0.r)).toBeLessThan(1e-3); // …and the chord length is untouched
    expect(await undoDepth()).toBe(undo0 + 1); // one press = one entry
    await nudge("ArrowLeft");
    const cL = await chord();
    expect(cL.a).toBeCloseTo(c0.a, 3); // left is the same axis, the other way — back where it started
    expect(await undoDepth()).toBe(undo0 + 2);
    await nudge("ArrowUp");
    const cU = await chord();
    expect(cU.r - c0.r).toBeGreaterThan(5e-3); // up = a positive length step…
    expect(Math.abs(cU.a - c0.a)).toBeLessThan(1e-3); // …and the chord angle is untouched
    expect(await undoDepth()).toBe(undo0 + 3);
    await nudge("ArrowDown");
    const cD = await chord();
    expect(cD.r).toBeCloseTo(c0.r, 3); // down is the same axis, the other way
    expect(await undoDepth()).toBe(undo0 + 4);

    // ── 7. BLUR CANCELS A LIVE MANIPULATOR DRAG, completely (`editor-ui.md`: "Window blur cancels an
    // in-flight gesture completely — revert the bracketed edit, clear guides and capture. No guide may
    // exist without a live, threshold-crossed drag"). A blur delivers no pointerup, so without the
    // teardown the gesture SURVIVES the focus loss: the ray stays painted over a track nothing is
    // dragging, and the next move resumes against the stale grab. This drives `cancelDrag`'s MANIP
    // branch alone — the tangent / marquee / pan branches, and the timeline's missing blur cancel
    // entirely, are not pinned here. Driven on the TIP (order 6) because the guide ray exists only
    // where an exit incline does — `angleControl` returns `incline: null` at an interior node, so the
    // same drag on node 3 would make the ray assert vacuous; it also rides the magnet's default-on
    // state (a flow that pressed `S` first would take the ray poll red for an unrelated reason). The
    // blur is DISPATCHED: no Playwright gesture deterministically defocuses a headless page's window,
    // and the app's listener is a plain `window` blur listener, so the dispatched event is the same
    // handler on the same path (this is the one event here that isn't pointer-true, and it can't be).
    // The mid-drag reads are the positive controls — a cancel that "passes" because nothing was ever
    // live proves nothing. Mutations: empty `onBlur` → the pose stays moved, the ray stays up,
    // `data-dragging` stays 1 → red; `cancel()` → `commit(history)` in `cancelDrag`'s manip branch →
    // the pose holds AND an entry lands → red. ──
    const guides = () =>
        page.evaluate((): { ray: boolean; angle: string | null; length: string | null } =>
            (window as any).__kex.guides(),
        );
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
// the node to open the NODE context menu (Handles + a Tangents ▸ submenu) → open the submenu → set
// FREE → drag its out-handle → assert Free independence and a re-bake → Reset via the submenu clears
// the node back to live (Auto). The summon is a real canvas double-click, the node menu a real canvas
// right-click (both located via __kex.nodeAt); the handle drag is a real canvas pointer drag located
// through
// __kex.tangentHandles (canvas-drawn handles carry no DOM box). Handle drags no longer snap, so
// the drag lands where the pointer goes. The submenu items (Free, Reset) are clicked pointer-true
// via clickFlyout — a coordinate click gated on elementFromPoint reachability, the regression net
// for the context-submenu clip class (a selector .click() would fire on a clipped, unreachable row).
test("tangent edit flow", async ({ page, boot }) => {
    await boot();

    const nodeCount = () => page.evaluate((): number => (window as any).__kex.nodeCount());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const editing = () => page.evaluate((): boolean => (window as any).__kex.editing());
    const tangent = () =>
        page.evaluate(
            (): { mode: number; inX: number; inY: number; outX: number; outY: number } | null =>
                (window as any).__kex.tangent(),
        );
    const handles = () =>
        page.evaluate((): { side: string; x: number; y: number }[] =>
            (window as any).__kex.tangentHandles(),
        );

    // seed the shaped hill, then frame it so the interior node's handles separate at pixel
    // scale (the default ±280 m framing leaves the ~23 m hill a squiggle — `F` fits it; hover
    // defaults to the viewport, so no pre-move is needed to route the key there).
    await seedHill(page);
    await expect.poll(nodeCount).toBe(7);
    await page.keyboard.press("f");

    const canvas = page.locator("#app > canvas");
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

    // ── 4. RIGHT-CLICK → Tangents ▸ → Reset → the node clears back to live (Auto inference
    // resumes), so it carries no stored tangent again. available here (a tangent exists to clear). ──
    await page.mouse.click(cb.x + npos.x, cb.y + npos.y, { button: "right" });
    await expect(page.locator(".nodemenu")).toBeVisible();
    await clickFlyout(page, ".nodemenu", "Tangents", "Reset");
    await expect.poll(async () => (await tangent()) === null).toBe(true); // cleared to live

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
        page.evaluate((): { side: string; x: number; y: number }[] =>
            (window as any).__kex.tangentHandles(),
        );

    // the default flat seed bakes on load — no seedHill, so the START diamond at the origin sits
    // clear of shape nodes (node 1 is a full EXTEND_DIST out). frame it so the entry handle
    // separates at pixel scale (hover defaults to the viewport, so `f` routes there).
    await expect.poll(tTotal).toBeGreaterThan(0);
    await page.keyboard.press("f");

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

// Screenshot the TIMELINE TOOL RAIL (kex2d-authoring-surface): the thin icon-only strip on the
// dock's left edge that is the snap magnet's home (the Premiere vertical tool-strip precedent, a
// dock affordance — not a viewport overlay, not a second dock). Assert the toggle's lit/dimmed
// state rides `aria-pressed` (positive, not absence-of-error), and capture the default-on and
// toggled-off looks. `S` toggles it globally (the AE magnet key, not hover-gated).
//
// Then the magnet's SNAP-INCREMENT popover, summoned by right-click on that same button
// (Blender/Godot: the increments live on the snap control): the two quanta fields, their scrub
// handle, and the per-user persistence — the typed value survives a page reload, which is the whole
// point of the localStorage home and can only be proven in a real browser.
test("tool rail shot", async ({ page, boot }) => {
    await boot();

    const rail = page.locator(".tool-rail");
    const snap = rail.locator(".rail-tool");
    await expect(rail).toBeVisible();
    // default-on: the magnet toggle reads pressed and lit.
    await expect(snap).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(SHOT_MS);
    await rail.screenshot({ path: join(OUT, "tool-rail-on.png") });

    // ── S toggles it off (global, the AE magnet key) → aria-pressed flips, the icon dims. ──
    await page.keyboard.press("s");
    await expect(snap).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(SHOT_MS);
    await rail.screenshot({ path: join(OUT, "tool-rail-off.png") });

    // S again restores the default — keep the toggle honest across the flow.
    await page.keyboard.press("s");
    await expect(snap).toHaveAttribute("aria-pressed", "true");

    // ── right-click the magnet → its increments popover, at the shipped defaults (5° / 1 m). ──
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const pop = page.locator(".snap-pop");
    const angleField = pop.locator('input[aria-label="Snap angle increment (degrees)"]');
    const lenField = pop.locator('input[aria-label="Snap length increment (m)"]');
    await snap.click({ button: "right" });
    await expect(pop).toBeVisible();
    await expect(angleField).toHaveValue(SNAP_DEG);
    await expect(lenField).toHaveValue(SNAP_LEN);
    const undoBefore = await undoDepth();
    // the field is reachable where it actually paints — a selector-targeted assert proves nothing
    // about a box a human pointer can hit (the menus law: verify pointer-true).
    const fb = await angleField.boundingBox();
    if (!fb) throw new Error("snap angle field not laid out");
    expect(
        await page.evaluate(
            (p) => document.elementFromPoint(p.x, p.y)?.getAttribute("aria-label") ?? null,
            { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 },
        ),
    ).toBe("Snap angle increment (degrees)");
    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "tool-rail-increments.png"), clip: strip });

    // ── the key label is the field idiom's scrub handle: slide right → the increment rises. ──
    const key = pop.locator(".fld").first().locator(".key");
    const kb = await key.boundingBox();
    if (!kb) throw new Error("snap angle scrub handle not laid out");
    await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
    await page.mouse.down();
    await page.mouse.move(kb.x + kb.width / 2 + 80, kb.y + kb.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect
        .poll(async () => Number(await angleField.inputValue()))
        .toBeGreaterThan(Number(SNAP_DEG));

    // ── a typed value persists per user: it survives a full reload (localStorage, no document). ──
    await angleField.fill("12");
    await angleField.press("Enter");
    await expect(angleField).toHaveValue("12");
    // neither write is an authoring edit — a preference must not land on the undo stack (every other
    // field in this app commits a history entry, so this is the invariant a next author would break).
    expect(await undoDepth()).toBe(undoBefore);
    await page.reload({ waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();
    await snap.click({ button: "right" });
    await expect(pop).toBeVisible();
    await expect(angleField).toHaveValue("12");

    // both range ends clamp, and the FIELD is corrected to the clamped value — a rejected entry left
    // on screen would have the popover lying about the live grid. The ceiling matters because the
    // value persists: an extreme typed once would otherwise collapse the control across reloads.
    await angleField.fill("0.4");
    await angleField.press("Enter");
    await expect(angleField).toHaveValue(SNAP_DEG_MIN);
    await angleField.fill("400");
    await angleField.press("Enter");
    await expect(angleField).toHaveValue(SNAP_DEG_MAX);
});

// Drive the FORCE-AUTHORING flow: a geo track →
// convert to force via the real mode toggle (resets to an empty 1g profile) → author
// an airtime bump by force points → convert back to geo (resets to the flat seed) →
// undo, which restores the force track with its points byte-identical. The mode toggle
// and undo run through the real UI; point placement uses the __kex hook for precision.
test("force authoring flow", async ({ page, boot }) => {
    await boot();

    const kind = () => page.evaluate((): number => (window as any).__kex.kind());
    const nodeCount = () => page.evaluate((): number => (window as any).__kex.nodeCount());
    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const forces = () =>
        page.evaluate((): { s: number; g: number }[] => (window as any).__kex.forces());
    const forceEases = () => page.evaluate((): number[] => (window as any).__kex.forceEases());
    const forceTangents = () =>
        page.evaluate((): (null | object)[] => (window as any).__kex.forceTangents());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    // seed a shaped geo track so the convert inherits a real arclength.
    await seedHill(page);
    expect(await kind()).toBe(0); // TrackKind.Geo
    const tGeo = await tTotal(); // the hill's own bake — the convert's shot waits for this to MOVE

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
    // the flat force track BAKED — `tTotal > 0` was already true of the pre-convert geo bake, so
    // only a CHANGE proves the shot below shows the converted track (the bake-readiness law).
    await expect.poll(tTotal).not.toBe(tGeo);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "force-1-empty.png") });

    // ── 2. Author an airtime bump by force points → the recovered curve reacts. seedForceBump
    // adds 3 points on top of the 2 seeds → 5. ──
    await page.evaluate(() => (window as any).__kex.seedForceBump());
    await expect.poll(forceCount).toBe(5);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "force-2-bump.png") });
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "force-timeline.png"), clip: strip });

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
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "force-popover.png"), clip: strip });
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
    await expect
        .poll(async () => (await forces()).sort((a, b) => a.s - b.s)[2].g)
        .toBeCloseTo(beforeCtrl[2].g, 5);
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
    await expect
        .poll(() => page.evaluate((): boolean => (window as any).__kex.forceEditing()))
        .toBe(true);
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
    await expect
        .poll(() => page.evaluate((): boolean => (window as any).__kex.forceEditing()))
        .toBe(true);
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
test("force easing menu flow", async ({ page, boot }) => {
    await boot();

    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const forceEases = () => page.evaluate((): number[] => (window as any).__kex.forceEases());
    const forceEditing = () => page.evaluate((): boolean => (window as any).__kex.forceEditing());
    const forceHandleSel = () =>
        page.evaluate((): string | null => (window as any).__kex.forceHandleSel());
    const forceTangents = () =>
        page.evaluate((): (null | { inOn: boolean; outDs: number; outDg: number })[] =>
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
    await page.waitForTimeout(SHOT_MS);
    const menuStrip = dockStrip(page);
    if (menuStrip)
        await page.screenshot({ path: join(OUT, "force-easing-menu.png"), clip: menuStrip });

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
    // a menu that IS going to open renders on the next tick, so one projected frame is the
    // condition that makes this absence assert mean something (a bare `toHaveCount(0)` passes
    // instantly against a menu that simply hasn't rendered yet).
    await frames(page);
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
    await page.mouse.move(inKnob.x + inKnob.width / 2 + 2, inKnob.y + inKnob.height / 2 - 2, {
        steps: 2,
    });
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
    await page.mouse.move(knob.x + knob.width / 2 + 24, knob.y + knob.height / 2 - 40, {
        steps: 6,
    });
    await page.mouse.up();
    await expect.poll(async () => (await forceTangents())[1] !== null).toBe(true);

    // per-side materialization: dragging keyframe 1's OUT handle customizes only that side. Its
    // IN side — the trailing bound of the PRECEDING segment (kf0→kf1) — stays derived, so an
    // out-drag never spuriously customizes the segment behind the keyframe (composeTangent's
    // segment-scoped Custom model). A both-sides materialize would flip inOn true → red.
    expect((await forceTangents())[1]?.inOn).toBe(false);

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

    await page.waitForTimeout(SHOT_MS);
    const editStrip = dockStrip(page);
    if (editStrip)
        await page.screenshot({ path: join(OUT, "force-handle-edit.png"), clip: editStrip });

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
    await page.mouse.move(dgKeyBox.x + dgKeyBox.width / 2 + 40, dgKeyBox.y + dgKeyBox.height / 2, {
        steps: 10,
    });
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
    await expect
        .poll(async () => Math.abs((await forceTangents())[1]?.outDg ?? 1))
        .toBeLessThan(0.01);

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
});

// G2: the Tangents ▸ mode submenu (Mirror | Aligned | Free — the geo node menu's convention on a
// force keyframe) and the chord-aligned derived-Linear ghost display. Both are handle-layer feel
// features rendered on the real timeline, so both are driven pointer-true and asserted against the
// drawn DOM + __kex state.
test("force tangent mode + linear ghost flow", async ({ page, boot }) => {
    await boot();

    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const forceEases = () => page.evaluate((): number[] => (window as any).__kex.forceEases());
    const forceEditing = () => page.evaluate((): boolean => (window as any).__kex.forceEditing());
    const forceTangents = () =>
        page.evaluate(
            (): (null | {
                mode: number;
                inOn: boolean;
                inDs: number;
                inDg: number;
                outOn: boolean;
                outDs: number;
                outDg: number;
            })[] => (window as any).__kex.forceTangents(),
        );

    // seed an airtime bump on a force section: two continuation seeds + three bump points = five
    // keyframes, kf1..kf3 interior (each governs a following segment).
    await page.evaluate(() => (window as any).__kex.seedForceBump());
    await expect.poll(forceCount).toBeGreaterThanOrEqual(5);
    const nPts = await forceCount();
    await frameTimeline(page);
    await expect(page.locator(".fpt")).toHaveCount(nPts);

    // ── A. Chord-aligned derived-Linear ghost (feature 2). Set kf1's following segment to Linear,
    // enter handle edit (no drag → both sides stay derived ghosts), and assert the OUT ghost knob
    // is DRAWN forward of the diamond (chord-aligned at influence 1/3), not collapsed to a dot on
    // it. Red-first: revert `derivedOut` to the flat `autoTangent` and a Linear ghost's Δs → 0, so
    // the knob lands on the diamond → `ghostCx − diaCx ≈ 0` → red. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Linear");
    await expect.poll(async () => (await forceEases())[1]).toBe(0); // Easing.Linear
    await page.keyboard.press("Escape"); // deselect (clear the keyframe .ptip floating over the chart)
    await expect(page.locator(".ptip")).toHaveCount(0);
    await page.locator(".fpt").nth(1).dblclick(); // handle-edit sub-mode
    await expect.poll(forceEditing).toBe(true);
    await expect(page.locator(".tknob.ghost")).toHaveCount(2); // both sides derived (hollow ghosts)
    const dia1 = await page.locator(".fpt").nth(1).locator(".fhit").boundingBox();
    const outGhost = await page.locator(".tknob.ghost").last().boundingBox(); // handles render in, then OUT
    if (!dia1 || !outGhost) throw new Error("kf1 diamond / out ghost not laid out");
    const diaCx = dia1.x + dia1.width / 2;
    const ghostCx = outGhost.x + outGhost.width / 2;
    expect(ghostCx - diaCx).toBeGreaterThan(12); // chord-aligned reach forward, not a dot on the diamond
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(forceEditing).toBe(false);

    // ── B. Tangents ▸ mode submenu (feature 1). Give kf1 BOTH explicit handles so the coupling is
    // observable: Custom on kf1 materializes its OUT, Custom on kf0 materializes kf1's IN. First
    // reset kf1 back to a preset (Cubic) so the seeds are flat. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await clickFlyout(page, ".fmenu", "Easing", "Cubic");
    await expect.poll(async () => (await forceEases())[1]).toBe(1); // back to Cubic
    await page.keyboard.press("Escape");
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await clickFlyout(page, ".fmenu", "Easing", "Custom"); // materializes kf1.out, enters handle edit
    await expect.poll(async () => (await forceTangents())[1]?.outOn === true).toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(forceEditing).toBe(false);
    await page.locator(".fpt").nth(0).click({ button: "right" });
    await clickFlyout(page, ".fmenu", "Easing", "Custom"); // materializes kf1.in (the kf0→kf1 trailing side)
    await expect
        .poll(async () => {
            const t = (await forceTangents())[1];
            return t?.inOn === true && t?.outOn === true;
        })
        .toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(forceEditing).toBe(false);

    // ── B1. kf1 now holds both sides, default mode Aligned (a flat pair materializes Aligned). Its
    // menu carries a Tangents ▸ row, and Aligned is the checked mode inside the submenu. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await expect
        .poll(async () =>
            (await page.locator(".fmenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Delete Del", "Easing ▸", "Tangents ▸"]);
    await page.locator(".fmenu").getByRole("menuitem", { name: "Tangents", exact: true }).hover();
    await expect(
        page.locator(".fmenu").getByRole("menuitem", { name: "Aligned", exact: true }),
    ).toHaveClass(/checked/);

    // ── B2. Pick Free through the Tangents ▸ flyout → the stored mode flips to Free (2). ──
    await clickFlyout(page, ".fmenu", "Tangents", "Free");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceTangents())[1]?.mode).toBe(2); // TangentMode.Free

    // ── B3. Under Free, dragging the OUT handle no longer couples the IN side (Aligned would swing
    // it collinear). Enter handle edit, record kf1's IN offset, drag OUT far off-axis, assert IN is
    // unchanged. Red-first: fold Free into composeTangent's coupling branch and IN moves → red. ──
    await page.locator(".fpt").nth(1).dblclick();
    await expect.poll(forceEditing).toBe(true);
    const inBefore = (await forceTangents())[1];
    if (!inBefore) throw new Error("kf1 must hold explicit handles for the decouple check");
    const outKnob = await page.locator(".thit").last().boundingBox(); // in, then OUT
    if (!outKnob) throw new Error("kf1 out knob not laid out");
    await page.mouse.move(outKnob.x + outKnob.width / 2, outKnob.y + outKnob.height / 2);
    await page.mouse.down();
    await page.mouse.move(outKnob.x + outKnob.width / 2 + 10, outKnob.y + outKnob.height / 2 - 44, {
        steps: 6,
    });
    await page.mouse.up();
    await expect
        .poll(async () => Math.abs((await forceTangents())[1]?.outDg ?? 0))
        .toBeGreaterThan(0.05); // OUT moved
    const inAfter = (await forceTangents())[1];
    expect(inAfter?.inDs).toBeCloseTo(inBefore.inDs, 6); // IN untouched — Free does not couple
    expect(inAfter?.inDg).toBeCloseTo(inBefore.inDg, 6);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(forceEditing).toBe(false);

    // ── C. A DERIVED-only keyframe (no explicit handles) shows NO Tangents ▸ row — there is no
    // stored mode to edit. kf3 (interior, untouched by A/B) is fully derived. ──
    await page.locator(".fpt").nth(3).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    expect((await forceTangents())[3]).toBeNull(); // kf3 is derived (no explicit handles)
    await expect
        .poll(async () =>
            (await page.locator(".fmenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Delete Del", "Easing ▸"]); // no Tangents ▸ on a derived keyframe
    await page.keyboard.press("Escape");
    await expect(page.locator(".fmenu")).toHaveCount(0);
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

    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    // seed a force section with an airtime bump → keyframes spanning the g-range, so the 0g crest
    // sits LOW in the chart (near the viewport bottom, where its menu would overflow). the bump's
    // own bake is what the diamonds are read off, and `tTotal > 0` is satisfied by the FLAT SEED's
    // bake (already landed on load), so wait out the flat one and then for it to CHANGE.
    await expect.poll(tTotal).toBeGreaterThan(0);
    const tFlat = await tTotal();
    await page.evaluate(() => (window as any).__kex.seedForceBump());
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

// Handle drags must behave like keyframe/node drags at the view edges, through the SAME mechanisms:
// (1) a handle HELD past the chart edge EDGE-PANS the value axis (the shared growValueAxis path,
// factored from the keyframe drag), and (2) on RELEASE the range ACCOMMODATES the handle endpoint so
// a knob never sits outside the visible range (yTarget's content extent, extended to explicit handle
// endpoints — the same accommodate keyframes get through the curve scan). The gRange hook reads the
// displayed g-range (yView); a real canvas pointer drives the drag past the edge. Each half carries
// its own mutation: unwire the handle branch → no pan; drop the handle-endpoint inclusion → no fit.
test("handle drag edge-pans the value axis and a released handle stays in range", async ({
    page,
    boot,
}) => {
    await boot();

    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const forceEditing = () => page.evaluate((): boolean => (window as any).__kex.forceEditing());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const forces = () =>
        page.evaluate((): { s: number; g: number }[] => (window as any).__kex.forces());
    const forceTangents = () =>
        page.evaluate((): (null | { outDg: number })[] => (window as any).__kex.forceTangents());
    const gRange = () => page.evaluate((): [number, number] => (window as any).__kex.gRange());

    // seed a force bump → an interior shoulder keyframe (nth 1) whose OUT handle has room downward.
    // the flat seed already bakes `tTotal > 0` on load, so wait it out and then for the bump's own
    // bake to CHANGE it — the diamonds below are read off that bake.
    await expect.poll(tTotal).toBeGreaterThan(0);
    const tFlat = await tTotal();
    await page.evaluate(() => (window as any).__kex.seedForceBump());
    await expect.poll(forceCount).toBeGreaterThanOrEqual(3);
    await expect.poll(tTotal).not.toBe(tFlat);
    await frameTimeline(page);

    const body = await page.locator(".dock .body").boundingBox();
    if (!body) throw new Error("timeline body not laid out");
    const chartBotY = body.y + body.height - CHART_BOT_PAD;

    await page.locator(".fpt").nth(1).dblclick(); // enter handle edit → its two handles summon
    await expect.poll(forceEditing).toBe(true);
    await expect(page.locator(".thit")).toHaveCount(2);

    // ── 1. Edge-pan: grab the OUT knob, drag it straight DOWN well past the chart bottom, and HOLD.
    // The shared edge-grow fires per frame while the cursor is held beyond the edge, so the displayed
    // range's floor keeps dropping (the held handle rides the growing axis) — until it lands on the
    // growth CAP and stops. Growth is span-proportional, so it compounds per frame; uncapped, a held
    // drag runs to absurd g in well under a second (the hand check that sent stage 8 back), which is
    // what the cap bounds. Mutation: revert the handle branch in the yView effect to `return` (unwire
    // the path) → the axis holds → the floor never drops → this times out red. Mutation: drop the cap
    // from `yGrow` → the floor keeps falling past it → the hold-still assert goes red. ──
    const [lo0] = await gRange();
    expect(lo0).toBeGreaterThan(GROW_LO); // the resting frame sits inside the cap — there IS room to grow
    const knob = await page.locator(".thit").last().boundingBox();
    if (!knob) throw new Error("out handle knob not laid out");
    const knobX = knob.x + knob.width / 2;
    await page.mouse.move(knobX, knob.y + knob.height / 2);
    await page.mouse.down();
    await page.mouse.move(knobX, chartBotY + 140, { steps: 8 }); // straight down, past the bottom, HELD
    await expect.poll(async () => (await gRange())[0]).toBeCloseTo(GROW_LO, 3); // grew down to the cap
    await frames(page, 24); // …held past the edge for 48 more real frames (`frames` awaits 2n rAF
    // callbacks). Growth compounds per FRAME, so frames — not milliseconds — are this hold's unit,
    // and the count is the detection power: a ~1e-4/frame leak past the cap hides inside 24.
    expect((await gRange())[0]).toBeCloseTo(GROW_LO, 3); // …and stopped there, never past it
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
});

// Drive the MULTI-SECTION chain shape: a geo track → append a section → convert it to
// force (a mixed geo→force chain) → delete the force tail → undo. The ops run through the
// __kex hooks; sectionCount / sectionKinds assert the chain shape. (Split/join left the
// editor — deferred to the conversion tier — so they're no longer exercised here; the
// substrate ops stay covered by the unit suite.)
test("multi-section flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const selectedSection = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedSection());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    await seedHill(page);
    expect(await sectionCount()).toBe(1);

    // ── 1. Append a geo section, then convert it to force → a mixed geo→force chain. the convert
    // seeds its keyframes from the RECOVERED ENTRY FORCE, which `sectionInfo` only carries once the
    // appended section is in the bake — and the section COUNT is satisfied the instant `append`
    // returns, a frame earlier (the bake-readiness law). Racing it seeds `DEFAULT_G` or the
    // recovered force by coin flip, and `sections-mixed.png` flips with it. So wait for the bake
    // itself to move. ──
    const tGeo = await tTotal();
    await page.evaluate(() => (window as any).__kex.append(0)); // SectionKind.Geo
    await expect.poll(sectionCount).toBe(2);
    await expect.poll(tTotal).not.toBe(tGeo); // the appended section is IN the bake
    await page.evaluate(() => (window as any).__kex.convertAt(1));
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1"); // geo, force
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "sections-mixed.png") });

    // ── 2. Delete the force tail → 1 (downstream rebases); undo restores it. ──
    await page.evaluate(() => (window as any).__kex.deleteAt(1));
    await expect.poll(sectionCount).toBe(1);
    await page.keyboard.press("Control+z");
    await expect.poll(sectionCount).toBe(2);

    // ── 3. THE SELECTED NODE'S CLIP WASHES — the cross-surface context read (kex2d-geo-ux stage 3):
    // "which clip does the selection live in", a quieter register than the selected-clip state. It is
    // keyed to the OWNING section (`washSection` = `Handle.section` of the active node), which only a
    // chain with MORE THAN ONE geo clip can prove: with a single geo section every wrong answer
    // ("always the first clip", "always a geo clip") is indistinguishable from the right one. So grow
    // the chain to geo · force · geo and select a node in each end. ──
    const tMixed = await tTotal();
    await page.evaluate(() => (window as any).__kex.append(0)); // SectionKind.Geo — the third section
    await expect.poll(sectionCount).toBe(3);
    await expect.poll(tTotal).not.toBe(tMixed); // the appended section is IN the bake
    // `F` frames the SELECTION when there is one (`frameRange`), and every screen point below is
    // computed against that camera — so pin the precondition rather than inferring it from what the
    // undo happened to restore.
    expect(await selectedSection()).toBeNull();
    await page.keyboard.press("f"); // nothing selected → the whole chain frames
    await frameTimeline(page); // …and every clip on-screen, so `.clip.nth()` is section order
    const clips = page.locator(".clip");
    await expect(clips).toHaveCount(3);
    const washed = async (): Promise<boolean[]> => {
        const cls = await clips.evaluateAll((els) => els.map((e) => e.getAttribute("class") ?? ""));
        return cls.map((c) => c.split(/\s+/).includes("wash"));
    };

    const canvas = page.locator("#app > canvas");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");

    // a node in the FIRST section (the seeded hill) → its own clip washes, the other two don't.
    // Mutations: `washSection` → null → red here; → the second section's id → red here.
    const nodeSelOrders = () =>
        page.evaluate((): number[] => (window as any).__kex.nodeSelOrders());
    const n3 = await nodePoint(page, 3);
    await page.mouse.click(cb.x + n3.x, cb.y + n3.y);
    await expect.poll(nodeSelOrders).toEqual([3]);
    await expect.poll(washed).toEqual([true, false, false]);

    // …and a node in the THIRD section moves it. That section's nodes have no `__kex` locator (the
    // hooks address section 0), so they're reached the way an author would: a marquee over the strip
    // of viewport downstream of the first section's tip — everything right of it belongs to the force
    // section (which has no nodes) or to the third (whose order-0 entry a marquee never takes, so the
    // rect can only resolve to its one draggable node). The `[false, false, true]` shape is what
    // discriminates: had the rect caught a first-section node instead, clip 0 would light.
    const tip = await nodePoint(page, 6); // the first section's chain end = the geo/force boundary
    await marqueeDrag(
        page,
        cb.x + tip.x + 24,
        cb.y + 6,
        cb.x + cb.width - 6,
        cb.y + cb.height - DOCK_RESERVE,
    );
    await expect.poll(nodeSelOrders).toEqual([1]); // its one draggable node — orders are per-section
    await expect.poll(washed).toEqual([false, false, true]);
    // …and the wash PAINTS: the class alone would survive deleting the `.clip.geo.wash` rule that is
    // the whole feature. Both clips are geo and neither is hovered (the pointer is over the canvas),
    // so their resolved fills differ only by the wash rung.
    const fills = await clips.evaluateAll((els) => els.map((e) => getComputedStyle(e).fill));
    expect(fills[2]).not.toBe(fills[0]);
    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "sections-wash.png"), clip: strip });

    // selecting a CLIP instead takes the selection with it (node and section selection are mutually
    // exclusive, `editor.ts`), so the wash goes out entirely — a washed clip is never also the
    // selected clip, which is the whole reason the wash is a quieter register than `sel`.
    // Mutation: key `washSection` to `editor.section` → the selected clip washes → red.
    await clips.nth(0).click();
    await expect(clips.nth(0)).toHaveClass(/sel/);
    await expect.poll(washed).toEqual([false, false, false]);
});

// Drive the CLIP STRIP flow (section-editor spec stage 1): the section lane in the
// dock's marker band. seed one geo section → append a force section via the real `+`
// flyout → select the geo clip → drag the force clip's right-edge extent trim → undo.
// Every affordance is driven through the real DOM (clip rect, flyout, trim handle); the
// __kex hook is read only for assertions, never to perform the op.
test("section clip strip flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const sectionIds = () => page.evaluate((): number[] => (window as any).__kex.sectionIds());
    const sectionLengths = () =>
        page.evaluate((): number[] => (window as any).__kex.sectionLengths());
    const selectedSection = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedSection());

    const strip = dockStrip(page);

    // seed one geo section → one geo clip in the lane.
    await seedHill(page);
    await expect(page.locator(".clip")).toHaveCount(1);
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "clip-1-strip.png"), clip: strip });

    // ── 1. Append a force section via the real + flyout → a mixed geo→force chain. the flyout
    // root-mounts (out of the dock's overflow clip), so assert its item is hit-testable at its
    // own center — a real pointer's reach, the Menus reachability net (a selector .click() fires
    // on a clipped, humanly-unreachable row). ──
    await page.locator(".clip-add").click();
    const forceItem = page
        .locator(".clip-flyout")
        .getByRole("menuitem", { name: "Append force section" });
    await expect(forceItem).toBeVisible();
    const fib = await forceItem.boundingBox();
    if (!fib) throw new Error("append flyout item not laid out");
    const fix = fib.x + fib.width / 2;
    const fiy = fib.y + fib.height / 2;
    const flyoutReach = await page.evaluate(
        (p: { x: number; y: number }) =>
            document.elementFromPoint(p.x, p.y)?.closest(".menu-item") !== null,
        { x: fix, y: fiy },
    );
    expect(
        flyoutReach,
        "append flyout item must be hit-testable at its own center (not clipped)",
    ).toBe(true);
    await page.mouse.click(fix, fiy);
    await expect.poll(sectionCount).toBe(2);
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1"); // geo, force
    // the append selects the new (force) section — its clip reads selected.
    await expect.poll(selectedSection).toBe((await sectionIds())[1]);
    await frameTimeline(page); // append never pans; frame the grown chain into view
    await expect(page.locator(".clip")).toHaveCount(2);
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "clip-2-append.png"), clip: strip });

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
    if (strip) await page.screenshot({ path: join(OUT, "clip-3-trim.png"), clip: strip });

    // undo restores the pre-drag extent, one entry.
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await sectionLengths())[1]).toBeCloseTo(before[1], 3);
});

// Drive the SECTION MENU + DIRECT-BY-POSITION flow (section-editor stage 2): a mixed
// geo→force chain → prove empty-chart click deselects → add a force keyframe by cursor
// position WITHOUT selecting the section → right-click Convert and Delete via the real
// context menu. The whole point is that authoring and section ops no longer depend on a
// "current section" selection. Everything is driven through the real DOM.
test("section menu + keyframe flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const sectionIds = () => page.evaluate((): number[] => (window as any).__kex.sectionIds());
    const forceCounts = () =>
        page.evaluate((): number[] => (window as any).__kex.sectionForceCounts());
    const selectedSection = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedSection());
    const strip = dockStrip(page);

    // seed a geo section, append a force one via the real + flyout → a mixed chain.
    await seedHill(page);
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
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "section-2-keyframe.png"), clip: strip });

    // ── 3. Right-click the force clip → "Convert to Geo" (real context menu). ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    if (strip) await page.screenshot({ path: join(OUT, "section-3-menu.png"), clip: strip });
    await page.getByRole("menuitem", { name: "Convert to Geo" }).click();
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,0");
    await page.keyboard.press("Control+z"); // convert is one undo entry
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1");

    // ── 4. Right-click a clip → Delete (real context menu). ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(sectionCount).toBe(1);
});

// Drive the CONTENT-ANCHORED PLAYHEAD PARKING flow (section-editor stage 3, fork 4): a
// mixed geo→force chain with a force keyframe → park the playhead over the force section
// via a REAL ruler scrub → drag the keyframe's g so the bake re-times → assert the parked
// playhead's arclength held (glued to the track feature) while the ride re-timed. Without
// content-anchoring the playhead is pinned to ride-time and would slide under the re-time.
test("playhead parking flow", async ({ page, boot }) => {
    await boot();

    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const forceCounts = () =>
        page.evaluate((): number[] => (window as any).__kex.sectionForceCounts());
    const cartArc = () => page.evaluate((): number | null => (window as any).__kex.cartArc());
    const parked = () => page.evaluate((): boolean => (window as any).__kex.parked());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const strip = dockStrip(page);

    // seed a geo section, append a force one via the real + flyout → a mixed chain.
    await seedHill(page);
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
    if (strip) await page.screenshot({ path: join(OUT, "park-1-anchored.png"), clip: strip });

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
    if (strip) await page.screenshot({ path: join(OUT, "park-2-held.png"), clip: strip });
});

// Drive the V0 AUTHORING flow (section-editor stage 4, fork 5): select the fixed START
// anchor in the viewport → its initial-speed popover → scrub the label AND type a value,
// each one undo entry → assert __kex.v0. The default flat seed keeps the START diamond
// clear of shape nodes (its one node sits a full EXTEND_DIST out) so it picks cleanly.
// Real affordances throughout; __kex is read only for assertions.
test("v0 authoring flow", async ({ page, boot }) => {
    await boot();

    const v0 = () => page.evaluate((): number => (window as any).__kex.v0());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    // the default flat seed bakes on load — no seedHill, so the START diamond at the world
    // origin has no shape node on top of it.
    await expect.poll(tTotal).toBeGreaterThan(0);
    const v0Default = await v0();

    // ── 1. Click the START anchor → its v0 popover appears. The framing (DOCK_RESERVE) is the
    // camera's, not the canvas center — so the click follows it. ──
    const canvas = page.locator("#app > canvas");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    await page.mouse.click(cb.x + cb.width / 2, cb.y + (cb.height - DOCK_RESERVE) / 2);
    await expect(page.locator(".vtip")).toBeVisible();
    await page.waitForTimeout(SHOT_MS);
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
});

// Drive the MIXED-LAYOUT DOGFOOD (section-editor stage 5): compose the whole chain the
// spec set out to author — a geo lead-in, a force airtime hill appended after it, then a
// geo turnaround appended after that — end to end through the REAL affordances (the `+`
// flyout, double-clicks over the force arc, the fat-hit crest drag). This is the
// reproducible artifact behind the stage-5 verdict; the hands-on feel pass — where the
// author sculpts the geometry and judges where the surface fights — stays the user's.
// Precise geometry isn't asserted: the claim is the composed chain builds through real
// clicks and bakes, and the authored hill re-times the ride.
test("mixed layout dogfood flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const sectionKinds = () => page.evaluate((): number[] => (window as any).__kex.sectionKinds());
    const forceCounts = () =>
        page.evaluate((): number[] => (window as any).__kex.sectionForceCounts());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const strip = dockStrip(page);

    // seed a shaped geo lead-in (section 0) — the shaped track the chain grows from.
    await seedHill(page);
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
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "dogfood-1-hill.png"), clip: strip });

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
    if (strip) await page.screenshot({ path: join(OUT, "dogfood-3-timeline.png"), clip: strip });
});

// The geometry→force atom observability page:
// the ∂F/∂P sparsity heatmap, the round-trip overlay, and the conditioning plot.
// Pure canvas2D (no GPU) rendered on module load; capture the page + each panel.
test("geometry atoms lab", async ({ page, boot }) => {
    await boot("/geometry-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(SHOT_MS);

    await page.screenshot({ path: join(OUT, "geometry-lab.png"), fullPage: true });
    const names = ["geometry-sparsity", "geometry-roundtrip", "geometry-conditioning"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }
});

// The Stage-2 loop-solve observability page:
// draft-vs-solved geometry under the band, the force curve entering the band,
// and the infeasible pin losing loudly. Pure canvas2D rendered on module load.
test("loop solve lab", async ({ page, boot }) => {
    await boot("/loop-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(SHOT_MS);

    await page.screenshot({ path: join(OUT, "loop-lab.png"), fullPage: true });
    const names = ["loop-geometry", "loop-force", "loop-infeasible"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }
});

// The Stage-3 FVD-limit observability page:
// the sketch→oracle overlay on the loop, tracking across aggressiveness, and
// warm-start cost per target edit. Pure canvas2D rendered on module load.
test("FVD limit lab", async ({ page, boot }) => {
    await boot("/fvd-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(SHOT_MS);

    await page.screenshot({ path: join(OUT, "fvd-lab.png"), fullPage: true });
    const names = ["fvd-overlay", "fvd-tracking", "fvd-warmstart"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }
});

// The collocation solver observability page:
// the LM convergence curve, the solved-vs-analytic overlay, and the solved-vs-
// target force. Pure canvas2D (no GPU) rendered on module load.
test("collocation solver lab", async ({ page, boot }) => {
    await boot("/collocate-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(SHOT_MS);

    await page.screenshot({ path: join(OUT, "collocate-lab.png"), fullPage: true });
    const names = ["collocate-convergence", "collocate-overlay", "collocate-force"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }
});

// The geo→force fit-lab observability page (kex2d-geoforce-spike stage 5). Unlike the other lab
// pages above, this one is NOT ready on module load: it auto-runs the whole 10-scenario corpus
// through the solver in the background (`fitlab.ts` `pump`, chunked via `setTimeout(…, 0)` so the
// page stays responsive), so readiness is `window.__fitlab.ready()` polled, not a panel count or a
// fixed wait — a count is never bake-readiness's sibling law, one layer up the stack (the ready
// flag, not a proxy for it). `errors()` empty is this page's `pageerror`: a corpus that stops
// solving mid-run must not read as a green page (`fitlab.ts` records a throw per scenario rather
// than swallowing it). `rows().length === 10` is every scenario having attempted AND succeeded (a
// caught throw leaves a row absent, not present-and-false), and every row's `converged` is the
// solver actually reaching its exit tolerance — divergence on the corpus is a bug, not an expected
// mode (the spec's locked decision). The iteration-speed budget: the corpus takes ~1.3s of solve
// wall time (stage-3 live log), so 10s gives ~8x headroom against a contended worker (the default
// 4-worker suite shares the host's CPU across parallel pages) — generous enough that only a real
// stall, not scheduling noise, trips it.
//
// Then flip to valley-explicit — the far-shooting spike scenario the stage-3 log calls out (a 38g
// spike edge fits force to 0.033g yet integrates 39.7m off) — and land on frame 0, the warm start:
// the fit-lab code comment says the collocation spine starts AT the target, so the interesting
// motion through playback lives in the FORCE graph, not the viewport; frame 0 is the story frame
// for that gap, before the polish closes it.
test("fit lab", async ({ page, boot }) => {
    await boot("/fit-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3); // geometry, force, corpus table

    const ready = () => page.evaluate((): boolean => (window as any).__fitlab.ready());
    const errors = () => page.evaluate((): string[] => (window as any).__fitlab.errors());
    const rows = () =>
        page.evaluate((): { name: string; converged: boolean }[] =>
            (window as any).__fitlab.rows(),
        );

    await expect.poll(ready, { timeout: 10_000 }).toBe(true);
    expect(await errors()).toEqual([]);
    const solved = await rows();
    expect(solved.length).toBe(10);
    for (const r of solved) expect(r.converged, `${r.name} did not converge`).toBe(true);

    await page.evaluate(() => (window as any).__fitlab.select("valley-explicit"));
    await page.evaluate(() => (window as any).__fitlab.setFrame(0));

    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "fit-lab.png"), fullPage: true });
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

    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());

    // a shaped geo lead-in, then an appended force section (default flat 1g profile).
    await seedHill(page);
    await page.evaluate(() => (window as any).__kex.append(1)); // SectionKind.Force
    await expect.poll(sectionCount).toBe(2);

    // the kind-colored curve, in the dock's chart — geo span cool blue, force span
    // accent gold, the same language as the clip strip right above it.
    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "kind-color-curve.png"), clip: strip });

    // zoom the viewport in on the chain start (a real wheel zoom-at-cursor, over the
    // canvas — the default framing already centers the track's origin there).
    const canvas = page.locator("#app > canvas");
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
    await expect
        .poll(() => page.evaluate(() => (window as any).__kex.selectedSection()))
        .not.toBe(null);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "kind-color-selected.png"), clip: zoomedClip });
});

// Drive the INFEASIBLE-TRACK shot: the two stacked-language renders the kind-color flow above
// used to cover only by accident (an append racing the bake), authored deliberately here —
// (a) dashed infeasible red over a kind-colored chain, (b) that same red UNDER a selected
// section's accent overlay, which must not paint over it (`editor-ui.md` Kind color: priority is
// infeasible-red > selection > kind, and dash is reserved for infeasibility).
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

    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const v0 = () => page.evaluate((): number => (window as any).__kex.v0());
    const kind = () => page.evaluate((): number => (window as any).__kex.kind());
    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const sectionCount = () => page.evaluate((): number => (window as any).__kex.sectionCount());
    const sectionIds = () => page.evaluate((): number[] => (window as any).__kex.sectionIds());
    const selectedSection = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedSection());
    const startAt = () =>
        page.evaluate((): { x: number; y: number } | null => (window as any).__kex.startAt());
    // the bake's own feasibility flags (src/main.ts) — the render's input, not a pixel read.
    type Span = { first: number; count: number; section: number | null; head: number };
    const infeasibleSpan = () => page.evaluate((): Span => (window as any).__kex.infeasibleSpan());

    // the default flat seed bakes on load — the START diamond at the world origin has no shape
    // node on top of it, so it picks cleanly (the v0 flow's framing).
    await expect.poll(tTotal).toBeGreaterThan(0);

    // ── 1. Author the launch speed through the REAL START popover: 16 m/s. ──
    const canvas = page.locator("#app > canvas");
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
    await page.evaluate(() => (window as any).__kex.convert());
    await expect.poll(kind).toBe(1); // SectionKind.Force
    await expect.poll(forceCount).toBe(2); // the two seeded continuation keyframes
    await page.evaluate((s: number) => (window as any).__kex.placeForce(s, 2), FORCE_LEN / 2);
    await expect.poll(forceCount).toBe(3);

    // ── 3. Append the geo ramp — a straight two-node seed placed rigidly at the pull-up's exit,
    // so it climbs at the exit angle until the energy runs out. ──
    await page.evaluate(() => (window as any).__kex.append(0)); // SectionKind.Geo
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

    const nodeCount = () => page.evaluate((): number => (window as any).__kex.nodeCount());
    const nodeSelOrders = () =>
        page.evaluate((): number[] => (window as any).__kex.nodeSelOrders());
    const selectedOrder = () =>
        page.evaluate((): number | null => (window as any).__kex.selectedOrder());
    const poses = () => page.evaluate((): number[][] => (window as any).__kex.poses());

    await seedHill(page);
    await expect.poll(nodeCount).toBe(7);
    await page.keyboard.press("f"); // hover defaults to the viewport

    const canvas = page.locator("#app > canvas");
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
            const now = await page.evaluate(
                (os: number[]): ({ x: number; y: number } | null)[] =>
                    os.map((o) => (window as any).__kex.nodeAt(o)),
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
    const cam = () => page.evaluate((): number[] => (window as any).__kex.cam());
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
});

// Drive the TIMELINE MULTISELECT flow (kex2d-multiselect stage 6): seed an airtime force bump →
// CHART-MARQUEE selects its three interior keyframes (a real rect drag on the chartzone, excluding
// the two continuation seeds at the section's own bounds) → a per-diamond SHIFT-CLICK toggles the
// active member out (promoting the survivor) and back in → a plain-click MULTI-DRAG grabbed on a
// non-active member applies the SAME shared Δs to the whole set, RIGID-CLAMPED so the tightest
// member (nearest the section's own extent) bounds the whole group — the AE comp-start block,
// offsets preserved, then undoes clean as one entry → a right-click keeps the set and the Easing ▸
// menu's bulk preset applies to every selected NON-TERMINAL keyframe in one entry, leaving the two
// unselected seeds at their default tag → finally, WHEEL DURING A GESTURE: a wheel tick held inside
// a live chart marquee leaves the document axis exactly where it was, while the same tick at rest
// zooms (kex2d-ux-burndown stage 3, the timeline half of the one rule). Every gesture is a real pointer drag/click, located via
// the diamonds' own laid-out boxes (`.fhit`); `forceSelIds`/`forceSelActive`/`forces`/`forceEases`
// are read-only asserts.
test("timeline multiselect flow", async ({ page, boot }) => {
    await boot();

    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const forceSelIds = () => page.evaluate((): number[] => (window as any).__kex.forceSelIds());
    const forceSelActive = () =>
        page.evaluate((): number | null => (window as any).__kex.forceSelActive());
    const forces = () =>
        page.evaluate((): { s: number; g: number }[] => (window as any).__kex.forces());
    const forceEases = () => page.evaluate((): number[] => (window as any).__kex.forceEases());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    await page.evaluate(() => (window as any).__kex.seedForceBump());
    await expect.poll(forceCount).toBe(5); // the two continuation seeds + the three bump points
    await expect.poll(tTotal).toBeGreaterThan(0);
    await frameTimeline(page); // the whole section on-screen for exact diamond boxes

    const fpt = page.locator(".fpt");
    await expect(fpt).toHaveCount(5);
    const fhit = page.locator(".fhit");
    const fhitCenter = async (i: number): Promise<{ cx: number; cy: number }> => {
        const b = await fhit.nth(i).boundingBox();
        if (!b) throw new Error(`force point ${i} not laid out`);
        return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    };
    const b0 = await fhitCenter(0); // the leading seed (s=0)
    const b1 = await fhitCenter(1); // shoulder (s=0.2·len)
    const b2 = await fhitCenter(2); // the airtime crest (s=0.5·len)
    const b3 = await fhitCenter(3); // shoulder (s=0.8·len)
    const b4 = await fhitCenter(4); // the trailing seed (s=len)
    const bodyBox = await page.locator(".dock .body").boundingBox();
    if (!bodyBox) throw new Error("timeline body not laid out");
    const mid = (a: number, b: number): number => (a + b) / 2;

    // ── 1. CHART-MARQUEE the three interior keyframes: x bounded at the midpoints to the two
    // seeds, y spans the chartzone's own inner band (only x needs to exclude the seeds — they
    // sit at the section's own bounds, well outside the interior x-range regardless of g). ──
    const xLo = mid(b0.cx, b1.cx);
    const xHi = mid(b3.cx, b4.cx);
    const chartTop = bodyBox.y + CHART_TOP + 4;
    const chartBot = bodyBox.y + bodyBox.height - CHART_BOT_PAD - 4;
    await marqueeDrag(page, xLo, chartTop, xHi, chartBot);
    await expect.poll(async () => (await forceSelIds()).length).toBe(3);
    for (const i of [1, 2, 3]) await expect(fpt.nth(i)).toHaveClass(/sel/);
    for (const i of [0, 4]) await expect(fpt.nth(i)).not.toHaveClass(/sel/);
    await expect(fpt.nth(3)).toHaveClass(/active/); // the last hit — the active member
    const active1 = await forceSelActive();
    expect(active1).not.toBeNull();
    expect(await forceSelIds()).toContain(active1); // the active member is always a set member
    // stage 8 (user-locked, reverting stage 7's guard): the typed-field popover DOES open over a
    // multi-set, addressing the ACTIVE (last-selected) member exactly as on a single selection —
    // the active member is what every single-subject surface anchors to. Its two fields must read
    // that member's own values (index 3, the s=0.8·len shoulder asserted `active` above), not some
    // other member's. Mutation: re-add a `!multiForce` guard → count 0 → red.
    await expect(page.locator(".ptip")).toHaveCount(1);
    const activePt = (await forces())[3]; // one section, so its local s IS the global d
    const tipD = await page.locator('.ptip input[aria-label="Point distance (m)"]').inputValue();
    const tipG = await page.locator('.ptip input[aria-label="Point force (g)"]').inputValue();
    expect(Number(tipD)).toBeCloseTo(activePt.s, 1);
    expect(Number(tipG)).toBeCloseTo(activePt.g, 2);
    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip)
        await page.screenshot({ path: join(OUT, "multiselect-timeline-marquee.png"), clip: strip });

    // ── 2. SHIFT-CLICK the ACTIVE diamond (the s=0.8·len shoulder) toggles it OUT — the survivor
    // (the crest) promotes active — then the SAME shift-click toggles it back IN, re-activating. ──
    await page.keyboard.down("Shift");
    await page.mouse.click(b3.cx, b3.cy);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(2);
    await expect(fpt.nth(3)).not.toHaveClass(/sel/);
    await expect(fpt.nth(2)).toHaveClass(/active/); // promoted survivor
    await page.keyboard.down("Shift");
    await page.mouse.click(b3.cx, b3.cy);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(3);
    await expect(fpt.nth(3)).toHaveClass(/sel/);
    await expect(fpt.nth(3)).toHaveClass(/active/); // re-added → active again

    // ── 3. MULTI-DRAG, RIGID CLAMP: grab the CREST (a member, but NOT the active one — a plain
    // click on a set member drags the whole block without collapsing it) and drag it FAR right —
    // past the tightest member's own room. the shared Δs clamps to that member's own [0, len]: the
    // s=0.8·len shoulder has the least room (0.2·len), so it lands EXACTLY at the section's extent
    // while every member's OFFSET from the others is preserved (the AE comp-start block); the two
    // unselected seeds never move. ──
    const before = await forces();
    const clipBox = await page.locator(".clip").first().boundingBox();
    if (!clipBox) throw new Error("force clip not laid out");
    await page.mouse.move(b2.cx, b2.cy);
    await page.mouse.down();
    // 0.4·clipWidth ≈ 0.4·len in s — well past the tightest member's 0.2·len room, but still well
    // inside the clip's own box (so the pointer never leaves the viewport).
    await page.mouse.move(b2.cx + clipBox.width * 0.4, b2.cy, { steps: 12 });
    await page.mouse.up();
    const after = await forces();
    expect(after[0]).toEqual(before[0]); // the leading seed never moved — no tie possible at s=0
    const ds = after[1].s - before[1].s; // the shoulder's shift — unambiguous, nothing ties here
    expect(ds).toBeGreaterThan(2); // a real, clamped-but-substantial shift
    expect(after[2].s - before[2].s).toBeCloseTo(ds, 5); // the crest — the SAME shared offset
    const len = before[4].s; // the section's own extent, read off the pre-drag (unambiguous) snapshot
    // the clamp binds EXACTLY at the tightest member's own room: its pre-drag distance to the
    // extent equals the shared delta (the definition of "the tightest member bounds the group").
    // asserted algebraically, not by re-reading a POST-drag index — the clamped member now sits at
    // s = len, tied with the untouched trailing seed (also at len), so `after`'s sort order between
    // that pair is no longer determined by identity (a stable sort ties on the ORIGINAL entity
    // order, not which one is "the seed") — exactly the spec's accepted "no auto-merge, coincident
    // points keep current engine behavior".
    expect(before[3].s + ds).toBeCloseTo(len, 3);
    const atLen = after.filter((p) => Math.abs(p.s - len) < 1e-3);
    expect(atLen.length).toBe(2); // the seed AND the clamped member now coincide — no auto-merge
    expect(atLen.some((p) => Math.abs(p.g - before[4].g) < 1e-6)).toBe(true); // the seed's g survived
    await page.keyboard.press("Control+z"); // one entry reverts the whole group
    await expect.poll(async () => (await forces())[3].s).toBeCloseTo(before[3].s, 3);
    // …and the DIAMONDS are back where the cached boxes say. The undo writes authored `s` in place
    // (no respawn), so the poll above is satisfied a frame before the per-RAF tick re-projects the
    // DOM — right-clicking the cached `b2` on that evidence lands 0.4·clipWidth away on empty chart
    // and opens no menu (reproduced 2/2 on full 4-worker runs). Same law as the viewport flow's
    // move-undo: after an IN-PLACE restore, wait for the projection to land back on the target.
    await expect
        .poll(async () => {
            const b = await fhit.nth(2).boundingBox();
            return b !== null && Math.abs(b.x + b.width / 2 - b2.cx) < 1;
        })
        .toBe(true);

    // ── 4. BULK EASING: right-click a member (the crest, keeping the set) → the Easing ▸ preset
    // applies to every SELECTED NON-TERMINAL keyframe (all three interior points — none is the
    // section's last) in one entry; the two UNSELECTED seeds keep their default tag. ──
    expect((await forceEases())[1]).toBe(1); // Easing.Cubic, the fresh-seed default
    await page.mouse.click(b2.cx, b2.cy, { button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Quintic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    const eased = await forceEases();
    expect(eased[1]).toBe(2); // Easing.Quintic — the s=0.2·len shoulder, bulk-applied
    expect(eased[2]).toBe(2); // the crest
    expect(eased[3]).toBe(2); // the s=0.8·len shoulder
    expect(eased[0]).toBe(1); // the leading seed — NOT selected, untouched
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await forceEases())[1]).toBe(1);

    // ── 5. WHEEL IS A NO-OP DURING A LIVE GESTURE (kex2d-ux-burndown stage 3) — the timeline half
    // of the one rule; the viewport half rides the viewport multiselect flow, and both surfaces
    // guard on the same `editor.dragging` flag. A live gesture reads its cursor against the
    // document axis, so a mid-drag zoom moves the surface under its own gesture. The chart marquee
    // drives it (it authors nothing, and — unlike the viewport's — it takes capture only PAST the
    // dead zone, so `data-dragging` here is a real armed gesture, not a mere pointerdown; the flip
    // side is that this surface's pre-dead-zone press is the one window the guard leaves open, and
    // it is deliberately not asserted). The idle wheel after release is the positive control (and
    // is what proves the mid-gesture tick reached this surface). Mutation: drop the `editor.dragging`
    // early-return in `Timeline.svelte` `onWheel` → the held view zooms → red (proven against that
    // build: `[pan, pxPerM]` [0, 16.20] → [638.12, 45.83] under the held marquee). ──
    const xView = () => page.evaluate((): number[] => (window as any).__kex.xView());
    const rest = await xView();
    await page.mouse.move(xLo, chartTop);
    await page.mouse.down();
    await page.mouse.move(xHi, chartBot, { steps: 6 }); // past the dead zone → the marquee arms
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1); // the gesture IS live
    await page.mouse.wheel(0, -600); // a zoom-in tick a resting chart would answer
    await frames(page, 2); // the wheel is dispatched, not awaited — let any write land
    expect(await xView()).toEqual(rest);
    await page.mouse.up();
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => (await xView())[1]).toBeGreaterThan(rest[1]);
});
