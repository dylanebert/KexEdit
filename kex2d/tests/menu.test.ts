import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
    BINDINGS,
    type Binding,
    flyoutFit,
    GROUPS,
    type MenuGroup,
    type MenuItem,
    menuFit,
    menuRows,
} from "../src/menu";
import * as menus from "../src/menus";
import {
    appendMenu,
    keyframeMenu,
    type KeyframeMenuState,
    nodeMenu,
    type NodeMenuState,
    rulerMenu,
    type RulerMenuState,
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
    group?: MenuGroup;
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
            group: i.group,
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
        pinSolvable: false,
        kind: SectionKind.Geo,
        multi: false,
        modeOpen: false,
        canSolve: true,
        canSolveShape: false,
        canPin: false,
        canReset: true,
        canDelete: true,
    };
    const acts = () =>
        recorder(
            "solve",
            "solveShape",
            "pinSolve",
            "pinExit",
            "pinEnter",
            "reset",
            "remove",
            "removeSet",
        );

    test("a single GEO section: Convert, Reset, Delete", () => {
        expect(shape(sectionMenu(base, acts()))).toEqual([
            { label: "Convert", group: "modify", enabled: true },
            { label: "Reset", group: "lifecycle", enabled: true },
            { label: "Delete", group: "lifecycle", shortcut: "Del", danger: true, enabled: true },
        ]);
    });
    test("a single FORCE section adds Pin between Convert and Reset", () => {
        const s = {
            ...base,
            kind: SectionKind.Force,
            canSolve: false,
            canSolveShape: true,
            canPin: true,
        };
        expect(shape(sectionMenu(s, acts()))).toEqual([
            { label: "Convert", group: "modify", enabled: true },
            { label: "Pin", group: "modify", enabled: true },
            { label: "Reset", group: "lifecycle", enabled: true },
            { label: "Delete", group: "lifecycle", shortcut: "Del", danger: true, enabled: true },
        ]);
    });
    test("a multi-set grays the single-subject rows and drops Pin (force set included)", () => {
        const s = {
            ...base,
            kind: SectionKind.Force,
            multi: true,
            canSolve: false,
            canSolveShape: false,
            canPin: false,
            canReset: false,
        };
        expect(shape(sectionMenu(s, acts()))).toEqual([
            { label: "Convert", group: "modify", enabled: false },
            { label: "Reset", group: "lifecycle", enabled: false },
            { label: "Delete", group: "lifecycle", shortcut: "Del", danger: true, enabled: true },
        ]);
    });
    test("an open session on ANOTHER section still grays Pin on this one", () => {
        const s = { ...base, kind: SectionKind.Force, canPin: true, modeOpen: true };
        expect(shape(sectionMenu(s, acts()))[1]).toEqual({
            label: "Pin",
            group: "modify",
            enabled: false,
        });
    });
    test("in-mode on THIS section: the mode's own two rows replace the menu", () => {
        const s = {
            ...base,
            kind: SectionKind.Force,
            inMode: true,
            modeOpen: true,
            pinSolvable: true,
        };
        expect(shape(sectionMenu(s, acts()))).toEqual([
            { label: "Solve", group: "modify", enabled: true },
            { label: "Exit", group: "modify", shortcut: "Esc" },
        ]);
        expect(shape(sectionMenu({ ...s, solving: true }, acts()))[0].enabled).toBe(false);
        expect(shape(sectionMenu({ ...s, pinSolvable: false }, acts()))[0].enabled).toBe(false);
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
        group: "modify",
        enabled,
        children: [
            { label: "Mirror", group: "modify", checked: mode === TangentMode.Mirror },
            { label: "Aligned", group: "modify", checked: mode === TangentMode.Aligned },
            { label: "Free", group: "modify", checked: mode === TangentMode.Free },
        ],
    });
    const handles = (checked: boolean | undefined, enabled: boolean): Row => ({
        label: "Handles",
        group: "modify",
        checked,
        enabled,
    });
    const del = (enabled: boolean): Row => ({
        label: "Delete",
        group: "lifecycle",
        shortcut: "Del",
        danger: true,
        enabled,
    });
    const add = (enabled: boolean): Row => ({
        label: "Add",
        group: "create",
        shortcut: "Enter",
        enabled,
    });
    const reset = (enabled: boolean): Row => ({ label: "Reset", group: "lifecycle", enabled });

    test("an INTERIOR node: Add + Delete both gated off, Handles / Tangents / Reset between", () => {
        expect(shape(nodeMenu(base, acts()))).toEqual([
            add(false),
            handles(false, true),
            tangents(true, TangentMode.Aligned),
            reset(true),
            del(false),
        ]);
    });
    test("a CHAIN-END node lights Add + Delete; the mode check follows the target", () => {
        const s = { ...base, isEnd: true, canTrim: true, editing: true, mode: TangentMode.Free };
        expect(shape(nodeMenu(s, acts()))).toEqual([
            add(true),
            handles(true, true),
            tangents(true, TangentMode.Free),
            reset(true),
            del(true),
        ]);
    });
    test("NODE 0 carries Handles + Reset only (no Add/Delete, no mode submenu)", () => {
        expect(shape(nodeMenu({ ...base, isEntry: true }, acts()))).toEqual([
            handles(false, true),
            reset(true),
        ]);
    });
    test("NODE 0's Handles check lights in tangent edit, like every other node's", () => {
        expect(shape(nodeMenu({ ...base, isEntry: true, editing: true }, acts()))).toEqual([
            handles(true, true),
            reset(true),
        ]);
    });
    test("node 0's rows act on the single target — Reset is `reset`, never `resetSet`", () => {
        const rec = acts();
        const rows = nodeMenu({ ...base, isEntry: true }, rec);
        rows[0].action?.();
        rows[1].action?.();
        expect(rec.log).toEqual(["toggleHandles()", "reset()"]);
    });
    test("a MULTI set holding node 0 keeps the bulk menu — the multi fork outranks isEntry", () => {
        // shift-click node 0 into a set, then right-click it: the set is the subject, so the bulk
        // rows win. node 0's own two-row menu is the SINGLE-subject shape only.
        const s = { ...base, multi: true, isEntry: true, suffixOk: true, mode: TangentMode.Mirror };
        expect(shape(nodeMenu(s, acts()))).toEqual([
            add(false),
            handles(undefined, false),
            tangents(true, TangentMode.Mirror),
            reset(true),
            del(true),
        ]);
    });
    test("a MULTI set: bulk Delete on a suffix run, Add + Handles grayed, no Handles check", () => {
        const s = { ...base, multi: true, suffixOk: true, mode: TangentMode.Mirror };
        expect(shape(nodeMenu(s, acts()))).toEqual([
            add(false),
            handles(undefined, false),
            tangents(true, TangentMode.Mirror),
            reset(true),
            del(true),
        ]);
    });
    test("the lockdown grays every edit row, single and multi alike", () => {
        const single = shape(nodeMenu({ ...base, ok: false, isEnd: true, canTrim: true }, acts()));
        expect(single.map((r) => r.enabled)).toEqual([false, false, false, false, false]);
        const multi = shape(nodeMenu({ ...base, ok: false, multi: true, suffixOk: true }, acts()));
        expect(multi.map((r) => r.enabled)).toEqual([false, false, false, false, false]);
        const zero = shape(nodeMenu({ ...base, ok: false, isEntry: true }, acts()));
        expect(zero.map((r) => r.enabled)).toEqual([false, false]);
    });
    test("the single rows act on the target, the multi rows on the set", () => {
        // EVERY submenu row is invoked, in order: three near-identical copy-pasted rows per branch
        // is exactly where a mis-paste (a set row bound to the single action, or two rows sharing
        // one mode) lands, and a one-of-three spot check can't see it.
        const one = acts();
        const rows = nodeMenu(base, one);
        rows[0].action?.();
        rows[1].action?.();
        for (const c of rows[2].children ?? []) c.action?.();
        rows[3].action?.();
        rows[4].action?.();
        expect(one.log).toEqual([
            "add()",
            "toggleHandles()",
            `pickMode(${TangentMode.Mirror})`,
            `pickMode(${TangentMode.Aligned})`,
            `pickMode(${TangentMode.Free})`,
            "reset()",
            "remove()",
        ]);
        const set = acts();
        const bulk = nodeMenu({ ...base, multi: true }, set);
        for (const c of bulk[2].children ?? []) c.action?.();
        bulk[3].action?.();
        bulk[4].action?.();
        expect(set.log).toEqual([
            `pickModeSet(${TangentMode.Mirror})`,
            `pickModeSet(${TangentMode.Aligned})`,
            `pickModeSet(${TangentMode.Free})`,
            "resetSet()",
            "removeSet()",
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
        group: "modify",
        enabled,
        children: [
            {
                label: "Linear",
                group: "modify",
                glyph: "preset:0",
                checked: checked === Easing.Linear,
            },
            {
                label: "Cubic",
                group: "modify",
                glyph: "preset:1",
                checked: checked === Easing.Cubic,
            },
            {
                label: "Quintic",
                group: "modify",
                glyph: "preset:2",
                checked: checked === Easing.Quintic,
            },
            // the ONE authored separator left in the app: a WITHIN-group divider (the preset picks
            // from Custom), a position no derived group boundary can occupy.
            { separator: true },
            {
                label: "Custom",
                group: "modify",
                enabled: customEnabled,
                glyph: "custom:glyph",
                checked: custom,
            },
        ],
    });
    const del = (enabled: boolean): Row => ({
        label: "Delete",
        group: "lifecycle",
        shortcut: "Del",
        danger: true,
        enabled,
    });

    test("a single NON-TERMINAL keyframe: Easing ▸ (the tag checked) then Delete", () => {
        expect(shape(keyframeMenu(base, acts()))).toEqual([
            easing(true, Easing.Cubic, true),
            del(true),
        ]);
    });
    test("a single TERMINAL keyframe shows Delete alone", () => {
        expect(shape(keyframeMenu({ ...base, terminal: true, easeTargets: 0 }, acts()))).toEqual([
            del(true),
        ]);
    });
    test("a MULTI set keeps Easing ▸ even on a terminal active, graying Custom", () => {
        const s = { ...base, multi: true, terminal: true, easeTargets: 2 };
        expect(shape(keyframeMenu(s, acts()))).toEqual([
            easing(true, Easing.Cubic, false),
            del(true),
        ]);
    });
    test("no applicable easing target grays the row; an explicit handle unchecks the preset", () => {
        const s = { ...base, easeTargets: 0, custom: true };
        expect(shape(keyframeMenu(s, acts()))[0]).toEqual(easing(false, null, true, true));
    });
    test("in-mode: the Lock row leads, and Delete still lands last", () => {
        const locked = shape(keyframeMenu({ ...base, lock: "Lock" }, acts()));
        expect(locked[0]).toEqual({ label: "Lock", group: "modify", shortcut: "Q" });
        expect(locked.at(-1)).toEqual(del(true));
        expect(locked).toHaveLength(3);
        expect(shape(keyframeMenu({ ...base, lock: "Unlock" }, acts()))[0]).toEqual({
            label: "Unlock",
            group: "modify",
            shortcut: "Q",
        });
    });
    test("explicit handles add the Tangents ▸ submenu, checked by the stored mode, above Delete", () => {
        const s = { ...base, hasHandles: true, mode: TangentMode.Mirror };
        expect(shape(keyframeMenu(s, acts())).at(-2)).toEqual({
            label: "Tangents",
            group: "modify",
            enabled: true,
            children: [
                { label: "Mirror", group: "modify", checked: true },
                { label: "Aligned", group: "modify", checked: false },
                { label: "Free", group: "modify", checked: false },
            ],
        });
    });
    test("the lockdown: the set gates Delete + Easing, the active member gates Custom", () => {
        const rows = shape(
            keyframeMenu({ ...base, setOk: false, activeOk: false, hasHandles: true }, acts()),
        );
        expect(rows[0].enabled).toBe(false); // Easing ▸
        expect(rows[0].children?.[4].enabled).toBe(false); // …its Custom row
        expect(rows[1].enabled).toBe(false); // Tangents ▸
        expect(rows[2].enabled).toBe(false); // Delete
    });
    test("the rows act on their subjects", () => {
        // every submenu row is invoked, in order — three near-identical preset rows and three mode
        // rows are where a mis-paste lands, and the separator (no action) must stay inert.
        const rec = acts();
        const rows = keyframeMenu({ ...base, lock: "Lock", hasHandles: true }, rec);
        rows[0].action?.(); // Lock
        for (const c of rows[1].children ?? []) c.action?.(); // Easing ▸ (separator inert)
        for (const c of rows[2].children ?? []) c.action?.(); // Tangents ▸
        rows[3].action?.(); // Delete
        expect(rec.log).toEqual([
            "toggleLock()",
            `setEase(${Easing.Linear})`,
            `setEase(${Easing.Cubic})`,
            `setEase(${Easing.Quintic})`,
            "chooseCustom()",
            `pickMode(${TangentMode.Mirror})`,
            `pickMode(${TangentMode.Aligned})`,
            `pickMode(${TangentMode.Free})`,
            "remove()",
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
            { label: "Meters", group: "modify", enabled: true, checked: true },
            { label: "Seconds", group: "modify", enabled: true, checked: false },
        ]);
        expect(
            shape(
                rulerMenu({ domain: Domain.Time, metersEnabled: false, secondsEnabled: true }, rec),
            ),
        ).toEqual([
            { label: "Meters", group: "modify", enabled: false, checked: false },
            { label: "Seconds", group: "modify", enabled: true, checked: true },
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
            { label: "Geo", group: "create", aria: "Append geometry section" },
            { label: "Force", group: "create", aria: "Append force section" },
        ]);
        for (const r of appendMenu(rec)) r.action?.();
        expect(rec.log).toEqual([`append(${SectionKind.Geo})`, `append(${SectionKind.Force})`]);
    });
});

// ── the GRAMMAR ORACLE (kex2d-menu-grammar stage 2). The characterization suite above pins what
// each menu says today; this pins the LAW every menu obeys — and it runs over EVERY builder across
// its FULL state matrix, so a menu added later is caught by this same code rather than by someone
// remembering to hand-write asserts for it. `builders` below is checked exhaustive against the
// module's own exports, so a new builder that isn't given a matrix fails here.
describe("the menu grammar — every builder, every state", () => {
    // A state matrix is a per-field candidate list; the oracle walks its full cartesian product.
    // Fields are ASSIGNED one by one, never spread from a shared object: an app descriptor may
    // carry lazy getters (an expensive predicate a builder branch might never read), and a spread
    // collapses them — the oracle must not model a descriptor in a shape the app can't hand it.
    type Matrix<S> = { [K in keyof S]: readonly S[K][] };
    function states<S extends object>(matrix: Matrix<S>): S[] {
        let out: S[] = [{} as S];
        for (const key of Object.keys(matrix) as (keyof S)[]) {
            const next: S[] = [];
            for (const partial of out)
                for (const value of matrix[key]) {
                    const s = {} as S;
                    for (const k of Object.keys(partial) as (keyof S)[]) s[k] = partial[k];
                    s[key] = value;
                    next.push(s);
                }
            out = next;
        }
        return out;
    }

    const bool = [false, true] as const;
    const modes = [TangentMode.Mirror, TangentMode.Aligned, TangentMode.Free] as const;

    const sectionStates = states<SectionMenuState>({
        inMode: bool,
        solving: bool,
        pinSolvable: bool,
        kind: [SectionKind.Geo, SectionKind.Force, null],
        multi: bool,
        modeOpen: bool,
        canSolve: bool,
        canSolveShape: bool,
        canPin: bool,
        canReset: bool,
        canDelete: bool,
    });
    const nodeStates = states<NodeMenuState>({
        multi: bool,
        isEntry: bool,
        ok: bool,
        mode: modes,
        editing: bool,
        isEnd: bool,
        canTrim: bool,
        suffixOk: bool,
    });
    const keyframeStates = states<KeyframeMenuState>({
        setOk: bool,
        activeOk: bool,
        lock: ["Lock", "Unlock", null],
        multi: bool,
        terminal: bool,
        easeTargets: [0, 1, 2],
        custom: bool,
        ease: [Easing.Linear, Easing.Cubic, Easing.Quintic],
        hasHandles: bool,
        mode: modes,
        presetGlyph: [(e: Easing) => `preset:${e}`],
        customGlyph: ["custom:glyph"],
    });
    const rulerStates = states<RulerMenuState>({
        domain: [Domain.Distance, Domain.Time],
        metersEnabled: bool,
        secondsEnabled: bool,
    });

    // every menu the app can summon, as `(name, rows, state)` triples — the oracle's whole input.
    // The state rides along because several laws are state-SENSITIVE: whether a toggle addresses a
    // single subject or a set decides whether it may carry a checkmark at all, and a law keyed on
    // the label alone can't see that (the stage-2 review's finding).
    type Menu = { name: string; rows: MenuItem[]; state: object };
    function corpus(): Menu[] {
        const all: Menu[] = [];
        const acts = () =>
            recorder(
                "solve",
                "solveShape",
                "pinSolve",
                "pinExit",
                "pinEnter",
                "reset",
                "remove",
                "removeSet",
                "add",
                "toggleHandles",
                "pickMode",
                "pickModeSet",
                "resetSet",
                "toggleLock",
                "setEase",
                "chooseCustom",
                "pick",
                "append",
            );
        for (const s of sectionStates)
            all.push({ name: "sectionMenu", rows: sectionMenu(s, acts()), state: s });
        for (const s of nodeStates)
            all.push({ name: "nodeMenu", rows: nodeMenu(s, acts()), state: s });
        for (const s of keyframeStates)
            all.push({ name: "keyframeMenu", rows: keyframeMenu(s, acts()), state: s });
        for (const s of rulerStates)
            all.push({ name: "rulerMenu", rows: rulerMenu(s, acts()), state: s });
        all.push({ name: "appendMenu", rows: appendMenu(acts()), state: {} });
        return all;
    }
    // every menu AND every submenu, flattened — a flyout is a menu, so the same laws hold in it.
    // A submenu inherits its parent's name as a `▸` path (the registries below address rows by it)
    // and its parent's state (the flyout is summoned from the same subject).
    function levels(): Menu[] {
        const out: Menu[] = [];
        const walk = (name: string, rows: MenuItem[], state: object): void => {
            out.push({ name, rows, state });
            for (const row of rows)
                if (row.children) walk(`${name} ▸ ${row.label}`, row.children, state);
        };
        for (const menu of corpus()) walk(menu.name, menu.rows, menu.state);
        return out;
    }
    const label = (name: string, rows: MenuItem[]): string =>
        `${name}: [${rows.map((r) => (r.separator ? "—" : `${r.label}/${r.group}`)).join(", ")}]`;

    // Every callable `menus.ts` exports is a builder unless it is named here. Filtering on a
    // `Menu` SUFFIX instead would let an `easingSubmenu` / `contextRows` / a re-exported row helper
    // slip past BOTH sides of the equality below and stay silently ungated with the oracle green;
    // callable-minus-allowlist fails closed instead. Empty today — `menus.ts` exports builders and
    // types only. A helper that has to be exported goes here WITH its reason.
    const NotBuilders = new Set<string>([]);

    test("the corpus covers every builder `menus.ts` exports", () => {
        // the completeness pin: a builder added later with no matrix here is not silently ungated.
        const covered = new Set(corpus().map((m) => m.name.replace(/ ▸.*/, "")));
        const exported = Object.entries(menus)
            .filter(([k, v]) => typeof v === "function" && !NotBuilders.has(k))
            .map(([k]) => k);
        expect([...covered].sort()).toEqual(exported.sort());
    });

    // Violations are COLLECTED, deduped by their own message, and asserted empty — a grammar
    // oracle that threw on the first bad menu would report one and hide the rest, and the whole
    // point of running the full matrix is seeing every menu that breaks the law at once.
    function violations(check: (menu: Menu) => string[]): string[] {
        const seen = new Set<string>();
        for (const menu of levels()) for (const v of check(menu)) seen.add(v);
        return [...seen].sort();
    }

    test("every non-separator row declares a group", () => {
        expect(
            violations(({ name, rows }) =>
                rows
                    .filter((r) => !r.separator && !GROUPS.includes(r.group as MenuGroup))
                    .map((r) => `${label(name, rows)} — "${r.label}" declares no group`),
            ),
        ).toEqual([]);
    });

    test("groups are non-decreasing in canonical order", () => {
        expect(
            violations(({ name, rows }) => {
                const items = rows.filter((r) => !r.separator);
                const rank = (r: MenuItem): number => GROUPS.indexOf(r.group as MenuGroup);
                return items
                    .filter((r, i) => i > 0 && rank(r) < rank(items[i - 1]))
                    .map(
                        (r) =>
                            `${label(name, rows)} — "${r.label}" (${r.group}) sorts before its predecessor`,
                    );
            }),
        ).toEqual([]);
    });

    test("`danger` appears only on the menu's terminal row", () => {
        expect(
            violations(({ name, rows }) =>
                rows
                    .filter((r, i) => r.danger && i !== rows.length - 1)
                    .map((r) => `${label(name, rows)} — "${r.label}" is danger but not terminal`),
            ),
        ).toEqual([]);
    });

    test("an explicit separator is a WITHIN-group divider only", () => {
        // every group boundary's divider is DERIVED (`menuRows`), so an authored one is legal only
        // where a derived one can never land: interior, and between two rows of the same group.
        expect(
            violations(({ name, rows }) => {
                const bad: string[] = [];
                for (let i = 0; i < rows.length; i++) {
                    if (!rows[i].separator) continue;
                    const where = `${label(name, rows)} — separator at ${i}`;
                    if (i === 0 || i === rows.length - 1) bad.push(`${where} is first or last`);
                    else if (rows[i + 1].group !== rows[i - 1].group)
                        bad.push(`${where} straddles a group change`);
                }
                return bad;
            }),
        ).toEqual([]);
    });

    // ── `checked` means exactly ONE thing: this row's state is currently in effect (stage 3).
    // The shape check below (boolean, has an action, not a submenu parent, not danger) is a floor,
    // not the law — it admits `checked` on nearly every act row in the app, so it could never catch
    // a row lighting up for "recently used" or "this is the default". The law is this DECLARED
    // REGISTRY: a row may carry `checked` iff its path is here, and each entry names the state the
    // check reports. Adding a `checked` needs a line here that reads as a state in effect right
    // now; a state that only "was" or "would be" has no honest entry to write.
    const Checked: Record<string, string> = {
        // the node's handles are summoned right now (`editor.tangentEdit` is this node).
        "nodeMenu ▸ Handles": "the handles are on screen for this node",
        // the node's DISPLAYED tangent mode — the pick governing its curve right now.
        "nodeMenu ▸ Tangents ▸ Mirror": "this node's tangents are mirrored",
        "nodeMenu ▸ Tangents ▸ Aligned": "this node's tangents are aligned",
        "nodeMenu ▸ Tangents ▸ Free": "this node's tangents are free",
        // the easing tag governing the addressed segment right now — cleared while explicit
        // handles bound it, so exactly one of the four Easing rows is ever lit.
        "keyframeMenu ▸ Easing ▸ Linear": "this segment is driven by the Linear tag",
        "keyframeMenu ▸ Easing ▸ Cubic": "this segment is driven by the Cubic tag",
        "keyframeMenu ▸ Easing ▸ Quintic": "this segment is driven by the Quintic tag",
        "keyframeMenu ▸ Easing ▸ Custom":
            "an explicit handle bounds this segment (derived provenance)",
        // the keyframe's stored tangent mode, governing its handles right now.
        "keyframeMenu ▸ Tangents ▸ Mirror": "this keyframe's handles are mirrored",
        "keyframeMenu ▸ Tangents ▸ Aligned": "this keyframe's handles are aligned",
        "keyframeMenu ▸ Tangents ▸ Free": "this keyframe's handles are free",
        // the store's own unit (`Track.domain`) — what the chart reads right now.
        "rulerMenu ▸ Meters": "the track domain is meters of arclength",
        "rulerMenu ▸ Seconds": "the track domain is seconds of march time",
    };

    test("`checked` appears on exactly the DECLARED state-declaring rows", () => {
        // both directions: an undeclared row that lights up fails, and so does a declared entry
        // whose row no longer carries a check (a stale registry is a lie of its own).
        const lit = new Set<string>();
        for (const { name, rows } of levels())
            for (const row of rows)
                if (row.checked !== undefined) lit.add(`${name} ▸ ${row.label}`);
        expect([...lit].sort()).toEqual(Object.keys(Checked).sort());
    });

    test("a state-declaring row is a leaf pick: boolean, actioned, never a parent or destructive", () => {
        // the shape floor under the registry — a check reports a state the row's OWN press sets.
        expect(
            violations(({ name, rows }) => {
                const bad: string[] = [];
                for (const row of rows) {
                    if (row.checked === undefined) continue;
                    const where = `${label(name, rows)} — "${row.label}"`;
                    if (typeof row.checked !== "boolean")
                        bad.push(`${where} checked is not a boolean`);
                    if (!row.action) bad.push(`${where} is checked with no action`);
                    if (row.children) bad.push(`${where} is a checked submenu parent`);
                    if (row.danger) bad.push(`${where} is checked AND danger`);
                }
                return bad;
            }),
        ).toEqual([]);
    });

    // ── toggle labeling follows SET-VALUEDNESS (stage 3). A toggle over a single subject keeps a
    // stable label and reports its state with `checked`; a toggle over a set whose members can
    // disagree flips its label to name the act the press performs instead, because a checkmark
    // cannot express a mixed set. That is the constraint `lockLabel` was actually written against.
    test("the single-subject toggle keeps its label and carries the check", () => {
        // `Handles` — one node, so the label never moves and the check reports that node's own
        // state. On a multi-set it has no single subject at all: it grays and drops the check
        // rather than inventing a label flip.
        expect(
            violations(({ name, rows, state }) => {
                if (name !== "nodeMenu") return [];
                const s = state as NodeMenuState;
                const bad: string[] = [];
                for (const row of rows) {
                    if (row.label !== "Handles") continue;
                    const where = `${label(name, rows)} — "Handles"`;
                    if (s.multi && row.checked !== undefined)
                        bad.push(`${where} checks a multi-SET (a checkmark can't express a mix)`);
                    if (!s.multi && typeof row.checked !== "boolean")
                        bad.push(`${where} is single-subject but reports no state`);
                }
                return bad;
            }),
        ).toEqual([]);
        // and it is ONE row under one name: `Handles` never shows beside a second spelling of
        // itself, the way a flipping toggle's two labels would if they ever both materialized.
        expect(
            violations(({ name, rows }) => {
                const hits = rows.filter((r) => r.label === "Handles");
                return hits.length > 1 ? [`${label(name, rows)} — two Handles rows`] : [];
            }),
        ).toEqual([]);
    });

    test("the set-valued toggle flips its label to the act and never carries a check", () => {
        // `Lock`/`Unlock` — the selected keyframe SET, whose members can disagree. Both labels must
        // be reachable (a toggle that never flips is single-subject and owes a checkmark instead),
        // and neither may ever light up.
        const seen = new Set<string>();
        expect(
            violations(({ name, rows, state }) => {
                if (name !== "keyframeMenu") return [];
                const s = state as KeyframeMenuState;
                const bad: string[] = [];
                const pair = rows.filter((r) => r.label === "Lock" || r.label === "Unlock");
                // the two labels are one row wearing two names — never two rows.
                if (pair.length > 1) bad.push(`${label(name, rows)} — Lock and Unlock co-occur`);
                for (const row of rows) {
                    if (row.label !== "Lock" && row.label !== "Unlock") continue;
                    seen.add(row.label);
                    const where = `${label(name, rows)} — "${row.label}"`;
                    if (row.checked !== undefined)
                        bad.push(`${where} carries a check over a SET that can disagree`);
                    if (row.label !== s.lock)
                        bad.push(`${where} does not name the act its state demands (${s.lock})`);
                }
                return bad;
            }),
        ).toEqual([]);
        expect([...seen].sort()).toEqual(["Lock", "Unlock"]);
    });

    // ── `shortcut` appears iff a keyboard binding invokes the SAME action (stage 3). The table
    // itself now lives in `src/menu.ts` and both halves read it — the handler matches on `keys`,
    // the builder prints `hint` — so a rebind moves the hint with it. What's left for the oracle is
    // (a) which ROW each binding belongs to, and (b) that the handlers still go through the table
    // rather than a re-inlined literal (the `L` → `Q` rebind is the precedent, and a table anchored
    // to nothing would have stayed green through it).
    const Rows: Record<string, keyof typeof BINDINGS> = {
        Delete: "remove",
        Add: "append",
        Exit: "exitMode",
        Lock: "lock",
        Unlock: "lock",
    };

    test("`shortcut` is present iff a keyboard binding invokes that row's action", () => {
        // `Handles` is double-click — a pointer gesture is not a shortcut, so it declares nothing.
        expect(
            violations(({ name, rows }) => {
                const bad: string[] = [];
                for (const row of rows) {
                    if (row.separator) continue;
                    const binding = Rows[row.label ?? ""];
                    const hint = binding === undefined ? undefined : BINDINGS[binding].hint;
                    const where = `${label(name, rows)} — "${row.label}"`;
                    if (row.shortcut !== hint)
                        bad.push(
                            `${where} shows ${JSON.stringify(row.shortcut)}, the binding table says ${JSON.stringify(hint)}`,
                        );
                    // the hint names the row's ACTION, not its live enablement — a grayed `Add`
                    // still tells you append is Enter. But an ENABLED row promising a key while
                    // carrying nothing to invoke is a plain lie.
                    if (row.shortcut !== undefined && !row.action && row.enabled !== false)
                        bad.push(`${where} advertises a key while live with no action`);
                }
                return bad;
            }),
        ).toEqual([]);
    });

    // the handler modules whose key press invokes the same action the row does — the other end of
    // each binding. Both ends read `src/menu.ts`'s table, so this pins that they still do.
    const Handlers: Record<keyof typeof BINDINGS, string[]> = {
        remove: ["controls.ts", "Timeline.svelte", "App.svelte"],
        append: ["controls.ts"],
        exitMode: ["App.svelte"],
        lock: ["Timeline.svelte"],
    };
    // a bound key also drives presses that are NOBODY's menu row — dismissal rungs, a field's
    // commit-and-blur. Those stay raw literals, and this is exactly which files may hold one; any
    // other file comparing a bound key raw is a handler that slipped out of the table.
    const RawKeys: Record<string, { files: string[]; why: string }> = {
        Delete: { files: [], why: "every Del press is the remove binding" },
        Backspace: { files: [], why: "Del's twin, same binding" },
        Enter: {
            files: ["App.svelte", "Timeline.svelte"],
            why: "a popover field's commit-and-blur — not the Add row's append",
        },
        Escape: {
            files: ["App.svelte", "Timeline.svelte", "controls.ts"],
            why: "the dismissal ladder (modal cancel, menu close, landing skip, marquee/drag/selection peel) — none of them the Exit row",
        },
        q: { files: [], why: "the lock toggle only" },
        Q: { files: [], why: "the lock toggle only" },
    };
    const src = (file: string): string =>
        readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
    const srcFiles = readdirSync(join(import.meta.dir, "..", "src")).filter(
        (f) => f.endsWith(".ts") || f.endsWith(".svelte"),
    );

    test("each binding's hint names its own key", () => {
        // `keys` and `hint` are two fields of one entry, so a rebind that edits only the keys would
        // still desync the row. The hint is the key's display form: two irregular abbreviations,
        // everything else the key itself (a single character upper-cased).
        const Abbrev: Record<string, string> = { Delete: "Del", Escape: "Esc" };
        for (const [name, binding] of Object.entries<Binding>(BINDINGS)) {
            const primary = binding.keys[0];
            const shown =
                Abbrev[primary] ?? (primary.length === 1 ? primary.toUpperCase() : primary);
            expect(binding.hint, `the "${name}" binding's hint`).toBe(shown);
        }
    });

    test("each binding's own handlers read the shared table", () => {
        // a handler that re-inlines its key drops out of here — the drift this stage exists to
        // close, since the hint would then stand still while the key moved.
        // asserted as a boolean, not `toContain`: a failing `toContain` dumps the whole module.
        for (const [name, files] of Object.entries(Handlers))
            for (const file of files)
                expect(
                    src(file).includes(`BINDINGS.${name}`),
                    `${file} must reach the "${name}" binding through BINDINGS.${name}`,
                ).toBe(true);
    });

    test("no module compares a bound key raw outside the declared non-row presses", () => {
        for (const [key, { files }] of Object.entries(RawKeys)) {
            const pattern = new RegExp(`key\\s*[!=]==\\s*"${key}"`);
            const found = srcFiles.filter((f) => f !== "menu.ts" && pattern.test(src(f)));
            expect(found.sort(), `raw "${key}" comparisons`).toEqual([...files].sort());
        }
    });

    // the divider count is not the law — a renderer emitting every derived divider ONE ROW LATE
    // keeps the count, the subsequence, the no-two-adjacent rule and the not-first/last rule, and
    // renders `Add | Handles | — | Tangents | Reset | — | Delete`. So the assert is POSITIONAL:
    // `gaps` reads how many dividers sit in each slot between consecutive rows (slot 0 = before the
    // first row, slot n = after the last), and each slot's rendered count is pinned against what
    // the authored rows demand there.
    function gaps(rows: MenuItem[]): number[] {
        const out = [0];
        for (const row of rows) {
            if (row.separator) out[out.length - 1]++;
            else out.push(0);
        }
        return out;
    }

    test("`menuRows` puts a divider in exactly the slots that demand one", () => {
        for (const { name, rows } of levels()) {
            const rendered = menuRows(rows);
            const authored = rows.filter((r) => !r.separator);
            const where = label(name, rows);
            expect(
                rendered.filter((r) => !r.separator),
                where,
            ).toEqual(authored);
            const demanded = gaps(rows);
            const actual = gaps(rendered);
            expect(actual.length, `${where} — row count changed`).toBe(demanded.length);
            for (let k = 0; k < demanded.length; k++) {
                // an outer slot never carries one (nothing to divide); an interior slot carries
                // exactly one iff the group changes there OR the builder authored a within-group
                // divider — the two collapse rather than doubling up.
                const inner = k > 0 && k < demanded.length - 1;
                const change = inner && authored[k].group !== authored[k - 1].group;
                expect(actual[k], `${where} — slot ${k} divider count`).toBe(
                    inner && (change || demanded[k] > 0) ? 1 : 0,
                );
            }
        }
    });
});

// `menuRows` is a public seam other menus will call, so its edge cases are pinned directly rather
// than left to the corpus above (which reaches none of them: no shipping builder authors a
// separator at a group boundary or an empty menu). Correct by construction, not by the oracle's
// within-group law holding forever.
describe("menuRows — the renderer's own edge cases", () => {
    const row = (label: string, group: MenuGroup): MenuItem => ({ label, group });
    const sep: MenuItem = { separator: true };

    test("an authored separator AT a group boundary collapses with the derived one", () => {
        expect(menuRows([row("Add", "create"), sep, row("Reset", "lifecycle")])).toEqual([
            row("Add", "create"),
            { separator: true },
            row("Reset", "lifecycle"),
        ]);
    });
    test("adjacent authored separators collapse to one", () => {
        expect(menuRows([row("Handles", "modify"), sep, sep, row("Custom", "modify")])).toEqual([
            row("Handles", "modify"),
            { separator: true },
            row("Custom", "modify"),
        ]);
    });
    test("leading and trailing separators are dropped", () => {
        expect(menuRows([sep, row("Handles", "modify"), sep])).toEqual([row("Handles", "modify")]);
    });
    test("a menu of nothing but separators renders empty", () => {
        expect(menuRows([sep, sep])).toEqual([]);
        expect(menuRows([])).toEqual([]);
    });
    test("items pass through BY REFERENCE (a builder's descriptor reads are lazy)", () => {
        const item = row("Add", "create");
        expect(menuRows([item])[0]).toBe(item);
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
