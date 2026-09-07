// kex2d's S1 freshness arm — the deterministic, enumerated pin for the class of `__kex` hooks
// that read a `$derived` behind `void tick` and must read FRESH after a synchronous ECS create.
//
// The defect (commit 7579c25): `stripKfPx` was changed to call
// `computeStripKfPts(bandStrips, spans, ecs)` for freshness — but `bandStrips` and `spans` are
// still `$derived` behind `void tick`. So the hook read FRESH keyframes (from
// `stripKeyframes(ecs, s.id)`, a direct ECS query) projected against a STALE strip layout (from
// the cached `bandStrips`/`spans` `$derived`) — a mixed-freshness snapshot. On a keyframe
// create that is harmless (the strip set does not change). On a flow that has just moved or
// widened a strip it is wrong: the strip's `start`/`end` in the stale `bandStrips` are from the
// previous frame, so the strip's band positions (`u0`/`u1`) are wrong — the returned pixel is
// not where the band is drawn. The same hazard applies to `forceU` via `computeForcePts(clips,
// spans, ecs)`, where `clips` is the tick-gated list, and to `stripPx` via `bandStrips`.
//
// The fix: extract `computeClips` and `computeBandStrips` as shared pure functions (the same
// extraction pattern as `computeStripKfPts`/`computeForcePts`). The hook computes its WHOLE
// snapshot fresh from the ECS — a FRESH `sectionSpans(ecs, eid)` call feeds FRESH
// `computeClips` and `computeBandStrips` calls, so strips and keyframes are projected against
// the SAME fresh span table, never one fresh and one stale. The render path's `void tick`
// pacing is untouched (the `$derived` values still exist and still pace per-RAF).
//
// ── ENUMERATION ──
//
// Every `__kex` hook in the `onMount` block that reads a `$derived` behind `void tick`:
//
//   1. `domain`    — reads `domain`     ($derived.by, void tick)
//   2. `forceU`    — reads `forcePts`   ($derived.by, void tick)  ← MUST-READ-FRESH
//   3. `dOf`       — reads `mapping`    ($derived.by, void tick) and `domain`
//   4. `uOf`       — reads `mapping`    ($derived.by, void tick) and `domain`
//   5. `dOfTrim`   — reads `mapping`    ($derived.by, void tick) and `domain`
//   6. `ghostPx`   — reads `ghostSpans` ($derived.by, void tick)
//   7. `stripKfPx` — reads `stripKfPts` ($derived.by, void tick)  ← MUST-READ-FRESH
//   8. `stripPx`   — reads `bandStrips`  ($derived.by, void tick)  ← MUST-READ-FRESH
//   9. `uTotal`    — reads `uTotal`      ($derived, chains through `sTotal`→`curve`→void tick)
//  10. `stallU`    — reads `stallU`      ($derived.by, void tick)
//
// MUST-READ-FRESH set: { `forceU`, `stripKfPx`, `stripPx` }
//
//   `forceU`: a capture flow creates a force keyframe via `placeForce` (a synchronous ECS write
//   through `createForce`) and immediately reads `forceU` to get the new keyframe's pixel
//   position — `harness/force.pw.ts:2004-2009` does exactly this. If `forceU` reads the stale
//   `forcePts` `$derived`, the new keyframe is absent.
//
//   `stripKfPx`: a capture flow creates a strip keyframe via `chartCreate`'s synchronous ECS
//   write and immediately reads `stripKfPx` to get the new keyframe's pixel position. If
//   `stripKfPx` reads the stale `stripKfPts` `$derived`, the new keyframe is absent.
//
//   `stripPx`: a capture flow moves a strip via a synchronous ECS write (`widenStrip`) and
//   immediately reads `stripPx` to get the strip's band pixel positions. If `stripPx` reads
//   the stale `bandStrips` `$derived`, the strip's band positions are wrong — the stale layout
//   has the old `start`/`end`, so the returned `x0` is not where the band is drawn after the
//   move.
//
// EXCLUDED hooks and their reasons:
//
//   `domain`: no capture flow changes the track's domain (time/distance) via a synchronous ECS
//   write and then immediately reads this hook. Domain changes are user UI actions that go
//   through the ruler context menu, not synchronous ECS writes in a capture flow.
//
//   `dOf`, `uOf`, `dOfTrim`: these read the s↔t mapping (`mapping`), which changes only when the
//   BAKE changes — and the bake is paced by `void tick`, not a synchronous ECS write. Creating a
//   keyframe does not change the bake's sample tables, so the cached `mapping` is still correct.
//
//   `ghostPx`: reads `ghostSpans` (the ghost strip's screen px). Ghost strips are transient UI
//   elements shown during a drag gesture, not created via a synchronous ECS write in a capture
//   flow.
//
//   `uTotal`: reads the total chart extent, which changes only when the bake's curve changes
//   (`sTotal`→`curve`→`void tick`). Creating a keyframe does not change the bake.
//
//   `stallU`: reads the first-infeasible sample's axis reading, which changes only when the
//   bake changes. Creating a keyframe does not change the bake.
//
// ── POSITION ASSERTION ──
//
// The presence arm asserts the hook's output INCLUDES the newly-created keyframe (by id) and
// that the counts match. That is presence, not behavior — the exact shape the spec's Locked
// decision bans as a parity oracle — and it is why a 6/8 pixel regression passed it three
// times green. The position arm asserts the hook's projected POSITION is the position the
// render actually draws, in a state where the stale and fresh snapshots differ.
//
// State construction: move a strip synchronously via `widenStrip` (a direct ECS write that
// changes `Strip.start`/`Strip.end`, which changes the bake hash). The tick-gated `$derived`
// values (`bandStrips`, `spans`, `clips`) are now stale — they hold the previous frame's strip
// geometry. The hook is read in the SAME `page.evaluate` (no intervening RAF). After RAF, the
// `$derived` values re-evaluate and the hook is read again. On the unfixed hook (7579c25), the
// before-RAF read uses stale `bandStrips` (old `start`/`end`), so the strip's `x0` differs from
// the after-RAF read (fresh `bandStrips`, new `start`/`end`). On the fixed hook, both reads
// compute fresh from the ECS, so `x0` matches.
//
// ── FRAME-BOUND FINDING ──
//
// `stripKfPx`'s keyframe position is `toGlobal(spanTable, s.section, k.s)` + `uOfLen(d)`. On
// Distance domain with section 0, this is `k.s` — the keyframe's own section-local arclength,
// which is always fresh from the ECS. The position does NOT depend on the strip's `start`/`end`
// (which is what the fix makes fresh). It depends on `spans` (via `toGlobal`), which reads
// `bakeOut` — a module-level Map updated only by `BakeSystem.update()` on RAF tick. There is no
// synchronous bake path. So `bakeOut` (and therefore `spans`, `mapping`) is unavoidably
// frame-bound: between RAF ticks, `sectionSpans(ecs, eid)` returns the same stale data as the
// `spans` `$derived`. The fix cannot make the keyframe position fresh in the `bakeOut` sense;
// it makes the strip set fresh (from `sectionStrips`), so the hook's snapshot is internally
// consistent (strips and keyframes from the same ECS read), but the span table is still the
// last RAF's. This is a real finding: the keyframe position's dependence on `bakeOut` is
// frame-bound, and the fix addresses the strip-layout half (the half that was mixed), not the
// span-table half (which is consistently stale on both fixed and unfixed, and consistently
// fresh on both after RAF). The `stripPx` position arm witnesses the strip-layout half; the
// `stripKfPx` position arm cannot witness it because the keyframe position does not depend on
// the strip layout.
//
// Usage: bun run capture -- -g "__kex hook freshness"

import { test, expect, kexCall, seedHill, frameTimeline, frames } from "./flow";

// ── PRESENCE ARM ──
//
// For each hook in the MUST-READ-FRESH set, create a keyframe via a synchronous ECS write and
// immediately read the hook AND a direct ECS reading in the SAME `page.evaluate` (no
// intervening RAF). Assert the hook's output includes the newly-created keyframe —
// deterministic because both readings are taken in one synchronous JS execution.

test("__kex hook freshness — stripKfPx reads ECS-direct after synchronous create", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await kexCall(page, "convert"); // → a force section so the chart carries force keyframes
    await kexCall(page, "seedForceBump");
    await frameTimeline(page);

    // Create a strip so we have a strip to add keyframes to.
    const beforeStrips = (await kexCall(page, "stripsOf", 0)) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const stripX = clipBb.x + clipBb.width * 0.6;
    await page.mouse.click(stripX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toHaveCount(1);
    const items = page.locator(".smenu .menu-item");
    const count = await items.count();
    let added = false;
    for (let i = 0; i < count; i++) {
        const text = await items.nth(i).textContent();
        if (text?.includes("Add velocity strip")) {
            await items.nth(i).click();
            added = true;
            break;
        }
    }
    if (!added) throw new Error("Add velocity strip menu item not found");
    await expect
        .poll(async () => (await kexCall(page, "stripsOf", 0)).length)
        .toBe(beforeStrips.length + 1);
    const strips = (await kexCall(page, "stripsOf", 0)) as {
        id: number;
        start: number;
        end: number;
    }[];
    const beforeStripIds = new Set(beforeStrips.map((s) => s.id));
    const strip = strips.find((s) => !beforeStripIds.has(s.id));
    if (!strip) throw new Error("newly-created strip not found");

    // Let `bandStrips` (a `$derived` behind `void tick`) propagate the new strip.
    await frames(page, 2);

    // THE ARM: create a strip keyframe via `placeStripKf` (synchronous ECS write) and
    // immediately read `stripKfPx` AND `stripKeyframesOf` in the SAME `page.evaluate` — no
    // intervening RAF. Assert the hook's output includes the newly-created keyframe.
    const sLocal = (strip.start + strip.end) / 2;
    const allStripIds = ((await kexCall(page, "stripsOf", 0)) as { id: number }[]).map((s) => s.id);
    const result = await page.evaluate(
        ({ stripId, s, v, allIds }) => {
            const kex = (
                window as unknown as { __kex: Record<string, (...a: unknown[]) => unknown> }
            ).__kex;
            const newId = kex.placeStripKf(stripId, s, v) as number;
            const hookPx = kex.stripKfPx() as { id: number; x: number; y: number }[];
            const ecsIds: number[] = [];
            for (const sid of allIds) {
                const kfs = kex.stripKeyframesOf(sid) as { id: number }[];
                ecsIds.push(...kfs.map((k) => k.id));
            }
            return { newId, hookIds: hookPx.map((p) => p.id), ecsIds };
        },
        { stripId: strip.id, s: sLocal, v: 8, allIds: allStripIds },
    );

    expect(
        result.hookIds,
        `stripKfPx did not include the freshly-created keyframe ${result.newId} — the hook read a stale $derived (hook: ${result.hookIds.join(",")}, ecs: ${result.ecsIds.join(",")})`,
    ).toContain(result.newId);
    expect(result.ecsIds).toContain(result.newId);
    expect(result.hookIds.length).toBe(result.ecsIds.length);
});

test("__kex hook freshness — forceU reads ECS-direct after synchronous create", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await kexCall(page, "convert"); // → a force section
    await kexCall(page, "seedForceBump");
    await frameTimeline(page);

    const beforeCount = await kexCall(page, "forceCount");
    const sectionLen = (await kexCall(page, "sectionLengths")) as number[];
    const len = sectionLen[0] ?? 24;

    const result = await page.evaluate(
        ({ s, g }) => {
            const kex = (
                window as unknown as { __kex: Record<string, (...a: unknown[]) => unknown> }
            ).__kex;
            const newId = kex.placeForce(s, g) as number;
            const hookU = kex.forceU() as {
                id: number;
                section: number;
                s: number;
                g: number;
                u: number;
            }[];
            const ecsCount = kex.forceCount() as number;
            return { newId, hookIds: hookU.map((p) => p.id), ecsCount };
        },
        { s: len * 0.5, g: 0.5 },
    );

    expect(
        result.hookIds,
        `forceU did not include the freshly-created keyframe ${result.newId} — the hook read a stale $derived (hook: ${result.hookIds.join(",")})`,
    ).toContain(result.newId);
    expect(result.ecsCount).toBe((beforeCount as number) + 1);
    expect(result.hookIds.length).toBe(result.ecsCount);
});

// ── POSITION ARM (the strengthened assertion) ──
//
// The presence arm above asserts the hook's output INCLUDES the newly-created keyframe (by id).
// That is presence, not behavior. The position arm asserts the hook's projected POSITION is the
// position the render actually draws, in a state where the stale and fresh snapshots differ.
//
// State construction: move a strip synchronously via `widenStrip` (changing `Strip.start` from
// its current value to a smaller one, keeping `end` the same). The tick-gated `bandStrips`
// `$derived` is now stale — it holds the previous frame's strip `start`/`end`. The hook is read
// in the SAME `page.evaluate` (no intervening RAF). After RAF, the `$derived` re-evaluates and
// the hook is read again. On the unfixed hook (7579c25), the before-RAF read uses stale
// `bandStrips` (old `start`), so the strip's `x0` differs from the after-RAF read (new
// `start`). On the fixed hook, both reads compute fresh from the ECS (via `computeBandStrips`
// calling `sectionStrips` directly), so `x0` matches.
//
// The `stripKfPx` position arm is NOT included here because the keyframe position
// (`toGlobal(spans, section, k.s)` + `uOfLen(d)`) does not depend on the strip's `start`/`end`
// — it depends on `spans` (which reads `bakeOut`, unavoidably frame-bound) and `k.s` (always
// fresh from the ECS). See the frame-bound finding in the file header for the full reasoning.

test("__kex hook freshness — stripPx position matches render after synchronous strip move", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await kexCall(page, "convert"); // → a force section
    await kexCall(page, "seedForceBump");
    await frameTimeline(page);

    // Create a strip so we have a strip to move.
    const beforeStrips = (await kexCall(page, "stripsOf", 0)) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const stripX = clipBb.x + clipBb.width * 0.6;
    await page.mouse.click(stripX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toHaveCount(1);
    const items = page.locator(".smenu .menu-item");
    const count = await items.count();
    let added = false;
    for (let i = 0; i < count; i++) {
        const text = await items.nth(i).textContent();
        if (text?.includes("Add velocity strip")) {
            await items.nth(i).click();
            added = true;
            break;
        }
    }
    if (!added) throw new Error("Add velocity strip menu item not found");
    await expect
        .poll(async () => (await kexCall(page, "stripsOf", 0)).length)
        .toBe(beforeStrips.length + 1);
    const strips = (await kexCall(page, "stripsOf", 0)) as {
        id: number;
        start: number;
        end: number;
    }[];
    const beforeStripIds = new Set(beforeStrips.map((s) => s.id));
    const strip = strips.find((s) => !beforeStripIds.has(s.id));
    if (!strip) throw new Error("newly-created strip not found");

    // Let `bandStrips` propagate the new strip.
    await frames(page, 2);

    // THE POSITION ARM: move the strip synchronously (changes `Strip.start` in the ECS, which
    // changes the strip's band `x0`). Read `stripPx` immediately (before RAF) and again after
    // RAF. Assert the strip's `x0` matches — on the unfixed hook, the before-RAF read uses
    // stale `bandStrips` (old `start`), so `x0` differs from the after-RAF read (new `start`).
    // On the fixed hook, both reads compute fresh from the ECS, so `x0` matches.
    //
    // Move the strip's `start` to a smaller value (toward the section entry), keeping `end`
    // the same. The strip's current `start` is > 0 (created at 60% of the clip), so moving it
    // to `start / 2` keeps it > 0 and doesn't overlap the seed's start strip at station 0.
    const movedStart = strip.start / 2;
    const result = await page.evaluate(
        ({ stripId, newStart, newEnd }) => {
            const kex = (
                window as unknown as { __kex: Record<string, (...a: unknown[]) => unknown> }
            ).__kex;
            // synchronous strip move — changes `Strip.start` in the ECS. The tick-gated
            // `bandStrips` `$derived` is now stale (has old `start`).
            kex.widenStrip(stripId, newStart, newEnd);
            // immediate hook read — the band positions under test.
            const beforePx = kex.stripPx() as { id: number; x0: number; x1: number }[];
            const beforeStrip = beforePx.find((p) => p.id === stripId) ?? null;
            return { beforeStrip };
        },
        { stripId: strip.id, newStart: movedStart, newEnd: strip.end },
    );

    expect(
        result.beforeStrip,
        `stripPx did not include the strip ${strip.id} before RAF`,
    ).not.toBeNull();

    // Let RAF ticks fire so the `$derived` values re-evaluate.
    await frames(page, 3);

    const afterPx = (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[];
    const afterStrip = afterPx.find((p) => p.id === strip.id) ?? null;
    expect(afterStrip, `stripPx did not include the strip ${strip.id} after RAF`).not.toBeNull();

    // THE ASSERTION: the hook's band `x0` before RAF must match after RAF.
    // On the unfixed hook (7579c25), the before-RAF read uses stale `bandStrips` (old `start`),
    // so `x0` differs from the after-RAF read (fresh `bandStrips`, new `start`). On the fixed
    // hook, both reads compute fresh from the ECS, so `x0` matches.
    expect(
        result.beforeStrip!.x0,
        `stripPx x0 mismatch: before RAF x0=${result.beforeStrip!.x0} vs after RAF x0=${afterStrip!.x0} — the hook read a stale $derived before RAF (mixed-freshness snapshot)`,
    ).toBe(afterStrip!.x0);
    // x1 should also match (end didn't change, but spans might have re-baked).
    expect(
        result.beforeStrip!.x1,
        `stripPx x1 mismatch: before RAF x1=${result.beforeStrip!.x1} vs after RAF x1=${afterStrip!.x1} — the hook read a stale $derived before RAF`,
    ).toBe(afterStrip!.x1);
});

// ── THE HANDLER ARM ──
//
// The same defect class one layer out: a production POINTER HANDLER, not a `__kex` hook, reading
// the tick-gated `bandStrips` `$derived`. `bandDown` hit-tested through `bandCandidates()` →
// `bandStrips`, so a strip created (or moved) and pressed in the same frame was absent from the
// classifier's candidate list: `classifyStripHit` returned `empty`, and the empty-band branch
// deselects (`kex2d-event-lane` S4's one empty-click grammar). A band click before the RAF flush
// therefore selected NOTHING — user-visible on its own, and the whole reason every band-click flow
// in `section.pw.ts` carried a settle or a bounded retry before its press. The fix is this file's
// own law applied to the gesture path: `freshBandStrips()` computes the layout from the ECS, and
// the press resolves the hit's id against that same snapshot (never one fresh and one stale).
//
// The press is dispatched IN THE PAGE rather than through `page.mouse`, and that is the arm's whole
// instrument: a real pointer costs a CDP round trip, which lets RAF ticks fire between the create
// and the press — the exact non-determinism that made this defect intermittent instead of visible.
// The event still lands on the real hit rect and runs the real `bandDown`, so what is synthetic is
// the event source, not the handler under test.
//
// RED-FIRST WITNESS: with the fix reverse-applied (`bandDown` back on `bandCandidates()` →
// `bandStrips`) this arm reds, `selectedStrip` reading null against the created strip's own id —
// the empty-band deselect, which is the user-visible defect itself. Restored, it greens.
test("__kex hook freshness — a band press in the create's own frame selects the new strip", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    // nothing selected going in, so the assertion below can only be satisfied by the press itself
    // (a pre-selected strip would make it vacuous — `kex2d-harness.md`'s positive-control law).
    expect(await kexCall(page, "selectedStrip")).toBe(null);

    const result = await page.evaluate(
        ({ from, to }) => {
            const kex = (
                window as unknown as { __kex: Record<string, (...a: unknown[]) => unknown> }
            ).__kex;
            // the strip's window, over the track's own live extent read through the chart's own
            // axis (`dOf(uTotal)`, the addressable end) — never `sectionLengths`, which is a
            // force-section field and reads 0 on this geo seed.
            const len = kex.dOf(kex.uTotal()) as number;
            const start = len * from;
            const end = len * to;
            const zone = document.querySelector(".hbandzone");
            if (zone === null) return { error: "no .hbandzone" };
            const band = zone.getBoundingClientRect();
            const canvas = document.querySelector("canvas.chart");
            if (canvas === null) return { error: "no canvas.chart" };
            const chart = canvas.getBoundingClientRect();

            // synchronous create — the ECS now carries a strip the tick-gated `bandStrips`
            // `$derived` has never seen, and no RAF runs before the press below.
            const id = kex.addStripAt(start, end, 5) as number | null;
            if (id === null) return { error: "addStripAt refused (overlap?)" };
            const px = (kex.stripPx() as { id: number; x0: number; x1: number }[]).find(
                (p) => p.id === id,
            );
            if (px === undefined) return { error: "the new strip has no band px" };

            zone.dispatchEvent(
                new PointerEvent("pointerdown", {
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    clientX: chart.left + (px.x0 + px.x1) / 2,
                    clientY: band.top + band.height / 2,
                }),
            );
            return { id, selected: kex.selectedStrip() as number | null };
        },
        { from: 0.55, to: 0.85 },
    );

    expect(result.error, `arm setup failed: ${result.error ?? ""}`).toBeUndefined();
    // THE ASSERTION: the press selected the strip it landed on. On the unfixed handler the
    // candidate list is the previous frame's, which has no such strip — the press classifies
    // `empty` and deselects, so this reads null.
    expect(
        result.selected,
        `a band press in the create's own frame selected ${String(result.selected)} instead of the strip ${String(result.id)} under the pointer — the classifier read a stale $derived`,
    ).toBe(result.id);
});

// ── the keyframe twin of the band-press arm above (`A strip keyframe click can land a frame ahead
// of its own diamond`). Same class, one surface over, and the fix is the same law: a press is
// classified against a FRESH projection, never against rendered geometry.
//
// The defect: `stripKfPx` computes the diamond's position fresh from the ECS, while the diamond's
// own DOM hit circle (`.fhit`) is positioned from the tick-paced `stripKfPts` `$derived`. A flow
// that creates (or moves) a keyframe and presses at the hook's coordinate in the SAME frame presses
// where the circle is *about* to be — so the press lands on no circle at all, falls through to the
// chart's own rect, and (before the fix) armed a marquee whose empty-click branch DESELECTS. That
// is what made the two witnessed reds intermittent: the press only misses when no RAF tick happens
// to land between the create and the press.
//
// The fix routes both entry points — the circle and the chartzone beneath it — through `chartDown`,
// which re-reads the ECS and classifies by position (`classifyKfHit`, `src/kf-hit.ts`), the same
// shape `bandDown`/`freshBandStrips` already had.
//
// The press is dispatched IN THE PAGE for the same reason the band arm's is: a real pointer costs a
// CDP round trip, which lets RAF ticks fire between the create and the press — the exact
// non-determinism this arm exists to remove. The event lands on the real chartzone rect and runs the
// real handler, so what is synthetic is the event source, not the handler under test.
//
// RED-FIRST WITNESS: with the fix reverse-applied (chartzone back to `onpointerdown={marqueeDown}`)
// this arm reds, `stripKfSelActive` reading null against the created keyframe's own id — the
// empty-chart deselect, which is the user-visible defect itself. Restored, it greens.
test("__kex hook freshness — a strip keyframe press in the create's own frame selects the new keyframe", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    // a settled strip to hang the keyframe on — created and allowed to reach the render, so the
    // ONLY unsettled state at press time is the keyframe this arm creates below.
    const strip = await page.evaluate(() => {
        const kex = (window as unknown as { __kex: Record<string, (...a: unknown[]) => unknown> })
            .__kex;
        const len = kex.dOf(kex.uTotal()) as number;
        return {
            id: kex.addStripAt(len * 0.55, len * 0.85, 5) as number | null,
            start: len * 0.55,
            end: len * 0.85,
        };
    });
    expect(strip.id, "addStripAt refused (overlap?)").not.toBeNull();
    await frames(page, 2);

    // nothing selected going in, so the assertion below can only be satisfied by the press itself
    // (`kex2d-harness.md`'s positive-control law — a pre-selected keyframe would make it vacuous).
    expect(await kexCall(page, "stripKfSelActive")).toBe(null);

    const result = await page.evaluate(
        ({ stripId, at }) => {
            const kex = (
                window as unknown as { __kex: Record<string, (...a: unknown[]) => unknown> }
            ).__kex;
            const zone = document.querySelector(".chartzone");
            if (zone === null) return { error: "no .chartzone" };
            const canvas = document.querySelector("canvas.chart");
            if (canvas === null) return { error: "no canvas.chart" };
            const chart = canvas.getBoundingClientRect();

            // synchronous create — the ECS now carries a keyframe the tick-gated `stripKfPts`
            // `$derived` has never seen, so no `.fhit` circle exists for it. No RAF runs before
            // the press below.
            const id = kex.placeStripKf(stripId, at, 7) as number;
            const px = (kex.stripKfPx() as { id: number; x: number; y: number }[]).find(
                (p) => p.id === id,
            );
            if (px === undefined) return { error: "the new keyframe has no chart px" };

            zone.dispatchEvent(
                new PointerEvent("pointerdown", {
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    clientX: px.x,
                    clientY: px.y,
                }),
            );
            return {
                id,
                selected: kex.stripKfSelActive() as number | null,
                // the diamond's own DOM circle count, to witness that the press really did land
                // in a frame where the render had not caught up.
                circles: document.querySelectorAll(".fmarkers .fhit").length,
                chartLeft: chart.left,
            };
        },
        { stripId: strip.id as number, at: (strip.start + strip.end) / 2 },
    );

    expect(result.error, `arm setup failed: ${result.error ?? ""}`).toBeUndefined();
    // THE ASSERTION: the press selected the keyframe it landed on. Before the fix the press hits no
    // circle (the new diamond is undrawn) and the chartzone's marquee branch deselects, so this
    // reads null.
    expect(
        result.selected,
        `a strip keyframe press in the create's own frame selected ${String(result.selected)} instead of the keyframe ${String(result.id)} under the pointer — the press was classified against rendered geometry, not a fresh projection`,
    ).toBe(result.id);
});
