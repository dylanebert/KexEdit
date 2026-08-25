// kex2d's S1 freshness arm — the deterministic, enumerated pin for the class of `__kex` hooks
// that read a `$derived` behind `void tick` and must read FRESH after a synchronous ECS create.
//
// The defect: `stripKfPx` read `stripKfPts`, a `$derived.by` paced by `void tick` (one re-eval
// per RAF frame). A capture flow that creates a strip keyframe through `chartCreate`'s
// synchronous ECS write and immediately reads pixel positions gets a pre-creation list and
// throws "strip keyframe N not laid out". The fix (ECS-direct read via a shared projection
// function) is correct; its sibling `k.forceU` (reading `forcePts`, the same `$derived`-behind-
// `void tick` shape) has the identical race on the same create-then-read path
// (`harness/force.pw.ts:2004-2009`).
//
// This arm is ONE deterministic, enumerated witness for the CLASS, not a mutation pair or a
// repetition. Deterministic because it compares two readings taken in the SAME synchronous
// `page.evaluate` — a `placeForce`/`placeStripKf` call (synchronous ECS write) followed
// immediately by the hook read and a direct ECS read, with no intervening RAF. Exhaustive
// because the enumeration is committed: a hook absent from the must-read-fresh set is named
// here with its exclusion reason, and a hook present in the set but absent from the arm's
// assertions is a red of the arm itself.
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
//   8. `stripPx`   — reads `bandStrips`  ($derived.by, void tick)
//   9. `uTotal`    — reads `uTotal`      ($derived, chains through `sTotal`→`curve`→void tick)
//  10. `stallU`    — reads `stallU`      ($derived.by, void tick)
//
// MUST-READ-FRESH set: { `forceU`, `stripKfPx` }
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
//   `stripPx`: reads `bandStrips` (the strip list). Creating a strip KEYFRAME does not change the
//   strip SET — the strip already exists; only its keyframes change. So the cached `bandStrips`
//   is still correct after a keyframe create. (A strip CREATE would change `bandStrips`, but
//   that goes through the context-menu UI path, not a synchronous ECS write followed by an
//   immediate `stripPx` read.)
//
//   `uTotal`: reads the total chart extent, which changes only when the bake's curve changes
//   (`sTotal`→`curve`→`void tick`). Creating a keyframe does not change the bake.
//
//   `stallU`: reads the first-infeasible sample's axis reading, which changes only when the
//   bake changes. Creating a keyframe does not change the bake.
//
// Usage: bun run freshness

import { test, expect, kexCall, seedHill, frameTimeline, frames } from "./flow";

// The freshness arm: for each hook in the MUST-READ-FRESH set, create a keyframe via a
// synchronous ECS write and immediately read the hook AND a direct ECS reading in the SAME
// `page.evaluate` (no intervening RAF). Assert the hook's output includes the newly-created
// keyframe — deterministic because both readings are taken in one synchronous JS execution.
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
    // Click the "Add velocity strip" menu item.
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

    // Let `bandStrips` (a `$derived` behind `void tick`) propagate the new strip — the arm tests
    // the KEYFRAME-create race, not the strip-create race, so the strip must already be in the
    // cached `bandStraps` before the keyframe create fires.
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
            // synchronous ECS write — no RAF fires between this and the reads below
            const newId = kex.placeStripKf(stripId, s, v) as number;
            // immediate hook read (the thing under test) — returns ALL strips' keyframes
            const hookPx = kex.stripKfPx() as { id: number; x: number; y: number }[];
            // immediate direct ECS read (the ground truth) — ALL strips' keyframes
            const ecsIds: number[] = [];
            for (const sid of allIds) {
                const kfs = kex.stripKeyframesOf(sid) as { id: number }[];
                ecsIds.push(...kfs.map((k) => k.id));
            }
            return { newId, hookIds: hookPx.map((p) => p.id), ecsIds };
        },
        { stripId: strip.id, s: sLocal, v: 8, allIds: allStripIds },
    );

    // The hook must include the newly-created keyframe — if it read the stale `$derived`,
    // the new keyframe would be absent.
    expect(
        result.hookIds,
        `stripKfPx did not include the freshly-created keyframe ${result.newId} — the hook read a stale $derived (hook: ${result.hookIds.join(",")}, ecs: ${result.ecsIds.join(",")})`,
    ).toContain(result.newId);
    // The direct ECS read must also include it (sanity: the create actually happened).
    expect(result.ecsIds).toContain(result.newId);
    // The hook and the ECS must agree on the count (exhaustive: no keyframe is missing from the hook).
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

    // THE ARM: create a force keyframe via `placeForce` (synchronous ECS write) and
    // immediately read `forceU` AND `forceCount` in the SAME `page.evaluate` — no
    // intervening RAF. Assert the hook's output includes the newly-created keyframe.
    const result = await page.evaluate(
        ({ s, g }) => {
            const kex = (
                window as unknown as { __kex: Record<string, (...a: unknown[]) => unknown> }
            ).__kex;
            // synchronous ECS write — no RAF fires between this and the reads below
            const newId = kex.placeForce(s, g) as number;
            // immediate hook read (the thing under test)
            const hookU = kex.forceU() as {
                id: number;
                section: number;
                s: number;
                g: number;
                u: number;
            }[];
            // immediate direct ECS read (the ground truth)
            const ecsCount = kex.forceCount() as number;
            return { newId, hookIds: hookU.map((p) => p.id), ecsCount };
        },
        { s: len * 0.5, g: 0.5 },
    );

    // The hook must include the newly-created keyframe — if it read the stale `$derived`,
    // the new keyframe would be absent.
    expect(
        result.hookIds,
        `forceU did not include the freshly-created keyframe ${result.newId} — the hook read a stale $derived (hook: ${result.hookIds.join(",")})`,
    ).toContain(result.newId);
    // The direct ECS count must reflect the create (sanity).
    expect(result.ecsCount).toBe((beforeCount as number) + 1);
    // The hook and the ECS must agree on the count.
    expect(result.hookIds.length).toBe(result.ecsCount);
});
