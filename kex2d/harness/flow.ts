import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test as base } from "@playwright/test";

// kex2d's capture-flow staged helpers module. Past ~28 flows the harness rule (`kex2d-harness.md`
// "Growth") calls for splitting the single `shot.pw.ts` into staged flow files + one staged helpers
// module — this file. Every flow boots the page, drives one authoring surface through REAL pointer
// and keyboard events, asserts the resulting state through the DEV-only `window.__kex` hook
// (src/main.ts — read-only for the asserts; it performs an op only where a gesture can't reach the
// setup), and screenshots what it built. Screenshots land in KEX_OUT (a Windows path when staged;
// copied back). Each flow file's own tests carry their own header saying what they drive and what
// they pin.

// Env knobs, validated not coerced: `capture.ts` forwards values it has already checked, and these
// guards cover a direct `playwright test` run. This file is staged to the Windows host STANDALONE
// (`wsl.ts`) alongside every `*.pw.ts` flow file, so it can import nothing: `UsageError` and
// `intEnv` are MIRRORED VERBATIM from `harness/args.ts`, and `tests/harness.test.ts` pins them
// character-identical to it — a drifting copy is a guard that only LOOKS enforced.
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
export const OUT = process.env.KEX_OUT ?? "shots";

// The ONE fixed wait left in this file, and it is cosmetic: a shot taken the frame a surface
// appears catches it mid-fade (popovers fade in over 120ms, transitions run ~150ms on the shared
// easing token). Nothing deterministic is bought past that — the cart LOOPS, so the scene never
// settles — so this is used only immediately before a screenshot. Every other wait here is a
// condition (`coding.md` forbids sleep-as-condition-wait).
export const SHOT_MS = intEnv(process.env, "KEX_SHOT_MS", 300, 0, 60_000);

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

export const test = base.extend<{ boot: Boot }>({
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

export { expect, join };
export type { Page };

// Layout constants MIRRORED from the app, because this file is staged to the host STANDALONE
// (`wsl.ts`) and so can import nothing from `src/`. Each names its source; a change there is a
// change here.
export const CHART_TOP = 46; // RULER_H (26) + GAP_H (20) — Timeline.svelte, the chartzone's own top
export const CHART_BOT_PAD = 8; // BOT_PAD — Timeline.svelte
// The viewport's default framing centers the world origin in the region above the dock, not in the
// canvas — src/view.ts DOCK_RESERVE = DOCK_HEIGHT (240) + DOCK_INSET (16), read by App.svelte.
export const DOCK_RESERVE = 256;
export const FORCE_LEN = 24; // MIRRORS src/track.ts DEFAULT_FORCE_LEN (= EXTEND_DIST) — a force
// section's extent on convert/append, so mid-extent is FORCE_LEN / 2.
export const RADIAL_R = 46; // MIRRORS src/radial.ts RADIAL_R — the knob orbit (see `knobCenter` below)
export const TIP_REACH = 68; // TIP_H (56) + TIP_GAP (12) — Timeline.svelte, the vertical room a popover needs
export const GROW_LO = -3; // Timeline.svelte GROW_CAP[0] = BAND[0] (−2) − GROW_HEADROOM (1) — the growth floor
// The shipped manipulator snap quanta as the popover DISPLAYS them — src/settings.ts
// ANGLE_STEP_DEFAULT (5°, stored in radians) and LENGTH_STEP_DEFAULT (1 m), plus the range ends the
// fields clamp to: ANGLE_STEP_MIN (1°) / ANGLE_STEP_MAX (180°).
export const SNAP_DEG = "5";
export const SNAP_LEN = "1";
export const SNAP_DEG_MIN = "1";
export const SNAP_DEG_MAX = "180";

// The `window.__kex` DEV harness hook's shape — a hand-written mirror of its two sources
// (src/main.ts's `__kex` object literal + Timeline.svelte's `k.gRange`/`k.xView` augmentation),
// covering only the members the flows below actually call. This file can import nothing from
// `src/` (the standalone-staging law above), so the interface can't be `typeof` the real hook —
// a drift between the two shows up as a flow calling a member this type doesn't have, TS-checked
// here but not cross-validated against `main.ts`'s literal by any test.
export interface Kex {
    append(kind: number): number;
    basis(): string;
    cam(): [number, number, number];
    cartArc(): number | null;
    convert(): void;
    convertAt(i: number): void;
    deleteAt(i: number): boolean;
    editing(): boolean;
    forceCount(): number;
    forceEases(): number[];
    forceEditing(): boolean;
    forceHandleSel(): string | null;
    forceSelActive(): number | null;
    forceSelIds(): number[];
    forceU(): { id: number; s: number; u: number }[];
    forceTangents(): (null | {
        mode: number;
        inOn: boolean;
        inDs: number;
        inDg: number;
        outOn: boolean;
        outDs: number;
        outDg: number;
    })[];
    forces(): { s: number; g: number }[];
    gRange(): [number, number];
    guides(): { ray: boolean; angle: string | null; length: string | null };
    infeasibleSpan(): { first: number; count: number; section: number | null; head: number };
    kind(): number;
    nodeAt(order: number): { x: number; y: number } | null;
    nodeCount(): number;
    nodeSelOrders(): number[];
    parked(): boolean;
    placeForce(s: number, g: number): number;
    poses(): number[][];
    sectionCount(): number;
    sectionForceCounts(): number[];
    sectionIds(): number[];
    sectionKinds(): number[];
    sectionLengths(): number[];
    sectionSteps(): number[];
    seedForceBump(): void;
    seedForceStress(): void;
    seedHill(): void;
    seedTwinHill(): void;
    selectEnd(): void;
    selectedOrder(): number | null;
    setV0(v: number): void;
    selectedSection(): number | null;
    startAt(): { x: number; y: number } | null;
    tTotal(): number;
    tangent(): { mode: number; inX: number; inY: number; outX: number; outY: number } | null;
    tangentHandles(): { side: string; x: number; y: number }[];
    undoDepth(): number;
    v0(): number;
    xView(): [number, number];
}

// The one typed accessor every flow calls `__kex` through, instead of an ad-hoc `(window as
// any).__kex.foo()` cast at each call site: a single method name + its args cross into the page,
// typed end to end by `Kex` above. One round trip per call, matching what the casts did before.
// The one place that stays a raw inline cast is a batched in-page read (several `__kex` calls in
// one `page.evaluate`, to save round trips) — this helper is for the single-accessor case.
export function kexCall<K extends keyof Kex>(
    page: Page,
    method: K,
    ...args: Parameters<Kex[K]>
): Promise<ReturnType<Kex[K]>> {
    return page.evaluate(
        ({ method, args }) =>
            (
                (window as unknown as { __kex: Kex }).__kex[method] as (
                    ...a: unknown[]
                ) => ReturnType<Kex[K]>
            )(...args),
        { method, args },
    );
}

// two laid-out DOM rects overlap iff they intersect on BOTH axes — the popover-vs-workspace
// no-overlap assert reads the real rendered boxes (a selector test proves nothing about where a
// box actually paints).
export type Rect = { x: number; y: number; width: number; height: number };
export function overlaps(a: Rect, b: Rect): boolean {
    return (
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    );
}

// The rect every timeline shot clips to: the bottom band of the viewport, full width. Taller than
// the dock itself (DOCK_RESERVE) so the strip sits inside the frame with the chart's upper reaches
// above it. Null when the page reports no viewport size — the guard each caller wraps its shot in.
export const STRIP_H = 340;
export function dockStrip(page: Page): Rect | null {
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
export function frames(page: Page, n = 1): Promise<void> {
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
// flake; measured 1/10 by logging `nodeAt(6)` against `startAt()` right before the chain-end
// right-click). Being off the origin is exactly the condition the pointer needs, so poll
// for it and never cache a node point across a respawning edit.
//
// It establishes NOTHING after an IN-PLACE write (`restoreNodes`: a move/nudge undo, a gesture
// cancel) — `Handle.sample` is untouched there, so the predicate is already true against the
// pre-undo bake and this hands back a stale point. Wait on the bake landing on the expected
// geometry instead (the group-nudge undo, `viewport multiselect flow`).
export async function nodePoint(page: Page, order: number): Promise<{ x: number; y: number }> {
    // the polled read is the one that gets RETURNED — re-reading after the poll would hand back a
    // second, unvalidated evaluation (a fresh edit landing between the two is exactly the stale
    // point this helper exists to prevent).
    let seen: { x: number; y: number } | null = null;
    await expect
        .poll(async () => {
            const [p, origin] = await Promise.all([
                kexCall(page, "nodeAt", order),
                kexCall(page, "startAt"),
            ]);
            seen = p && origin && Math.hypot(p.x - origin.x, p.y - origin.y) > 1 ? p : null;
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
//
// `hook` picks WHICH seed: the default single hill, or `seedTwinHill` — two of them back to back,
// the shape the invoked-solve flow converts (one hill solves in ~0.1s, under a single frame of
// modal). Same bake wait either way.
export async function seedHill(
    page: Page,
    hook: "seedHill" | "seedTwinHill" = "seedHill",
): Promise<void> {
    const tTotal = (): Promise<number> => kexCall(page, "tTotal");
    await expect.poll(tTotal).toBeGreaterThan(0); // the flat seed's bake, before the poke
    const flat = await tTotal();
    await kexCall(page, hook);
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
export const RING_TOL = 2;
export async function knobCenter(
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
export async function frameTimeline(page: Page): Promise<void> {
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
    const sections = await kexCall(page, "sectionCount");
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
export async function clickFlyout(
    page: Page,
    menu: string,
    parent: string,
    item: string,
): Promise<void> {
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
export async function clickMenuItem(page: Page, menu: string, item: string): Promise<void> {
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
export async function marqueeDrag(
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
