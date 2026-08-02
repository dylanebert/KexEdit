import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { flyoutFit, type MenuItem, menuFit } from "../src/menu";
import {
    appendMenu,
    keyframeMenu,
    type KeyframeMenuState,
    nodeMenu,
    type NodeMenuState,
    rulerMenu,
    sectionMenu,
    type SectionMenuState,
} from "../src/menus";
import { Easing } from "../src/profile";
import { Domain, SectionKind } from "../src/section";
import { TangentMode } from "../src/spline";

describe("menuFit — root context menu viewport fit (flip up/left, clamp)", () => {
    const Vp = { w: 1280, h: 800 };
    const size = { w: 132, h: 160 };
    const pad = 4;

    test("opens down-right at the cursor when it fits", () => {
        expect(menuFit({ x: 200, y: 100 }, size, Vp)).toEqual({ x: 200, y: 100 });
    });
    test("flips UP (bottom edge at the anchor) when opening down would clip the bottom", () => {
        // y=780 → bottom 940 > 796; room above (780-160=620 ≥ 4) → open upward
        expect(menuFit({ x: 200, y: 780 }, size, Vp)).toEqual({ x: 200, y: 620 });
    });
    test("flips LEFT (right edge at the anchor) when opening right would clip the right edge", () => {
        // x=1240 → right 1372 > 1276; room left (1240-132=1108 ≥ 4) → open leftward
        expect(menuFit({ x: 1240, y: 100 }, size, Vp)).toEqual({ x: 1108, y: 100 });
    });
    test("flips BOTH axes near the bottom-right corner (the reported-bug corner)", () => {
        expect(menuFit({ x: 1240, y: 780 }, size, Vp)).toEqual({ x: 1108, y: 620 });
    });
    test("a menu taller than the viewport keeps its top-left visible, clipping the bottom", () => {
        const tall = { w: 132, h: 900 };
        // no room above (780-900 < 4) → no flip; clamp pins the top at the pad, bottom clips
        expect(menuFit({ x: 200, y: 780 }, tall, Vp)).toEqual({ x: 200, y: pad });
    });
    test("a menu wider than the viewport keeps its left edge at the pad", () => {
        const wide = { w: 1300, h: 160 };
        // no room left (1270-1300 < 4) → no flip; clamp pins x at the pad
        expect(menuFit({ x: 1270, y: 100 }, wide, Vp)).toEqual({ x: pad, y: 100 });
    });
});

describe("flyoutFit — submenu flyout viewport fit (all four edges)", () => {
    const Vp = { w: 1000, h: 800 };
    const size = { w: 128, h: 200 };
    const pad = 4;

    describe("horizontal", () => {
        test("stays on the right when the right side has room", () => {
            // parent.right = 200, right space = 1000 - 4 - 203 = 793 ≥ 128 → no flip
            expect(flyoutFit({ left: 60, right: 200, top: 100 }, size, Vp).flipX).toBe(false);
        });
        test("flips left when the right clips and the left has room", () => {
            // parent.right = 900 → right space = 1000 - 4 - 903 = 93 < 128 (clips);
            // parent.left = 760 → left space = 760 - 3 - 4 = 753 ≥ 128 → flip
            expect(flyoutFit({ left: 760, right: 900, top: 100 }, size, Vp).flipX).toBe(true);
        });
        test("takes the side with MORE room when neither side fits", () => {
            // a viewport narrower than the flyout: right space > left space → stay right
            const narrow = { w: 150, h: 800 };
            // parent right at 100 → rightSpace = 150-4-103 = 43; leftSpace = 20-3-4 = 13 → stay
            expect(flyoutFit({ left: 20, right: 100, top: 100 }, size, narrow).flipX).toBe(false);
            // parent pushed right → leftSpace > rightSpace → flip
            expect(flyoutFit({ left: 60, right: 140, top: 100 }, size, narrow).flipX).toBe(true);
        });
    });

    describe("vertical", () => {
        test("no shift when the flyout fits between the edges", () => {
            // top = 100, bottom = 300 ≤ 796, top ≥ 4 → no nudge
            expect(flyoutFit({ left: 60, right: 200, top: 100 }, size, Vp).shiftY).toBe(0);
        });
        test("nudges UP when the flyout would clip the bottom", () => {
            // top = 700 → bottom 900 > 796 → shiftY = 796 - 900 = -104; top 700-104=596 ≥ 4 ok
            const fit = flyoutFit({ left: 60, right: 200, top: 700 }, size, Vp);
            expect(fit.shiftY).toBeCloseTo(-104, 9);
            expect(700 + fit.shiftY + size.h).toBeCloseTo(Vp.h - pad, 9); // bottom sits at the pad
        });
        test("nudges DOWN when the flyout opens above the top edge", () => {
            // top = 1 (< pad) → nudge down to clear the top: shiftY = 4 - 1 = 3
            const fit = flyoutFit({ left: 60, right: 200, top: 1 }, size, Vp);
            expect(fit.shiftY).toBe(pad - 1);
            expect(1 + fit.shiftY).toBe(pad); // top sits exactly at the pad
        });
        test("a flyout taller than the viewport keeps its top visible, clipping the bottom", () => {
            const tall = { w: 128, h: 900 }; // taller than the 800 viewport
            const fit = flyoutFit({ left: 60, right: 200, top: 500 }, tall, Vp);
            // the bottom-nudge would push top far above 4, so the top clamp wins
            expect(500 + fit.shiftY).toBe(pad); // top pinned at the pad (parent connection kept)
            expect(500 + fit.shiftY + tall.h).toBeGreaterThan(Vp.h); // bottom clips, unavoidable
        });
    });
});

// ── characterization: the pure menu builders' exact rows (kex2d-menu-grammar stage 1).
// The lift out of the `$derived.by` closures must change nothing, so these pin TODAY's arrays —
// label, order, separator, enabled, checked, shortcut, danger, glyph, and submenu children —
// across the state matrix. `shape` normalizes every documented field, so an omitted field and an
// explicit `false` are distinguishable (an expected row that omits `checked` fails against an
// actual `checked: false`).
type Row = {
    label?: string;
    aria?: string;
    shortcut?: string;
    danger?: boolean;
    checked?: boolean;
    enabled?: boolean;
    separator?: boolean;
    glyph?: string;
    children?: Row[];
};
function shape(items: MenuItem[]): Row[] {
    return items.map((i) => {
        const row: Row = {
            label: i.label,
            aria: i.aria,
            shortcut: i.shortcut,
            danger: i.danger,
            checked: i.checked,
            enabled: i.enabled,
            separator: i.separator,
            glyph: i.glyph,
        };
        if (i.children !== undefined) row.children = shape(i.children);
        return row;
    });
}
// a recorder standing in for the surface's actions: every row's action logs its own name.
function recorder<K extends string>(...names: K[]): Record<K, () => void> & { log: string[] } {
    const log: string[] = [];
    const rec = { log } as Record<K, () => void> & { log: string[] };
    for (const n of names)
        rec[n] = ((...args: unknown[]) => log.push(`${n}(${args.join(",")})`)) as never;
    return rec;
}

describe("sectionMenu — the section context menu's rows", () => {
    const base: SectionMenuState = {
        inMode: false,
        solving: false,
        optSolvable: false,
        kind: SectionKind.Geo,
        multi: false,
        modeOpen: false,
        canSolve: true,
        canSolveShape: false,
        canOptimize: false,
        canReset: true,
        canDelete: true,
    };
    const acts = () =>
        recorder(
            "solve",
            "solveShape",
            "optimizeSolve",
            "optimizeExit",
            "optimizeEnter",
            "reset",
            "remove",
            "removeSet",
        );

    test("a single GEO section: Convert, Reset, Delete", () => {
        expect(shape(sectionMenu(base, acts()))).toEqual([
            { label: "Convert", enabled: true },
            { label: "Reset", enabled: true },
            { label: "Delete", shortcut: "Del", danger: true, enabled: true },
        ]);
    });
    test("a single FORCE section adds Optimize between Convert and Reset", () => {
        const s = {
            ...base,
            kind: SectionKind.Force,
            canSolve: false,
            canSolveShape: true,
            canOptimize: true,
        };
        expect(shape(sectionMenu(s, acts()))).toEqual([
            { label: "Convert", enabled: true },
            { label: "Optimize", enabled: true },
            { label: "Reset", enabled: true },
            { label: "Delete", shortcut: "Del", danger: true, enabled: true },
        ]);
    });
    test("a multi-set grays the single-subject rows and drops Optimize (force set included)", () => {
        const s = {
            ...base,
            kind: SectionKind.Force,
            multi: true,
            canSolve: false,
            canSolveShape: false,
            canOptimize: false,
            canReset: false,
        };
        expect(shape(sectionMenu(s, acts()))).toEqual([
            { label: "Convert", enabled: false },
            { label: "Reset", enabled: false },
            { label: "Delete", shortcut: "Del", danger: true, enabled: true },
        ]);
    });
    test("an open session on ANOTHER section still grays Optimize on this one", () => {
        const s = { ...base, kind: SectionKind.Force, canOptimize: true, modeOpen: true };
        expect(shape(sectionMenu(s, acts()))[1]).toEqual({ label: "Optimize", enabled: false });
    });
    test("in-mode on THIS section: the mode's own two rows replace the menu", () => {
        const s = {
            ...base,
            kind: SectionKind.Force,
            inMode: true,
            modeOpen: true,
            optSolvable: true,
        };
        expect(shape(sectionMenu(s, acts()))).toEqual([
            { label: "Solve", enabled: true },
            { label: "Exit", shortcut: "Esc" },
        ]);
        expect(shape(sectionMenu({ ...s, solving: true }, acts()))[0].enabled).toBe(false);
        expect(shape(sectionMenu({ ...s, optSolvable: false }, acts()))[0].enabled).toBe(false);
    });
    test("Convert's action follows the kind; Delete's follows the set", () => {
        const geo = acts();
        sectionMenu(base, geo)[0].action?.();
        expect(geo.log).toEqual(["solve()"]);
        const force = acts();
        sectionMenu({ ...base, kind: SectionKind.Force }, force)[0].action?.();
        expect(force.log).toEqual(["solveShape()"]);
        const single = acts();
        sectionMenu(base, single)[2].action?.();
        expect(single.log).toEqual(["remove()"]);
        const multi = acts();
        sectionMenu({ ...base, multi: true }, multi)[2].action?.();
        expect(multi.log).toEqual(["removeSet()"]);
    });
});

describe("nodeMenu — the node context menu's rows", () => {
    const base: NodeMenuState = {
        multi: false,
        isEntry: false,
        ok: true,
        mode: TangentMode.Aligned,
        editing: false,
        isEnd: false,
        canTrim: false,
        suffixOk: false,
    };
    const acts = () =>
        recorder(
            "remove",
            "removeSet",
            "add",
            "toggleHandles",
            "pickMode",
            "pickModeSet",
            "reset",
            "resetSet",
        );
    const tangents = (enabled: boolean, mode: TangentMode): Row => ({
        label: "Tangents",
        enabled,
        children: [
            { label: "Mirror", checked: mode === TangentMode.Mirror },
            { label: "Aligned", checked: mode === TangentMode.Aligned },
            { label: "Free", checked: mode === TangentMode.Free },
        ],
    });

    test("an INTERIOR node: Delete + Add both gated off, then Handles / Tangents / Reset", () => {
        expect(shape(nodeMenu(base, acts()))).toEqual([
            { label: "Delete", shortcut: "Del", danger: true, enabled: false },
            { label: "Add", shortcut: "Enter", enabled: false },
            { separator: true },
            { label: "Handles", checked: false, enabled: true },
            tangents(true, TangentMode.Aligned),
            { label: "Reset", enabled: true },
        ]);
    });
    test("a CHAIN-END node lights Delete + Add; the mode check follows the target", () => {
        const s = { ...base, isEnd: true, canTrim: true, editing: true, mode: TangentMode.Free };
        expect(shape(nodeMenu(s, acts()))).toEqual([
            { label: "Delete", shortcut: "Del", danger: true, enabled: true },
            { label: "Add", shortcut: "Enter", enabled: true },
            { separator: true },
            { label: "Handles", checked: true, enabled: true },
            tangents(true, TangentMode.Free),
            { label: "Reset", enabled: true },
        ]);
    });
    test("NODE 0 carries Handles + Reset only (no Add/Delete, no mode submenu)", () => {
        expect(shape(nodeMenu({ ...base, isEntry: true }, acts()))).toEqual([
            { label: "Handles", checked: false, enabled: true },
            { separator: true },
            { label: "Reset", enabled: true },
        ]);
    });
    test("NODE 0's Handles check lights in tangent edit, like every other node's", () => {
        expect(shape(nodeMenu({ ...base, isEntry: true, editing: true }, acts()))).toEqual([
            { label: "Handles", checked: true, enabled: true },
            { separator: true },
            { label: "Reset", enabled: true },
        ]);
    });
    test("node 0's rows act on the single target — Reset is `reset`, never `resetSet`", () => {
        const rec = acts();
        const rows = nodeMenu({ ...base, isEntry: true }, rec);
        rows[0].action?.();
        rows[2].action?.();
        expect(rec.log).toEqual(["toggleHandles()", "reset()"]);
    });
    test("a MULTI set holding node 0 keeps the bulk menu — the multi fork outranks isEntry", () => {
        // shift-click node 0 into a set, then right-click it: the set is the subject, so the bulk
        // rows win. node 0's own two-row menu is the SINGLE-subject shape only.
        const s = { ...base, multi: true, isEntry: true, suffixOk: true, mode: TangentMode.Mirror };
        expect(shape(nodeMenu(s, acts()))).toEqual([
            { label: "Delete", shortcut: "Del", danger: true, enabled: true },
            { label: "Add", shortcut: "Enter", enabled: false },
            { separator: true },
            { label: "Handles", enabled: false },
            tangents(true, TangentMode.Mirror),
            { label: "Reset", enabled: true },
        ]);
    });
    test("a MULTI set: bulk Delete on a suffix run, Add + Handles grayed, no Handles check", () => {
        const s = { ...base, multi: true, suffixOk: true, mode: TangentMode.Mirror };
        expect(shape(nodeMenu(s, acts()))).toEqual([
            { label: "Delete", shortcut: "Del", danger: true, enabled: true },
            { label: "Add", shortcut: "Enter", enabled: false },
            { separator: true },
            { label: "Handles", enabled: false },
            tangents(true, TangentMode.Mirror),
            { label: "Reset", enabled: true },
        ]);
    });
    test("the lockdown grays every edit row, single and multi alike", () => {
        const single = shape(nodeMenu({ ...base, ok: false, isEnd: true, canTrim: true }, acts()));
        expect(single.map((r) => r.enabled)).toEqual([
            false,
            false,
            undefined,
            false,
            false,
            false,
        ]);
        const multi = shape(nodeMenu({ ...base, ok: false, multi: true, suffixOk: true }, acts()));
        expect(multi.map((r) => r.enabled)).toEqual([false, false, undefined, false, false, false]);
        const zero = shape(nodeMenu({ ...base, ok: false, isEntry: true }, acts()));
        expect(zero.map((r) => r.enabled)).toEqual([false, undefined, false]);
    });
    test("the single rows act on the target, the multi rows on the set", () => {
        // EVERY submenu row is invoked, in order: three near-identical copy-pasted rows per branch
        // is exactly where a mis-paste (a set row bound to the single action, or two rows sharing
        // one mode) lands, and a one-of-three spot check can't see it.
        const one = acts();
        const rows = nodeMenu(base, one);
        rows[0].action?.();
        rows[1].action?.();
        rows[3].action?.();
        for (const c of rows[4].children ?? []) c.action?.();
        rows[5].action?.();
        expect(one.log).toEqual([
            "remove()",
            "add()",
            "toggleHandles()",
            `pickMode(${TangentMode.Mirror})`,
            `pickMode(${TangentMode.Aligned})`,
            `pickMode(${TangentMode.Free})`,
            "reset()",
        ]);
        const set = acts();
        const bulk = nodeMenu({ ...base, multi: true }, set);
        bulk[0].action?.();
        for (const c of bulk[4].children ?? []) c.action?.();
        bulk[5].action?.();
        expect(set.log).toEqual([
            "removeSet()",
            `pickModeSet(${TangentMode.Mirror})`,
            `pickModeSet(${TangentMode.Aligned})`,
            `pickModeSet(${TangentMode.Free})`,
            "resetSet()",
        ]);
    });
});

describe("keyframeMenu — the force-keyframe context menu's rows", () => {
    const base: KeyframeMenuState = {
        setOk: true,
        activeOk: true,
        lock: null,
        multi: false,
        terminal: false,
        easeTargets: 1,
        custom: false,
        ease: Easing.Cubic,
        hasHandles: false,
        mode: TangentMode.Aligned,
        presetGlyph: (e) => `preset:${e}`,
        customGlyph: "custom:glyph",
    };
    const acts = () => recorder("remove", "toggleLock", "setEase", "chooseCustom", "pickMode");
    const easing = (
        enabled: boolean,
        checked: Easing | null,
        customEnabled: boolean,
        custom = false,
    ): Row => ({
        label: "Easing",
        enabled,
        children: [
            { label: "Linear", glyph: "preset:0", checked: checked === Easing.Linear },
            { label: "Cubic", glyph: "preset:1", checked: checked === Easing.Cubic },
            { label: "Quintic", glyph: "preset:2", checked: checked === Easing.Quintic },
            { separator: true },
            { label: "Custom", enabled: customEnabled, glyph: "custom:glyph", checked: custom },
        ],
    });

    test("a single NON-TERMINAL keyframe: Delete then Easing ▸ (the tag checked)", () => {
        expect(shape(keyframeMenu(base, acts()))).toEqual([
            { label: "Delete", shortcut: "Del", danger: true, enabled: true },
            easing(true, Easing.Cubic, true),
        ]);
    });
    test("a single TERMINAL keyframe shows Delete alone", () => {
        expect(shape(keyframeMenu({ ...base, terminal: true, easeTargets: 0 }, acts()))).toEqual([
            { label: "Delete", shortcut: "Del", danger: true, enabled: true },
        ]);
    });
    test("a MULTI set keeps Easing ▸ even on a terminal active, graying Custom", () => {
        const s = { ...base, multi: true, terminal: true, easeTargets: 2 };
        expect(shape(keyframeMenu(s, acts()))).toEqual([
            { label: "Delete", shortcut: "Del", danger: true, enabled: true },
            easing(true, Easing.Cubic, false),
        ]);
    });
    test("no applicable easing target grays the row; an explicit handle unchecks the preset", () => {
        const s = { ...base, easeTargets: 0, custom: true };
        expect(shape(keyframeMenu(s, acts()))[1]).toEqual(easing(false, null, true, true));
    });
    test("in-mode: the Lock row leads, above Delete", () => {
        const locked = shape(keyframeMenu({ ...base, lock: "Lock" }, acts()));
        expect(locked[0]).toEqual({ label: "Lock", shortcut: "Q" });
        expect(locked[1]).toEqual({
            label: "Delete",
            shortcut: "Del",
            danger: true,
            enabled: true,
        });
        expect(locked).toHaveLength(3);
        expect(shape(keyframeMenu({ ...base, lock: "Unlock" }, acts()))[0]).toEqual({
            label: "Unlock",
            shortcut: "Q",
        });
    });
    test("explicit handles add the Tangents ▸ submenu last, checked by the stored mode", () => {
        const s = { ...base, hasHandles: true, mode: TangentMode.Mirror };
        expect(shape(keyframeMenu(s, acts())).at(-1)).toEqual({
            label: "Tangents",
            enabled: true,
            children: [
                { label: "Mirror", checked: true },
                { label: "Aligned", checked: false },
                { label: "Free", checked: false },
            ],
        });
    });
    test("the lockdown: the set gates Delete + Easing, the active member gates Custom", () => {
        const rows = shape(
            keyframeMenu({ ...base, setOk: false, activeOk: false, hasHandles: true }, acts()),
        );
        expect(rows[0].enabled).toBe(false);
        expect(rows[1].enabled).toBe(false);
        expect(rows[1].children?.[4].enabled).toBe(false);
        expect(rows[2].enabled).toBe(false);
    });
    test("the rows act on their subjects", () => {
        // every submenu row is invoked, in order — three near-identical preset rows and three mode
        // rows are where a mis-paste lands, and the separator (no action) must stay inert.
        const rec = acts();
        const rows = keyframeMenu({ ...base, lock: "Lock", hasHandles: true }, rec);
        rows[0].action?.(); // Lock
        rows[1].action?.(); // Delete
        for (const c of rows[2].children ?? []) c.action?.(); // Easing ▸ (separator inert)
        for (const c of rows[3].children ?? []) c.action?.(); // Tangents ▸
        expect(rec.log).toEqual([
            "toggleLock()",
            "remove()",
            `setEase(${Easing.Linear})`,
            `setEase(${Easing.Cubic})`,
            `setEase(${Easing.Quintic})`,
            "chooseCustom()",
            `pickMode(${TangentMode.Mirror})`,
            `pickMode(${TangentMode.Aligned})`,
            `pickMode(${TangentMode.Free})`,
        ]);
    });
});

describe("rulerMenu / appendMenu — the flat two-row menus", () => {
    test("Meters | Seconds, `checked` on the live domain", () => {
        const rec = recorder("pick");
        expect(
            shape(
                rulerMenu(
                    { domain: Domain.Distance, metersEnabled: true, secondsEnabled: true },
                    rec,
                ),
            ),
        ).toEqual([
            { label: "Meters", enabled: true, checked: true },
            { label: "Seconds", enabled: true, checked: false },
        ]);
        expect(
            shape(
                rulerMenu({ domain: Domain.Time, metersEnabled: false, secondsEnabled: true }, rec),
            ),
        ).toEqual([
            { label: "Meters", enabled: false, checked: false },
            { label: "Seconds", enabled: true, checked: true },
        ]);
    });
    test("each ruler row picks its OWN domain", () => {
        const rec = recorder("pick");
        const rows = rulerMenu(
            { domain: Domain.Distance, metersEnabled: true, secondsEnabled: true },
            rec,
        );
        for (const r of rows) r.action?.();
        expect(rec.log).toEqual([`pick(${Domain.Distance})`, `pick(${Domain.Time})`]);
    });
    test("the append flyout: Geo | Force, both always live, each with its a11y name", () => {
        const rec = recorder("append");
        expect(shape(appendMenu(rec))).toEqual([
            { label: "Geo", aria: "Append geometry section" },
            { label: "Force", aria: "Append force section" },
        ]);
        for (const r of appendMenu(rec)) r.action?.();
        expect(rec.log).toEqual([`append(${SectionKind.Geo})`, `append(${SectionKind.Force})`]);
    });
});

// ── the builders' purity is a MODULE-GRAPH property, not a claim about their bodies. A grammar
// oracle over `menus.ts` is only pure if importing it drags in nothing — no ECS, no shallot
// barrel, no `localStorage`. `refine.test.ts`'s walker is the precedent; this is the same
// mechanism pointed at the menu builders.
describe("menus.ts module graph — the builders import nothing impure", () => {
    /** every `src` module reachable from an entry, over every sibling specifier in the source —
     *  static, type-only, dynamic, or a `new URL` worker entry alike. Type-only imports count even
     *  though a bundler erases them: the source dependency is what a later edit turns back into a
     *  runtime one. */
    function reach(entry: string): Set<string> {
        const seen = new Set<string>();
        const queue = [entry];
        for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
            if (seen.has(file)) continue;
            seen.add(file);
            const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
            for (const [, name] of source.matchAll(/"\.\/([\w-]+(?:\.\w+)?)"/g))
                queue.push(name.includes(".") ? name : `${name}.ts`);
        }
        return seen;
    }
    const imports = (file: string, spec: string): boolean =>
        readFileSync(join(import.meta.dir, "..", "src", file), "utf8").includes(`"${spec}"`);

    test("the graph reaches the pure atoms and stops there", () => {
        // `magnet.ts` is the walker's positive control: it DOES reach the preference home, so a
        // walker that found nothing anywhere would fail here first.
        expect(reach("magnet.ts")).toContain("settings.ts");
        const graph = reach("menus.ts");
        expect([...graph].sort()).toEqual([
            "bake.ts",
            "forward.ts",
            "menu.ts",
            "menus.ts",
            "profile.ts",
            "section.ts",
            "spline.ts",
        ]);
        // the ECS layer and the per-user preference home are what a stray `SectionKind` import
        // used to drag in.
        expect(graph).not.toContain("track.ts");
        expect(graph).not.toContain("settings.ts");
    });

    test("nothing in the graph imports the shallot barrel", () => {
        // `track.ts` is this assert's positive control — it's the ECS module, so it DOES.
        expect(imports("track.ts", "@dylanebert/shallot")).toBe(true);
        for (const file of reach("menus.ts"))
            expect(imports(file, "@dylanebert/shallot")).toBe(false);
    });
});
