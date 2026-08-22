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
// The velocity-strip HEADER band's own row — RULER_H (26) + GAP_H (20) is
// its top, HBAND_H (8) its height; CHART_TOP is the sum, the chartzone's own top past it.
export const HBAND_TOP = 46;
export const HBAND_H = 8;
export const CHART_TOP = HBAND_TOP + HBAND_H; // Timeline.svelte
export const CHART_BOT_PAD = 8; // BOT_PAD — Timeline.svelte
export const LEFT_GUT = 44; // Timeline.svelte — the chart's left inset, s=0's own screen x
// The viewport's default framing centers the world origin in the region above the dock, not in the
// canvas — src/view.ts DOCK_RESERVE = DOCK_HEIGHT (240) + DOCK_INSET (16), read by App.svelte.
export const DOCK_RESERVE = 256;
export const FORCE_LEN = 24; // MIRRORS src/track.ts DEFAULT_FORCE_LEN (= EXTEND_DIST) — a force
// section's extent on convert/append, so mid-extent is FORCE_LEN / 2.
// The whole-track sample budget, in metres of the nominal step — MIRRORS src/track.ts MAX_SAMPLES
// (4096) × DS_NOMINAL (0.5 m). A force section longer than this runs off the end of the flat SoA,
// which is the one PERSISTENT state the domain conversion cannot run on (its arc↔time window reads
// samples that were never written), so it is how a flow reaches the grayed ruler row.
export const SAMPLE_BUDGET_M = 2048;
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
    cam(): [number, number, number];
    cartArc(): number | null;
    convert(): void;
    convertAt(i: number): void;
    ctxCut(): { at: number; t?: number } | null;
    deleteAt(i: number): boolean;
    domain(): string;
    editing(): boolean;
    forceCount(): number;
    forceEases(): number[];
    forceEditing(): boolean;
    forceHandleSel(): string | null;
    forceSelActive(): number | null;
    forceSelIds(): number[];
    forceU(): { id: number; section: number; s: number; g: number; u: number }[];
    forceTangents(): (null | {
        mode: number;
        inOn: boolean;
        inDs: number;
        inDg: number;
        outOn: boolean;
        outDs: number;
        outDg: number;
    })[];
    forceMarkerAt(i: number): { x: number; y: number } | null;
    forces(): { s: number; g: number }[];
    friction(): number;
    ghostPx(): { x0: number; x1: number }[];
    gRange(): [number, number];
    vRange(): [number, number];
    stripKfPx(): { id: number; x: number; y: number }[];
    hoverForceId(): number | null;
    guides(): { ray: boolean; angle: string | null; length: string | null };
    infeasibleSpan(): { first: number; count: number; section: number | null; head: number };
    entries(): { x: number; y: number; theta: number; v: number }[];
    kind(): number;
    landing(): boolean;
    lockedCount(): number;
    sandboxDepth(): number | null;
    nodeAt(order: number): { x: number; y: number } | null;
    nodeCount(): number;
    nodeSelOrders(): number[];
    pinning(): boolean;
    parked(): boolean;
    placeForce(s: number, g: number): number;
    poses(): number[][];
    resistance(): number;
    sectionCount(): number;
    sectionForceCounts(): number[];
    sectionIds(): number[];
    sectionKinds(): number[];
    sectionLengths(): number[];
    seedForceBump(): void;
    seedForceStress(): void;
    seedHill(): void;
    seedTwinHill(): void;
    selectEnd(): void;
    selectedOrder(): number | null;
    setLen(i: number, len: number): void;
    setV0(v: number): void;
    selectedSection(): number | null;
    selectedStrip(): number | null;
    stripsOf(i: number): { id: number; start: number; end: number; value: number }[];
    stripKeyframesOf(stripId: number): { id: number; s: number; v: number }[];
    spanMidAt(i: number): { x: number; y: number } | null;
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
    const hit = await menuHit(page, x, y);
    expect(
        hit?.text,
        `flyout item "${item}" must be hit-testable at its own center (not clipped out of paint)`,
    ).toBe(item);
    await page.mouse.click(x, y); // coordinate click a real pointer can land
}

// The reachability read every menu assert shares: which menu row a REAL pointer lands on at this
// page point. `null` where the point resolves to no row at all. `text` is the row's whole rendered
// text (label plus any shortcut), `label` the label alone — a caller picks the one its own match
// needs. One home, so the three call sites below can't drift into three different notions of
// "reachable" (this is the assert that caught the submenu-clip bug; a selector `.click()` fires
// handlers on elements clipped out of paint AND hit-testing).
async function menuHit(
    page: Page,
    x: number,
    y: number,
): Promise<{ text: string; label: string } | null> {
    return page.evaluate(
        (p: { x: number; y: number }) => {
            const row = document.elementFromPoint(p.x, p.y)?.closest(".menu-item");
            if (!row) return null;
            return {
                text: (row.textContent ?? "").trim(),
                label: (row.querySelector("span")?.textContent ?? "").replace(/\s+/g, " ").trim(),
            };
        },
        { x, y },
    );
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
    const hit = await menuHit(page, x, y);
    expect(
        hit?.text.startsWith(item) ?? false,
        `menu item "${item}" must be hit-testable at its own center (not clipped out of paint)`,
    ).toBe(true);
    await page.mouse.click(x, y);
}

// ── the rendered-DOM cross-check against the REAL builders (kex2d-menu-grammar decision 8).
//
// The source of truth is `src/menus.ts` itself, not a copy of it here: this file is staged to the
// Windows host standalone and so can't IMPORT app source, but the page it drives is served by the
// vite dev server, so the PAGE imports the real modules at runtime (`/src/menus.ts`, `/src/menu.ts`
// — `menus.ts` is module-graph pure, gated by `tests/menu.test.ts`, so pulling it in costs
// nothing). A hand-typed expected sequence would make a builder reorder plus a matching hand-edit
// here silently green, which is the exact drift this stage exists to close.
//
// What it adds over the pure oracle: the oracle proves every builder obeys the grammar; this proves
// `Menu.svelte` TRANSMITS it — each row's `data-group` published, rows in the builder's order, the
// dividers derived where `menuRows` puts them, `enabled`/`checked` rendered as the native
// `disabled` attribute and the `checked` CSS class — and that every rendered row is REACHABLE by a
// real pointer, at the root and inside each flyout. `enabled`/`checked` matter here specifically
// because they're invisible to every OTHER gate: a wiring bug that always derives `enabled: true`
// still passes the pure grammar oracle (each state in the matrix is still internally consistent)
// and every label/group/separator assert here, so only comparing the DOM's actual disabled/checked
// state against the builder's own answer for the SAME descriptor catches it.

export type MenuRow = {
    label: string;
    group: string | null;
    separator: boolean;
    disabled: boolean;
    checked: boolean;
};

/** how a flow names the menu it opened, so the page can rebuild it from the real builder. */
export type MenuSpec = {
    /** the export name in `src/menus.ts`. */
    builder: string;
    /** the descriptor the surface derives, field for field — `null` for a builder that takes only
     *  actions (`appendMenu`). Enum-valued and function-valued fields go in `enums` / `fns`. */
    state: Record<string, unknown> | null;
    /** enum-valued descriptor fields, named `<module>.<Enum>.<Member>` and resolved from the real
     *  module in the page — never a mirrored numeric literal, which is what a staged copy would
     *  otherwise force. */
    enums?: Record<string, string>;
    /** descriptor fields the builder CALLS (the easing glyph resolvers). Stubbed in the page: a
     *  glyph is a `d` string, invisible to the label/group/divider sequence asserted here. */
    fns?: string[];
};

type MenuLevel = { path: string[]; rows: MenuRow[] };
// `levels`: one entry per menu level the flow can OPEN — the root, then each enabled submenu
// parent (a disabled parent's flyout can't be hovered open, so it makes no claim).
// `parents`: every child-bearing row, enabled or not — which rows must NOT be hovered when the
// walk wants a flyout CLOSED again.
type MenuAnswer = { levels: MenuLevel[]; parents: string[] };

/** the builder's own answer for this descriptor, computed in the page against the real modules. */
async function builderAnswer(page: Page, spec: MenuSpec): Promise<MenuAnswer> {
    return page.evaluate(
        async (s: MenuSpec & { menusUrl: string; menuUrl: string }): Promise<MenuAnswer> => {
            type Item = { [k: string]: unknown };
            const menus = await import(s.menusUrl);
            const { menuRows } = await import(s.menuUrl);
            const build = menus[s.builder];
            if (typeof build !== "function")
                throw new Error(`src/menus.ts exports no builder "${s.builder}"`);
            // every action is a no-op: the ROWS are what's asserted here, and each row's action
            // binding is pinned by the pure characterization suite.
            const actions = new Proxy({}, { get: () => () => {} });
            let items: Item[];
            if (s.state === null) items = build(actions);
            else {
                const state: Record<string, unknown> = { ...s.state };
                for (const [field, path] of Object.entries(s.enums ?? {})) {
                    const [mod, name, member] = path.split(".");
                    const value = (await import(`/src/${mod}.ts`))[name]?.[member];
                    if (value === undefined) throw new Error(`no enum member ${path}`);
                    state[field] = value;
                }
                for (const field of s.fns ?? []) state[field] = () => "";
                items = build(state, actions);
            }
            const answer: MenuAnswer = { levels: [], parents: [] };
            const walk = (path: string[], rows: Item[]): void => {
                answer.levels.push({
                    path,
                    rows: menuRows(rows).map((r: Item) =>
                        r.separator
                            ? {
                                  label: "",
                                  group: null,
                                  separator: true,
                                  disabled: false,
                                  checked: false,
                              }
                            : {
                                  label: (r.label as string) ?? "",
                                  group: (r.group as string) ?? null,
                                  separator: false,
                                  disabled: r.enabled === false,
                                  checked: r.checked === true,
                              },
                    ),
                });
                for (const row of rows) {
                    if (!row.children) continue;
                    answer.parents.push(row.label as string);
                    if (row.enabled !== false)
                        walk([...path, row.label as string], row.children as Item[]);
                }
            };
            walk([], items);
            return answer;
        },
        { ...spec, menusUrl: "/src/menus.ts", menuUrl: "/src/menu.ts" },
    );
}

// One menu level as RENDERED, in paint order, with each row's own center so reachability is read
// from the same pass. `depth` selects the level: 0 is the root `.menu-rows`, each step down is the
// open flyout's own (one flyout is open at a time, so the descendant selector is unambiguous).
async function domLevel(
    page: Page,
    menu: string,
    depth: number,
): Promise<(MenuRow & { x: number; y: number })[]> {
    const sel = `${menu}${" .submenu".repeat(depth)} > .menu-rows`;
    return page.evaluate((s: string) => {
        const rows = document.querySelector(s);
        if (!rows) throw new Error(`no menu rows at "${s}"`);
        return [...rows.children].map((el) => {
            const b = el.getBoundingClientRect();
            const separator = el.getAttribute("role") === "separator";
            return {
                label: (el.querySelector("span")?.textContent ?? "").replace(/\s+/g, " ").trim(),
                group: el.getAttribute("data-group"),
                separator,
                // native `disabled` and `Menu.svelte`'s own `class:checked` are the real DOM
                // signals `Menu.svelte` already renders `enabled`/`checked` through — no new
                // attribute needed, so a builder/renderer drift on EITHER channel is visible here
                // exactly the way `data-group` already catches a drift on ordering.
                disabled: !separator && el.hasAttribute("disabled"),
                checked: !separator && el.classList.contains("checked"),
                x: b.x + b.width / 2,
                y: b.y + b.height / 2,
            };
        });
    }, sel);
}

/**
 * Assert the open menu's rendered DOM — every level of it — is exactly what the real builder says,
 * and that a real pointer reaches every row. Flyouts are opened by REAL hover, the way a user opens
 * them (`clickFlyout`'s model), so the within-group divider inside `Easing ▸` is DOM-verified too.
 * Leaves the menu with no flyout open and the pointer off it, so a screenshot after this call sees
 * the same menu it would have seen before.
 */
export async function menuGrammar(page: Page, menu: string, spec: MenuSpec): Promise<void> {
    const { levels, parents } = await builderAnswer(page, spec);
    for (const { path, rows } of levels) {
        const where = `${menu}${path.map((p) => ` ▸ ${p}`).join("")}`;
        for (let d = 0; d < path.length; d++) {
            const scope = `${menu}${" .submenu".repeat(d)}`;
            await page
                .locator(scope)
                .first()
                .getByRole("menuitem", { name: path[d], exact: true })
                .hover();
        }
        const actual = await domLevel(page, menu, path.length);
        expect(
            actual.map((r) => ({
                label: r.label,
                group: r.group,
                separator: r.separator,
                disabled: r.disabled,
                checked: r.checked,
            })),
            `${where} — the rendered rows must be the builder's rows, dividers included, enabled/checked matching too`,
        ).toEqual(rows);
        for (const row of actual.filter((r) => !r.separator)) {
            const hit = await menuHit(page, row.x, row.y);
            expect(
                hit?.label,
                `${where} — "${row.label}" must be hit-testable at its own center (a row clipped out of hit-testing renders fine and can't be clicked)`,
            ).toBe(row.label);
        }
    }
    // close any flyout the walk opened — hovering a sibling LEAF is what closes one — then take the
    // pointer off the menu so no CSS hover survives into a screenshot taken after this call.
    if (levels.length > 1) {
        const root = await domLevel(page, menu, 0);
        const leaf = root.find((r) => !r.separator && !parents.includes(r.label));
        if (!leaf) throw new Error(`${menu} is all submenu parents — no leaf to close a flyout on`);
        await page.mouse.move(leaf.x, leaf.y);
        await expect(page.locator(`${menu} .submenu`)).toHaveCount(0);
    }
    await page.mouse.move(0, 0);
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
