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
// Usage: bun run freshness

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
