import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
    BINDINGS,
    type Binding,
    bound,
    flyoutFit,
    GROUPS,
    type MenuGroup,
    type MenuItem,
    menuFit,
    menuRows,
    type Modifier,
    RESERVED,
    type Reserved,
} from "../src/menu";
import { nudgeAct, type NudgeKeyState, timelineKeyAct, type TimelineKeyState } from "../src/keys";
import * as menus from "../src/menus";
import {
    rowMenu,
    type RowMenuState,
    rulerMenu,
    type RulerMenuState,
    spanMenu,
    type SpanMenuState,
} from "../src/menus";
import { Easing } from "../src/profile";
import { Domain } from "../src/section";

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

describe("rulerMenu — the flat two-row unit picker", () => {
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
});

// ── the lane timeline's own two menus (S3c). The pose era's five builders went with their
// subjects (`retired/pose-ux`); these two replace them, and are characterized the same way.
describe("rowMenu — the lane column's menu", () => {
    const acts = () => recorder("add", "toggleExpand");

    // RED: label the Add row with a bare "Add segment" and the row stops naming WHICH lane it
    // authors into — the one thing a menu summoned on a row of three has to say.
    test("Add names the row's own quantity, then the step-in toggle", () => {
        const a = acts();
        expect(shape(rowMenu({ name: "force", expanded: false, canAdd: true }, a))).toEqual([
            { label: "Add force segment", group: "create", enabled: true },
            { label: "Expand", group: "modify" },
        ]);
    });

    // RED: read `expanded` for a `checked` field instead of the label and the open row's toggle
    // says "Expand" while the row already is — a mixed-capable toggle names its ACTION
    // (`editor-ui.md`).
    test("the toggle names the act it will perform, never the state it is in", () => {
        const a = acts();
        expect(rowMenu({ name: "geo", expanded: true, canAdd: true }, a)[1].label).toBe("Collapse");
        expect(rowMenu({ name: "geo", expanded: false, canAdd: true }, a)[1].label).toBe("Expand");
        // and it carries no check either way: the row is an act, not a state row.
        for (const open of [true, false])
            expect(rowMenu({ name: "geo", expanded: open, canAdd: true }, a)[1].checked).toBe(
                undefined,
            );
    });

    // RED: stub `canAdd` to a constant true and a station inside a record offers an Add that
    // cannot land — grayed, never hidden, is the law the refusal has to reach.
    test("Add grays where the station has no room, and never hides", () => {
        const a = acts();
        const rows = rowMenu({ name: "velocity", expanded: false, canAdd: false }, a);
        expect(rows[0].label).toBe("Add velocity segment");
        expect(rows[0].enabled).toBe(false);
        expect(rows).toHaveLength(2);
    });

    test("each row fires its own act", () => {
        const a = acts();
        for (const r of rowMenu({ name: "force", expanded: false, canAdd: true }, a)) r.action?.();
        expect(a.log).toEqual(["add()", "toggleExpand()"]);
    });
});

describe("spanMenu — the selected record's menu", () => {
    const acts = () => recorder("setEase", "remove");
    const glyph = (e: Easing): string => `preset:${e}`;

    // RED: flatten the three easing rows to the top level and the menu's own terminal Delete row
    // stops being terminal — the danger row must be last (the grammar oracle's own law).
    test("Easing ▸ then Delete, the danger row terminal", () => {
        const a = acts();
        expect(
            shape(spanMenu({ ease: Easing.Cubic, presetGlyph: glyph, canDelete: true }, a)),
        ).toEqual([
            {
                label: "Easing",
                group: "modify",
                children: [
                    { label: "Linear", group: "modify", glyph: "preset:0", checked: false },
                    { label: "Cubic", group: "modify", glyph: "preset:1", checked: true },
                    { label: "Quintic", group: "modify", glyph: "preset:2", checked: false },
                ],
            },
            {
                label: "Delete",
                group: "lifecycle",
                shortcut: "Del",
                danger: true,
                enabled: true,
            },
        ]);
    });

    // RED: check the row against a fixed `Easing.Linear` instead of the state's own tag and the
    // lit row lies about what the record carries.
    test("the checked easing row is the RECORD's own tag", () => {
        const a = acts();
        for (const ease of [Easing.Linear, Easing.Cubic, Easing.Quintic]) {
            const rows = spanMenu({ ease, presetGlyph: glyph, canDelete: true }, a);
            const checked = rows[0].children?.filter((r) => r.checked).map((r) => r.label);
            expect(checked).toEqual([["Linear", "Cubic", "Quintic"][ease]]);
        }
    });

    test("each easing row applies its OWN preset, and Delete removes", () => {
        const a = acts();
        const rows = spanMenu({ ease: Easing.Linear, presetGlyph: glyph, canDelete: true }, a);
        for (const r of rows[0].children ?? []) r.action?.();
        rows[1].action?.();
        expect(a.log).toEqual([
            `setEase(${Easing.Linear})`,
            `setEase(${Easing.Cubic})`,
            `setEase(${Easing.Quintic})`,
            "remove()",
        ]);
    });

    test("Delete grays where the record cannot be removed", () => {
        const a = acts();
        expect(
            spanMenu({ ease: Easing.Linear, presetGlyph: glyph, canDelete: false }, a)[1].enabled,
        ).toBe(false);
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
    const easings = [Easing.Linear, Easing.Cubic, Easing.Quintic] as const;

    const rulerStates = states<RulerMenuState>({
        domain: [Domain.Distance, Domain.Time],
        metersEnabled: bool,
        secondsEnabled: bool,
    });
    const rowStates = states<RowMenuState>({
        name: ["geo", "force", "velocity"],
        expanded: bool,
        canAdd: bool,
    });
    const spanStates = states<SpanMenuState>({
        ease: easings,
        presetGlyph: [(e: Easing) => `preset:${e}`],
        canDelete: bool,
    });

    // every menu the app can summon, as `(name, rows, state)` triples — the oracle's whole input.
    // The state rides along because several laws are state-SENSITIVE: whether a toggle addresses a
    // single subject or a set decides whether it may carry a checkmark at all, and a law keyed on
    // the label alone can't see that (the stage-2 review's finding).
    // `acts` rides along too: the recorder instance that built these rows' actions, so a law that
    // needs a row's ACT can invoke it and read the log rather than trusting a hand-typed map.
    type Menu = { name: string; rows: MenuItem[]; state: object; acts: { log: string[] } };
    function corpus(): Menu[] {
        const all: Menu[] = [];
        const acts = () => recorder("pick", "add", "toggleExpand", "setEase", "remove");
        for (const s of rulerStates) {
            const a = acts();
            all.push({ name: "rulerMenu", rows: rulerMenu(s, a), state: s, acts: a });
        }
        for (const s of rowStates) {
            const a = acts();
            all.push({ name: "rowMenu", rows: rowMenu(s, a), state: s, acts: a });
        }
        for (const s of spanStates) {
            const a = acts();
            all.push({ name: "spanMenu", rows: spanMenu(s, a), state: s, acts: a });
        }
        return all;
    }
    // every menu AND every submenu, flattened — a flyout is a menu, so the same laws hold in it.
    // A submenu inherits its parent's name as a `▸` path (the registries below address rows by it),
    // its parent's state (the flyout is summoned from the same subject), and its parent's `acts`
    // (a submenu's rows were built against the same recorder instance as their parent's).
    function levels(): Menu[] {
        const out: Menu[] = [];
        const walk = (
            name: string,
            rows: MenuItem[],
            state: object,
            acts: { log: string[] },
        ): void => {
            out.push({ name, rows, state, acts });
            for (const row of rows)
                if (row.children) walk(`${name} ▸ ${row.label}`, row.children, state, acts);
        };
        for (const menu of corpus()) walk(menu.name, menu.rows, menu.state, menu.acts);
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

    // ── an authored separator's POSITION passes the within-group law above, but position alone
    // can't say what it divides — the same shape-floor-vs-law gap the `Checked` registry closes
    // below, one section down. This is that registry's twin for separators: a declared table, a
    // row may carry a separator iff its slot is listed here with what it divides.
    //
    // A separator carries no label, so it can't be addressed by `menu ▸ label` the way `Checked`
    // addresses a checked ROW. Its address is the containing menu's `▸` path plus its own index in
    // the AUTHORED rows array (`levels()`'s `rows`, before `menuRows` derives anything) — the
    // position IS the only handle a label-less row has. That makes a legitimate reorder of the
    // submenu's rows a DELIBERATE registry edit (the index moves, so the old key goes stale and
    // the completeness assert below catches it) rather than silent breakage.
    // empty since `kex2d-segment-removal` S3: `keyframeMenu`'s Easing ▸ carried the app's one
    // authored separator (dividing the presets from Custom); Custom left with the explicit
    // per-keyframe force handles it materialized, so no builder authors a separator today.
    const Separators: Record<string, string> = {};

    test("an authored separator's divide is DECLARED, both directions", () => {
        // both directions: an authored separator with no registry entry fails, and a registry
        // entry with no matching authored separator fails just as hard (a stale line is a lie).
        const authored = new Set<string>();
        for (const { name, rows } of levels())
            rows.forEach((row, i) => {
                if (row.separator) authored.add(`${name} #${i}`);
            });
        expect([...authored].sort()).toEqual(Object.keys(Separators).sort());
    });

    // ── `checked` means exactly ONE thing: this row's state is currently in effect (stage 3).
    // The shape check below (boolean, has an action, not a submenu parent, not danger) is a floor,
    // not the law — it admits `checked` on nearly every act row in the app, so it could never catch
    // a row lighting up for "recently used" or "this is the default". The law is this DECLARED
    // REGISTRY: a row may carry `checked` iff its path is here, and each entry names the state the
    // check reports. Adding a `checked` needs a line here that reads as a state in effect right
    // now; a state that only "was" or "would be" has no honest entry to write.
    const Checked: Record<string, string> = {
        // the easing tag governing the addressed record right now — exactly one of the three
        // Easing rows is ever lit.
        "spanMenu ▸ Easing ▸ Linear": "this record is driven by the Linear tag",
        "spanMenu ▸ Easing ▸ Cubic": "this record is driven by the Cubic tag",
        "spanMenu ▸ Easing ▸ Quintic": "this record is driven by the Quintic tag",
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
        // the ruler's unit picker — one subject (the track's own domain), so each row's label
        // never moves and `checked` reports which unit the chart actually reads. Exactly one row
        // may be lit: the domain is a single value, and two lit rows would claim it is both.
        expect(
            violations(({ name, rows, state }) => {
                if (name !== "rulerMenu") return [];
                const s = state as RulerMenuState;
                const bad: string[] = [];
                const lit = rows.filter((r) => r.checked === true);
                if (lit.length !== 1)
                    bad.push(`${label(name, rows)} — ${lit.length} rows lit, exactly 1 owed`);
                for (const row of rows) {
                    if (row.separator) continue;
                    const where = `${label(name, rows)} — "${row.label}"`;
                    if (typeof row.checked !== "boolean")
                        bad.push(`${where} is single-subject but reports no state`);
                    const own = row.label === "Meters" ? Domain.Distance : Domain.Time;
                    if (row.checked !== (s.domain === own))
                        bad.push(`${where} lights against the live domain`);
                }
                return bad;
            }),
        ).toEqual([]);
    });

    test("the act-naming toggle flips its label to the act and never carries a check", () => {
        // the lane row's step-in — `Expand`/`Collapse`, one row wearing two names. Both labels
        // must be reachable (a toggle that never flips owes a checkmark instead), neither may ever
        // light up, and the label must name what the PRESS does, not the state the row is in
        // (`editor-ui.md`: a mixed-capable toggle names the action without a check).
        const seen = new Set<string>();
        expect(
            violations(({ name, rows, state }) => {
                if (name !== "rowMenu") return [];
                const s = state as RowMenuState;
                const bad: string[] = [];
                const pair = rows.filter((r) => r.label === "Expand" || r.label === "Collapse");
                if (pair.length > 1)
                    bad.push(`${label(name, rows)} — Expand and Collapse co-occur`);
                for (const row of pair) {
                    seen.add(row.label as string);
                    const where = `${label(name, rows)} — "${row.label}"`;
                    if (row.checked !== undefined)
                        bad.push(`${where} carries a check while naming an act`);
                    if (row.label !== (s.expanded ? "Collapse" : "Expand"))
                        bad.push(`${where} does not name the act its state demands`);
                }
                return bad;
            }),
        ).toEqual([]);
        expect([...seen].sort()).toEqual(["Collapse", "Expand"]);
    });

    // ── `shortcut` appears iff a keyboard binding invokes the SAME action (stage 3, tightened in
    // kex2d-burndown 1a). The table itself lives in `src/menu.ts` and both halves read it — the
    // handler matches on `keys`, the builder prints `hint` — so a rebind moves the hint with it.
    // What's left for the oracle is which ROW each binding belongs to — and that mapping now reads
    // PRODUCTION rather than a hand-typed copy: a `menu ▸ label` → binding table maintained by hand
    // stays green on `undefined === undefined` for a row that IS bound but whose entry nobody
    // bothered to write (the exact hole this closes).
    //
    // Each row's ACT is derived by invoking its own `action` against its menu's own recorder and
    // reading the logged name (`"remove()"` → `"remove"`) — the corpus recorder already IS the
    // production fact, `Rows` was only ever a lossy hand-copy of it. `actAt` resolves any row,
    // action-bearing or not: a row WITH an action invokes it directly; a row with none (a
    // permanently-disabled twin like the multi-select `Add`, or a genuine submenu parent) falls
    // back to whatever act the SAME `menu ▸ label` path resolved to elsewhere in the corpus — built
    // once, from every occurrence that DOES carry an action, so a path with no action anywhere
    // (a true submenu parent) correctly resolves to no act at all. That fallback is itself derived,
    // never hand-typed: `actByPath` is populated by walking the whole corpus, not by asserting one.
    function actAt(row: MenuItem, path: string, acts: { log: string[] }): string | undefined {
        if (row.action) {
            row.action();
            const last = acts.log.at(-1);
            return last?.slice(0, last.indexOf("("));
        }
        return actByPath()[path];
    }
    let cachedActByPath: Record<string, string> | undefined;
    function actByPath(): Record<string, string> {
        if (cachedActByPath) return cachedActByPath;
        const byPath: Record<string, string> = {};
        for (const { name, rows, acts } of levels())
            for (const row of rows) {
                if (row.separator || !row.action) continue;
                row.action();
                const last = acts.log.at(-1);
                if (last === undefined) continue;
                byPath[`${name} ▸ ${row.label}`] = last.slice(0, last.indexOf("("));
            }
        cachedActByPath = byPath;
        return byPath;
    }

    // the act → binding table (`RawKeys`'s shape): every act the corpus recorder declares, mapped
    // to the ONE binding a row invoking it may advertise, or `null` for an act with no key. The
    // recorder's own `append` act (the section-append flyout) and `nodeMenu`'s `add` act (the row
    // that fires the `append` BINDING) collide only in ENGLISH, not in the table — two acts, kept
    // apart by name, one bound and one not.
    const Acts: Record<string, keyof typeof BINDINGS | null> = {
        pick: null,
        add: null,
        toggleExpand: null,
        setEase: null,
        remove: "remove",
    };

    test("`Acts` censuses every act name the corpus recorder declares", () => {
        // the completeness pin, the `RawKeys` shape: a new act reaching the recorder with no entry
        // here fails rather than falling through to a silent `undefined` binding.
        const declared = new Set<string>();
        for (const { acts } of corpus())
            for (const k of Object.keys(acts)) if (k !== "log") declared.add(k);
        expect(Object.keys(Acts).sort()).toEqual([...declared].sort());
    });

    // ── the `Acts` REVERSE direction: `Acts` above closes "does this act's row show the right
    // hint", but says nothing about whether every keyboard binding actually FIRES the act it
    // claims — a `BINDINGS` entry with no decider ever reaching it would sit unbound and untested
    // forever. kex2d-test-mechanism stage 2 moves this direction's population OFF a hand-typed
    // `Acts`-values census and onto the key-act seam (`src/keys.ts`): every decider is the
    // keyboard twin of a menu builder, so it's driven the same way the grammar oracle drives a
    // builder — over its FULL state matrix — and every (binding, act) pair production actually
    // emits is collected from the deciders' own return values, never fabricated inline (the
    // declared-registry law's own clause, editor-ui.md Menus: the control must exercise the
    // driver). `MenulessBindings` then covers only a binding no decider ever emits.
    const MenulessBindings: Partial<Record<keyof typeof BINDINGS, { why: string }>> = {
        exitMode: {
            why: "Escape is the dismissal LADDER, not an act: `Timeline.svelte` peels a live gesture, then a summoned menu, then the popover, then the selection, and each rung is a different subject rather than one named act a decider could return",
        },
    };

    // every DISTINCT `key` any `BINDINGS` entry declares — the production table, not a hand-typed
    // copy, so a rebind moves this census with it. Deduplicated by literal value, not by
    // (binding, key) pair: `kex2d-shortcuts` stage 3 introduces the first key TWO bindings share
    // (`BINDINGS.append`'s unscoped `Enter`, `BINDINGS.solve`'s pin-scoped one), and a decider `fn`
    // only ever sees the bare string — it can't tell which named binding "caused" a call, so
    // iterating the same literal twice under two different labels would drive every decider twice
    // over an identical input for no reason.
    function keySpace(): string[] {
        const out = new Set<string>();
        for (const b of Object.values<Binding>(BINDINGS)) for (const key of b.keys) out.add(key);
        return [...out];
    }
    // drives ONE decider over every declared key × every state in its matrix (`states`, above —
    // the same cartesian-product helper the grammar oracle drives a menu builder with), recording
    // each (binding, act) pair it actually emits. This IS the driver the positive control below
    // exercises — a decider gone silent on every input still passes a hand-fabricated pair, but
    // fails here (the reachability assert two tests down goes red with nothing collected).
    //
    // `binding` is read off `Acts[act]` (the forward-direction census above), never off which
    // `keySpace` entry the caller happened to iterate: once a key is shared between an unscoped
    // and a scoped binding, attributing by iteration order would mislabel a real `append`-caused
    // "add" as `solve`-caused (or the reverse) purely because the two bindings' literal happens to
    // collide — an artifact of the test's own free state matrix (`nodeKeyAct`'s `editable` and
    // `modeKeyAct`'s `modeOpen` are driven independently here, where production keeps them
    // mutually exclusive: a geo node is never editable while any pin session is open). `Acts` is
    // built independently of this driver (from the corpus/menu rows), so reading it here is a
    // cross-check, not a re-derivation of the rule under test — and every one of the three checks
    // below is a hard failure, never a skip: an emitted act with no `Acts` entry (`undefined`), an
    // emitted act `Acts` maps to `null` (declared keyboard-unreachable), or an emitted act whose
    // firing key isn't a member of its own binding's `keys` — each is a decider defect the driver
    // must surface, not silently drop from the collected pairs.
    function driveKeyAct<S>(fn: (key: string, s: S) => string | null, matrix: S[]) {
        const pairs: { binding: keyof typeof BINDINGS; act: string }[] = [];
        for (const key of keySpace())
            for (const s of matrix) {
                const act = fn(key, s);
                if (act === null) continue;
                const binding = Acts[act];
                if (binding === undefined)
                    throw new Error(
                        `driveKeyAct: "${act}" (key ${JSON.stringify(key)}, state ${JSON.stringify(s)}) has no Acts census entry`,
                    );
                if (binding === null)
                    throw new Error(
                        `driveKeyAct: "${act}" (key ${JSON.stringify(key)}, state ${JSON.stringify(s)}) is declared keyboard-unreachable in Acts, but a decider emitted it`,
                    );
                if (!bound(BINDINGS[binding], key))
                    throw new Error(
                        `driveKeyAct: "${act}" fired on key ${JSON.stringify(key)}, which BINDINGS.${String(binding)} (its own Acts-declared binding) never declares (state ${JSON.stringify(s)})`,
                    );
                pairs.push({ binding, act });
            }
        return pairs;
    }
    // The lane timeline's rung is the one decider left: the pose era's four (section, node,
    // force keyframe, pin mode) went with the subjects they pressed against. `nudgeAct` emits no
    // `BINDINGS` act at all — the arrows are a `RESERVED` press with no menu row — so it is driven
    // for its own matrix in `keys` coverage below rather than through this seam.
    const timelineKeyStates = states<TimelineKeyState>({
        dragging: bool,
        ctrl: bool,
        shift: bool,
        selected: bool,
    });

    function keyActPairs(): { binding: keyof typeof BINDINGS; act: string }[] {
        return [...driveKeyAct(timelineKeyAct, timelineKeyStates)];
    }

    test("positive control: driving the deciders emits at least one pair per binding they cover", () => {
        // proves `keyActPairs` reaches production and isn't silently empty (a broken import, a
        // decider that always returns null) — the exact hole a hand-fabricated pair can't close.
        const pairs = keyActPairs();
        expect(pairs.length, "the deciders emitted no pairs at all").toBeGreaterThan(0);
        const seen = new Set(pairs.map((p) => `${p.binding}:${p.act}`));
        expect([...seen].sort()).toEqual(["remove:remove"]);
    });

    test("every emitted (binding, act) pair agrees with `Acts`", () => {
        // the seam's whole point: a decider that fires the WRONG act for its binding (a swapped
        // `remove`/`toggleLock`, a dropped guard) is caught here, not by the set-comparison below
        // alone — `Acts` is itself derived from the menus' real actions (the forward-direction
        // census above), so this cross-checks two independently-derived tables against each other.
        for (const { binding, act } of keyActPairs())
            expect(Acts[act], `"${act}" (fired by "${binding}") in Acts`).toBe(binding);
    });

    test("every `BINDINGS` key is keyboard-reachable via a decider, or declared in `MenulessBindings`", () => {
        const reachable = new Set(keyActPairs().map((p) => p.binding));
        const declared = new Set(Object.keys(MenulessBindings) as (keyof typeof BINDINGS)[]);
        expect(
            [...new Set([...reachable, ...declared])].sort(),
            "every BINDINGS key must be reachable or declared",
        ).toEqual((Object.keys(BINDINGS) as (keyof typeof BINDINGS)[]).sort());
        const orphans = [...declared].filter((k) => reachable.has(k));
        expect(orphans, "MenulessBindings entries for a decider-reachable binding").toEqual([]);
    });

    test("`shortcut` is present iff a keyboard binding invokes that row's action", () => {
        // `Handles` is double-click — a pointer gesture is not a shortcut, so it declares nothing.
        cachedActByPath = undefined;
        actByPath(); // build once, from a fresh corpus, before the row-by-row pass below mutates logs
        expect(
            violations(({ name, rows, acts }) => {
                const bad: string[] = [];
                for (const row of rows) {
                    if (row.separator) continue;
                    const where = `${label(name, rows)} — "${row.label}"`;
                    const act = actAt(row, `${name} ▸ ${row.label}`, acts);
                    if (act !== undefined && !(act in Acts)) {
                        bad.push(`${where} — act "${act}" is not in Acts`);
                        continue;
                    }
                    const binding = act === undefined ? null : Acts[act];
                    const hint =
                        binding === null || binding === undefined
                            ? undefined
                            : BINDINGS[binding].hint;
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
    // each binding. Both ends read `src/menu.ts`'s table, so this pins that they still do. The
    // key-act seam (`keys.ts`) is where every decider itself reads `BINDINGS` now; a home file
    // kept its own entry only where it ALSO compared the binding raw outside the decider. Those
    // second ends — `controls.ts`'s mid-drag `editor.dragging` early-out and `App.svelte`'s
    // permanent-listener check and Delete swallow — went with the gestures they guarded
    // (`retired/pose-ux`), so `keys.ts` is every binding's only live home until S3 re-wires them.
    const Handlers: Record<keyof typeof BINDINGS, string[]> = {
        remove: ["keys.ts"],
        exitMode: ["Timeline.svelte"],
    };
    // a bound key also drives presses that are NOBODY's menu row — dismissal rungs, a field's
    // commit-and-blur. Those stay raw literals, and this is exactly which files may hold one; any
    // other file comparing a bound key raw is a handler that slipped out of the table.
    const RawKeys: Record<string, { files: string[]; why: string }> = {
        Delete: { files: [], why: "every Del press is the remove binding" },
        Backspace: { files: [], why: "Del's twin, same binding" },
        Escape: {
            files: ["Popover.svelte"],
            why: "the popover field's own revert-and-blur, the innermost rung of the dismissal ladder — `Timeline.svelte` reads the same key through `bound(BINDINGS.exitMode)` for the rungs above it",
        },
    };
    const src = (file: string): string =>
        readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
    const srcFiles = readdirSync(join(import.meta.dir, "..", "src")).filter(
        (f) => f.endsWith(".ts") || f.endsWith(".svelte"),
    );

    // the hand-typed `RawKeys` list above is only a census if it actually COVERS `BINDINGS` — a
    // fifth binding landing with no matching `RawKeys` entries would otherwise fall through the
    // loop below untested while the test's own name keeps claiming completeness.
    test("`RawKeys` censuses every key every binding declares", () => {
        const declared = new Set<string>();
        for (const binding of Object.values<Binding>(BINDINGS))
            for (const key of binding.keys) declared.add(key);
        expect(Object.keys(RawKeys).sort()).toEqual([...declared].sort());
    });

    // a `code`-form comparison bypasses `BINDINGS` (and this whole `key`-form census) entirely —
    // `Timeline.svelte`'s `e.code === "Space"` already proves the shape exists in this codebase,
    // so a rebind hiding behind `e.code === "KeyQ"` would keep every `key`-form assert green while
    // `BINDINGS.lock.hint` kept printing `Q` over a dead binding. One declared exemption: `Space`
    // is a real, non-menu `code` comparison (the playback toggle has no row), named here so a NEW
    // `code` comparison anywhere else fails closed instead of silently joining it.
    const CodeExempt = { value: "Space", files: ["Timeline.svelte"] } as const;

    test("no module compares a key by `code` outside the one declared exemption", () => {
        const pattern = /code\s*[!=]==\s*"([^"]+)"/g;
        const bad: string[] = [];
        for (const f of srcFiles) {
            if (f === "menu.ts") continue;
            for (const m of src(f).matchAll(pattern)) {
                const value = m[1];
                if (
                    value === CodeExempt.value &&
                    (CodeExempt.files as readonly string[]).includes(f)
                )
                    continue;
                bad.push(`${f}: code === "${value}"`);
            }
        }
        expect(bad).toEqual([]);
        // the exemption itself isn't vacuous — Space really is compared by CODE where declared, so
        // deleting the exemption line above would go red here, not pass by omission.
        expect(
            CodeExempt.files.some((f) =>
                new RegExp(`code\\s*[!=]==\\s*"${CodeExempt.value}"`).test(src(f)),
            ),
        ).toBe(true);
    });

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

    // the `structure` group (Cut/Join) shipped empty in stage 3, gained Cut (stage 4) and Join
    // (stage 5), then lost both: Join retired `kex2d-segment-removal` S1 (chained-duration
    // segments have no join op), and Cut retired S2 (no split op either) — the group's own last
    // occupant left with it, so `GROUPS` narrows back to three (`src/menu.ts`) and the group's
    // dedicated test block leaves with the group. `menuRows`'s divider-placement law itself
    // (tested generically above, over the real corpus and over fabricated multi-group rows) is
    // unaffected — a future segment-authoring unit reintroducing a fourth group inherits that
    // machinery for free.
    test("GROUPS holds exactly the three surviving categories, canonically ordered", () => {
        expect(GROUPS).toEqual(["create", "modify", "lifecycle"]);
    });
});

// ── the nudge rung (S3c): the one decider with no `BINDINGS` act, driven over its own full state
// matrix the same way the grammar oracle drives a builder. Its four literals are `RESERVED.nudge`,
// so the registry oracle below already pins that they are claimed; what is left is the DECISION.
describe("nudgeAct — the in-place tweak's two channels", () => {
    const bool = [false, true] as const;
    function states<S extends object>(matrix: { [K in keyof S]: readonly S[K][] }): S[] {
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
    const all = states<NudgeKeyState>({
        dragging: bool,
        selected: bool,
        shift: bool,
        alt: bool,
        ownsEntry: bool,
    });
    const Arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;
    const live: NudgeKeyState = {
        dragging: false,
        selected: true,
        shift: false,
        alt: false,
        ownsEntry: true,
    };

    // RED: drop the `shift` branch and ←/→ answer on the value channel too — one press meaning
    // two things, which is exactly the one-meaning-per-channel law this split exists to keep.
    test("the horizontal pair is the STATION channel, the shifted vertical pair the VALUE channel", () => {
        expect(nudgeAct({ key: "ArrowRight" }, live)).toEqual({ kind: "station", sign: 1 });
        expect(nudgeAct({ key: "ArrowLeft" }, live)).toEqual({ kind: "station", sign: -1 });
        expect(nudgeAct({ key: "ArrowUp" }, { ...live, shift: true })).toEqual({
            kind: "value",
            which: "exit",
            sign: 1,
        });
        expect(nudgeAct({ key: "ArrowDown" }, { ...live, shift: true })).toEqual({
            kind: "value",
            which: "exit",
            sign: -1,
        });
        // and the two unclaimed halves stay null in BOTH modes: a bare vertical would read as
        // "change row" over a stack of lanes, and a shifted horizontal has no second meaning.
        expect(nudgeAct({ key: "ArrowUp" }, live)).toBeNull();
        expect(nudgeAct({ key: "ArrowDown" }, live)).toBeNull();
        expect(nudgeAct({ key: "ArrowRight" }, { ...live, shift: true })).toBeNull();
        expect(nudgeAct({ key: "ArrowLeft" }, { ...live, shift: true })).toBeNull();
    });

    // RED: drop the `ownsEntry` guard and Alt+Shift+↑ over an INFERRED entry mints an owned
    // handle as a side effect of an arrow press — authoring ownership nobody asked for.
    test("Alt narrows a value nudge to the entry, and only where the record owns one", () => {
        const alt = { ...live, shift: true, alt: true };
        expect(nudgeAct({ key: "ArrowUp" }, alt)).toEqual({
            kind: "value",
            which: "entry",
            sign: 1,
        });
        expect(nudgeAct({ key: "ArrowUp" }, { ...alt, ownsEntry: false })).toBeNull();
        // without Alt an inferred entry is irrelevant: the exit is always owned.
        expect(nudgeAct({ key: "ArrowUp" }, { ...live, shift: true, ownsEntry: false })).toEqual({
            kind: "value",
            which: "exit",
            sign: 1,
        });
    });

    // RED: drop either guard and the whole matrix's null legs collapse — a nudge lands mid-drag
    // (behind the open gesture) or with no subject at all.
    test("every arm is null mid-gesture and null with nothing selected, over the whole matrix", () => {
        for (const s of all)
            for (const key of Arrows) {
                const act = nudgeAct({ key }, s);
                if (s.dragging || !s.selected) expect(act, JSON.stringify({ key, s })).toBeNull();
            }
        // and the matrix is not vacuous: with the two guards clear, some arm DOES fire.
        expect(
            all
                .filter((s) => !s.dragging && s.selected)
                .some((s) => Arrows.some((key) => nudgeAct({ key }, s) !== null)),
        ).toBe(true);
    });

    // RED: claim a fifth key (say `Home`) and this goes red — the decider answers only for the
    // four keys `RESERVED.nudge` declares, and nothing else on the keyboard.
    test("no key outside the four arrows is ever a nudge", () => {
        for (const s of all)
            for (const key of ["Home", "End", "PageUp", "w", "Enter", "Escape", " "])
                expect(nudgeAct({ key }, s), key).toBeNull();
    });
});

// ── kex2d-shortcuts stage 1: the closed key registry over `BINDINGS` + `RESERVED` together.
// `RawKeys`/`Handlers` above already census every raw comparison of a `BINDINGS` key (Escape,
// Enter, Delete, Backspace, `q`/`Q`) — this block is the OTHER half: `S`, `F`,
// `Space`, the arrows, Ctrl+Z/Y, and `F3` never had a table at all, so nothing stopped a new
// binding from colliding with one of them (Locked decision 3, `kex2d-shortcuts`). Two mechanisms
// at two granularities, per the declared-registry law (`editor-ui.md` Menus): a SOURCE population
// scan (is every literal claimed, exactly once) and a TABLE-only pairwise check (do two declared
// entries claim the same key at an overlapping scope) — the second exists because a collision is
// a property of the two DECLARATIONS, checkable even before either key is ever exercised raw in
// `src/`, which a source scan alone could never see.
describe("the closed key registry — BINDINGS + RESERVED collision oracle", () => {
    type Literal = { form: "key" | "code"; value: string; file: string };
    type Declared = {
        form: "key" | "code";
        value: string;
        name: string;
        mod?: Modifier;
        scope?: string;
    };

    const reservedSrcRoot = join(import.meta.dir, "..", "src");
    const reservedSrc = (file: string): string => readFileSync(join(reservedSrcRoot, file), "utf8");

    // recursive — a flat `readdirSync` sees only the top level, matching the walk this file
    // already uses twice (`acts.ts source census`, `menu source pins`) rather than inventing a
    // second shape: a future nested module would be invisible to the population scan below while
    // it stayed green, the same drift those two pins exist to catch.
    function collectSrcFiles(dir: string, prefix = ""): string[] {
        return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) return collectSrcFiles(join(dir, entry.name), rel);
            return entry.name.endsWith(".ts") || entry.name.endsWith(".svelte") ? [rel] : [];
        });
    }
    const reservedSrcFiles = collectSrcFiles(reservedSrcRoot).filter((f) => f !== "menu.ts");

    // the raw population, read from source TEXT — never a restatement of the tables. Two shapes
    // cover every comparison in `src/` today: a direct `.key`/`.code` member compare, and the one
    // derived-local form (`e.key.toLowerCase()` assigned to a variable, then compared — the
    // undo/redo rung) keyed on that DERIVATION shape, never the variable's own name (the
    // `editor-ui.md` matcher law: "key the matcher on the shape... never on a variable name").
    function literals(file: string): Literal[] {
        const text = reservedSrc(file);
        const out: Literal[] = [];
        for (const m of text.matchAll(/\.key\s*[!=]==\s*"([^"]+)"/g))
            out.push({ form: "key", value: m[1], file });
        for (const m of text.matchAll(/\.code\s*[!=]==\s*"([^"]+)"/g))
            out.push({ form: "code", value: m[1], file });
        // the derived-local shape, keyed on the DERIVATION (a `key` source lowercased into a
        // local), never on the local's name: `e.key.toLowerCase()` at an event site, and the bare
        // `key.toLowerCase()` a pure decider in `keys.ts` reads off its own parameter — the same
        // shape, one seam short of the event.
        for (const dm of text.matchAll(
            /\bconst\s+(\w+)\s*=\s*(?:[\w.]+\.)?key\.toLowerCase\(\);/g,
        )) {
            const re = new RegExp(`\\b${dm[1]}\\s*[!=]==\\s*"([^"]+)"`, "g");
            for (const m of text.matchAll(re)) out.push({ form: "key", value: m[1], file });
        }
        return out;
    }

    function population(): Literal[] {
        return reservedSrcFiles.flatMap(literals);
    }

    // the registry side: every key/code BOTH tables declare, each carrying which entry it came
    // from (for the collision message), its required chord (`mod`), and its mode `scope`, if any.
    // `Binding` and `Reserved` share `scope`'s name and meaning by design (Locked decision 1's
    // law-3 exception is a MENU row — Solve's `Enter` — so it has to be representable in
    // `BINDINGS`, not just `RESERVED`); `mod` is `Reserved`-only today (no `BINDINGS` entry needs
    // a chord), so a `Binding` always reads as `mod: undefined` here.
    function declared(
        bindings: Record<string, Binding>,
        reserved: Record<string, Reserved>,
    ): Declared[] {
        const out: Declared[] = [];
        for (const [name, b] of Object.entries<Binding>(bindings))
            for (const key of b.keys)
                out.push({ form: "key", value: key, name: `BINDINGS.${name}`, scope: b.scope });
        for (const [name, r] of Object.entries(reserved))
            for (const key of r.keys)
                out.push({
                    form: r.form ?? "key",
                    value: key,
                    name: `RESERVED.${name}`,
                    mod: r.mod,
                    scope: r.scope,
                });
        return out;
    }

    // pure — takes the declared table as a parameter, so the positive controls below can drive it
    // against a synthetic table without touching the production one.
    function collisions(table: Declared[]): string[] {
        const bad: string[] = [];
        for (let i = 0; i < table.length; i++) {
            for (let j = i + 1; j < table.length; j++) {
                const a = table[i];
                const b = table[j];
                if (a.form !== b.form || a.value !== b.value || a.name === b.name) continue;
                // a required chord is part of the press, not a note beside it: Ctrl+Z and a
                // hypothetical bare Z are two different presses, so a differing `mod` (including
                // one side undefined — a bare key) is never a collision (Locked decision 1: "the
                // registry has to say `z` is reserved only under Ctrl or a future bare `Z` would
                // read as a collision it isn't").
                if (a.mod !== b.mod) continue;
                // two entries at the SAME key+chord collide UNLESS their scopes differ — and
                // "differ" includes one side unscoped: Locked decision 1's law-3 exception is
                // exactly `BINDINGS.append`'s unscoped `Enter` coexisting with a pin-mode-scoped
                // `Enter` for Solve, not two distinct named scopes. Only an EQUAL scope (both
                // unscoped, or both the same named mode) is a real collision.
                if (a.scope !== b.scope) continue;
                bad.push(`${a.form} "${a.value}": ${a.name} vs ${b.name}`);
            }
        }
        return bad;
    }

    // pure — same shape, over a synthetic RESERVED-only table, so the orphan direction is also
    // testable without mutating the production table.
    function orphans(reserved: Record<string, Reserved>, pop: Literal[]): string[] {
        const bad: string[] = [];
        for (const [name, r] of Object.entries(reserved)) {
            const form = r.form ?? "key";
            for (const key of r.keys) {
                if (!pop.some((l) => l.form === form && l.value === key))
                    bad.push(`RESERVED.${name}: "${key}" (${form}) never appears in src`);
            }
        }
        return bad;
    }

    test("positive control: the population scanner reaches real files", () => {
        // proves the scanner isn't vacuously empty (the "registry ships empty" trap,
        // `editor-ui.md` Menus) — it must find the real snap toggle in controls.ts among
        // everything else it scans.
        const pop = population();
        expect(pop.length).toBeGreaterThan(3);
        // the two live presses the reduced tree actually makes, one per surface and one per
        // scanned form: the viewport's frame key (`.key`) and the dock's transport (`.code`).
        expect(pop).toContainEqual({ form: "key", value: "f", file: "controls.ts" });
        expect(pop).toContainEqual({ form: "key", value: "F", file: "controls.ts" });
        expect(pop).toContainEqual({ form: "code", value: "Space", file: "Timeline.svelte" });
    });

    // `literals()`'s own blind spot (Validation, `kex2d-shortcuts`): it reads a direct `.key`/
    // `.code` compare and the one derived-local shape (`e.key.toLowerCase()`), but a destructured
    // `const { key } = e` compared afterward exits the population silently — the destructured
    // local is compared bare, a form neither regex recognizes (the derived-local one is keyed on
    // the `.toLowerCase()` call, not any assignment). Closing that generically means parsing
    // rather than matching, so this is a TRIPWIRE rather than a closed hole: it fails loudly the
    // moment the shape appears anywhere in `src/`, forcing the author toward a decider (`keys.ts`)
    // or a direct `e.key`/`e.code` compare instead of silently taking a key out of the registry.
    function destructureHits(text: string, file: string): string[] {
        const out: string[] = [];
        for (const m of text.matchAll(
            /\bconst\s*\{\s*(?:key|code)\s*(?::\s*\w+)?\s*\}\s*=\s*[\w.]+/g,
        ))
            out.push(
                `${file}: "${m[0]}" destructures a KeyboardEvent — the literal scanner can't see ` +
                    `a destructured key/code; use a decider (keys.ts) or a direct e.key/e.code compare instead`,
            );
        return out;
    }

    test("no file destructures `{ key }`/`{ code }` off a KeyboardEvent — the literal scanner can't see it", () => {
        expect(reservedSrcFiles.flatMap((f) => destructureHits(reservedSrc(f), f))).toEqual([]);
    });

    test("positive control: the destructure scanner actually matches the shape it exists to catch", () => {
        // proves the negative test above passing means "no file does this," not "the scanner
        // can't see it" — drives the same regex against synthetic text bearing the exact shape.
        expect(
            destructureHits('const { key } = e;\nif (key === "z") {}', "<synthetic>").length,
        ).toBeGreaterThan(0);
        expect(destructureHits("const { code } = e;", "<synthetic>").length).toBeGreaterThan(0);
        // a direct compare and the existing derived-local shape are NOT flagged by this scanner —
        // those are `literals()`'s job, not this tripwire's.
        expect(destructureHits('if (e.key === "z") {}', "<synthetic>")).toEqual([]);
        expect(
            destructureHits('const k = e.key.toLowerCase();\nif (k === "z") {}', "<synthetic>"),
        ).toEqual([]);
    });

    // the resolver, over any (population, table) pair — pure, so the positive controls below can
    // drive it against synthetic input without mutating the production tables.
    //
    // `kex2d-shortcuts` stage 3's own known blind spot (Validation table, row 1): source text alone
    // can't say which SCOPE a press site sits under, so the moment a scoped binding (`Solve`'s
    // `Enter`) joins an unscoped one already claiming the same literal (`Append`'s `Enter`), the
    // count-must-be-1 form starts flagging every innocent `Enter` comparison, not just a real
    // collision. The scope-aware rule: more than one match is legal PRECISELY when the matched
    // entries don't collide with EACH OTHER either — `collisions()` above already carries the
    // exact rule for "two entries at the same key are a real collision unless their scopes
    // differ" (Locked decision 1's law-3 exception), so reading it here is reuse, never a second
    // hand-written relaxation, and it's the SAME rule the table-level collision test enforces —
    // never a matcher loosened just for the resolver.
    function resolverBad(pop: Literal[], table: Declared[]): string[] {
        const bad: string[] = [];
        for (const lit of pop) {
            const matches = table.filter((d) => d.form === lit.form && d.value === lit.value);
            if (matches.length === 0) {
                bad.push(`${lit.file}: ${lit.form} "${lit.value}" claimed by no entry`);
                continue;
            }
            if (matches.length > 1 && collisions(matches).length > 0)
                bad.push(
                    `${lit.file}: ${lit.form} "${lit.value}" claimed by ${matches.length} colliding entries (${matches.map((m) => m.name).join(", ")})`,
                );
        }
        return bad;
    }

    test("every key/code literal in src resolves to exactly one declared entry (or a scope-legal sibling set)", () => {
        expect(resolverBad(population(), declared(BINDINGS, RESERVED))).toEqual([]);
    });

    test("positive control: the scope-legal relaxation is reachable at all", () => {
        // production carries no shared key any more (`BINDINGS.append`'s unscoped `Enter` and
        // `BINDINGS.solve`'s pin-scoped one left with the pose UX), so the relaxation is driven
        // against a synthetic table rather than a live pair — what it must still prove is that
        // two entries differing only by scope resolve as ONE legal claim, not as a collision.
        const scoped: Record<string, Binding> = {
            append: { keys: ["Enter"], hint: "Enter" },
            solve: { keys: ["Enter"], hint: "Enter", scope: "aMode" },
        };
        const table = declared(scoped, {});
        const matches = table.filter((d) => d.form === "key" && d.value === "Enter");
        expect(matches.length).toBeGreaterThan(1);
        expect(collisions(matches)).toEqual([]); // the two don't collide (differing scope)
        expect(resolverBad([{ form: "key", value: "Enter", file: "synthetic" }], table)).toEqual(
            [],
        );
    });

    test("positive control: the resolver still flags a literal claimed by entries that DO collide, even inside a larger match set", () => {
        // three declared entries share "Enter": the real unscoped `append`, plus two SAME-scoped
        // "pin" entries that collide with EACH OTHER. The scope-aware relaxation above must not
        // read "more than one match" as blanket-fine — it has to keep checking pairwise.
        const synthetic: Record<string, Binding> = {
            ...BINDINGS,
            append: { keys: ["Enter"], hint: "Enter" },
            solveDup: { keys: ["Enter"], hint: "Enter", scope: "pin" },
            solveDup2: { keys: ["Enter"], hint: "Enter", scope: "pin" },
        };
        const table = declared(synthetic, {});
        const lit: Literal = { form: "key", value: "Enter", file: "synthetic" };
        expect(resolverBad([lit], table).length).toBeGreaterThan(0);
    });

    test("positive control: the resolver actually flags an unclaimed literal", () => {
        // an isolated table missing the real `frame` entry must leave `f`/`F` unresolved — proves
        // the loop above can fail, not just that it happens not to.
        const { frame: _frame, ...withoutFrame } = RESERVED;
        const table = declared(BINDINGS, withoutFrame);
        const bad = population()
            .filter((lit) => lit.form === "key" && (lit.value === "f" || lit.value === "F"))
            .filter(
                (lit) =>
                    table.filter((d) => d.form === lit.form && d.value === lit.value).length !== 1,
            );
        expect(bad.length).toBeGreaterThan(0);
    });

    test("no two declared entries claim the same key at an overlapping scope", () => {
        expect(collisions(declared(BINDINGS, RESERVED))).toEqual([]);
    });

    test("positive control: the collision detector actually flags a duplicate claim", () => {
        const synthetic: Record<string, Reserved> = {
            a: { keys: ["Tab"], why: "synthetic — control only" },
            b: { keys: ["Tab"], why: "synthetic collision — control only" },
        };
        expect(collisions(declared(BINDINGS, synthetic))).toEqual([
            'key "Tab": RESERVED.a vs RESERVED.b',
        ]);
        // two DIFFERENT named scopes on the same key must NOT collide.
        const scoped: Record<string, Reserved> = {
            a: { keys: ["Tab"], why: "control only", scope: "modeA" },
            b: { keys: ["Tab"], why: "control only", scope: "modeB" },
        };
        expect(collisions(declared(BINDINGS, scoped))).toEqual([]);
        // the shape law-3 actually needs (Locked decision 1: `BINDINGS.append`'s unscoped `Enter`
        // coexisting with Solve's pin-mode-scoped `Enter`, stage 3) — one side carries NO scope at
        // all, not a second named one. `Binding.scope` is what makes this representable in
        // `BINDINGS` itself, so the control drives a real `Binding`, not a `Reserved` stand-in.
        const unscopedVsScoped: Record<string, Binding> = {
            append: { keys: ["Enter"], hint: "Enter" }, // stand-in for the retired unscoped row
            solve: { keys: ["Enter"], hint: "Enter", scope: "pin" }, // stand-in for stage 3's row
        };
        expect(collisions(declared(unscopedVsScoped, {}))).toEqual([]);
        // and the SAME scope on both sides is still a real collision — the exception is narrow,
        // not "any scoped entry is exempt".
        const sameScopeTwice: Record<string, Binding> = {
            append: { keys: ["Enter"], hint: "Enter" },
            solveDup: { keys: ["Enter"], hint: "Enter", scope: "pin" },
            solveDup2: { keys: ["Enter"], hint: "Enter", scope: "pin" },
        };
        expect(collisions(declared(sameScopeTwice, {}))).toEqual([
            'key "Enter": BINDINGS.solveDup vs BINDINGS.solveDup2',
        ]);
    });

    test("positive control: a required chord (`mod`) keeps two same-key entries apart", () => {
        // a synthetic BARE `z` must NOT collide with the real `RESERVED.undo` (Ctrl+`z`) — the
        // exact shape Locked decision 1 names: "a future bare `Z` would read as a collision it
        // isn't."
        const bareZ: Record<string, Reserved> = {
            ...RESERVED,
            undo: { keys: ["z"], mod: "ctrl", why: "synthetic — control only" },
            bareZ: { keys: ["z"], why: "synthetic — control only, no chord" },
        };
        expect(collisions(declared(BINDINGS, bareZ))).toEqual([]);
        // but a SECOND Ctrl+`z` entry — same key, same chord — really does collide.
        const dupCtrlZ: Record<string, Reserved> = {
            ...RESERVED,
            undo: { keys: ["z"], mod: "ctrl", why: "synthetic — control only" },
            undo2: { keys: ["z"], mod: "ctrl", why: "synthetic collision — control only" },
        };
        expect(collisions(declared(BINDINGS, dupCtrlZ))).toEqual([
            'key "z": RESERVED.undo vs RESERVED.undo2',
        ]);
    });

    test("every RESERVED key is exercised somewhere in src (no orphan declaration)", () => {
        expect(orphans(RESERVED, population())).toEqual([]);
    });

    test("positive control: the orphan detector actually flags a dead declaration", () => {
        const synthetic: Record<string, Reserved> = {
            dead: { keys: ["Tab"], why: "synthetic — control only, never compared anywhere" },
        };
        expect(orphans(synthetic, population())).toEqual([
            'RESERVED.dead: "Tab" (key) never appears in src',
        ]);
    });
});

// ── the source census (kex2d-act-factory stage 2, the `Handlers` census's precedent): every home
// that builds a menu or dispatches a key REACHES its surface's factory (`src/acts.ts`) rather than
// keeping a private body. Two of the three homes are `.svelte` and unreachable from `bun test` at
// all — this is what pins that the hoist actually landed there, not just that `keys.ts`/`menus.ts`
// name the right acts.
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
    // positive control — slot-by-slot DERIVED divider positions (never a count) over a
    // fabricated three-group menu: one divider at every group change, none elsewhere.
    test("`menuRows` derives one divider at every group change", () => {
        const items = [row("Add", "create"), row("Convert", "modify"), row("Reset", "lifecycle")];
        expect(menuRows(items)).toEqual([
            row("Add", "create"),
            { separator: true },
            row("Convert", "modify"),
            { separator: true },
            row("Reset", "lifecycle"),
        ]);
    });
    // the renderer's own edge case: a group with no row between two occupied ones derives no
    // divider either side of it — slot-by-slot, not a count. Two rows straddling `modify`
    // (`create`, `lifecycle`, both real GROUPS members, `modify` the unoccupied one between
    // them), exactly one divider, never two: a divider-COUNT-only check can't distinguish this
    // from a renderer that emits a divider for the unused group anyway.
    test("an unoccupied group derives no divider either side of it", () => {
        const items = [row("Add", "create"), row("Delete", "lifecycle")];
        expect(menuRows(items)).toEqual([
            row("Add", "create"),
            { separator: true },
            row("Delete", "lifecycle"),
        ]);
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
        // `main.ts` is the walker's positive control: it DOES reach the preference home, so a
        // walker that found nothing anywhere would fail here first.
        expect(reach("main.ts")).toContain("settings.ts");
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

// ── three source pins keeping the next menu inside the lift (kex2d-menu-grammar's follow-up
// burn-down; the renderer pin TIGHTENED in kex2d-burndown 1b). A row array built inline in a new
// .svelte file, or a bespoke `{#each}` instead of `Menu.svelte`, would defeat every menu gate
// above while leaving them all green. `class="menu-item"` only catches a literal COPY of
// `Menu.svelte`'s markup — a bespoke renderer with different class names sails past it. The
// tighter pin is the TYPE: `MenuItem` is what a row array is, so nothing outside a declared
// allowlist may import it at all — a new renderer needs the type to accept a `MenuItem[]`, so it
// fails closed even with markup that shares no class name. These greps close that: every row
// array lives in the pure builders module, `MenuItem` is imported only where declared, and
// `class="menu-item"` stays confined to `Menu.svelte` as a second, redundant signal.
describe("menu source pins — builders and renderer stay singular", () => {
    const srcRoot = join(import.meta.dir, "..", "src");
    const src = (file: string): string => readFileSync(join(srcRoot, file), "utf8");

    // recursive — a flat `readdirSync` sees only the top level, so a future nested module
    // (`src/ui/Menu2.svelte`) would be invisible to both greps below while they stayed green,
    // exactly the drift these pins exist to catch.
    function collectSrcFiles(dir: string, prefix = ""): string[] {
        return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) return collectSrcFiles(join(dir, entry.name), rel);
            return entry.name.endsWith(".ts") || entry.name.endsWith(".svelte") ? [rel] : [];
        });
    }
    const srcFiles = collectSrcFiles(srcRoot);

    // matches a MenuGroup value specifically (GROUPS in menu.ts), not an unrelated `group` field
    // (render.ts's ECS system-scheduling groups) or a JSDoc `@example`'s prose.
    const groupPattern = /group:\s*"(create|modify|lifecycle)"/;

    test('no `group: "` row literal outside src/menus.ts', () => {
        const bad = srcFiles.filter(
            (f) =>
                f !== "menus.ts" &&
                src(f)
                    .split("\n")
                    .some((line) => {
                        const trimmed = line.trim();
                        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return false;
                        return groupPattern.test(line);
                    }),
        );
        expect(bad).toEqual([]);
    });

    // positive control: proves the pattern can actually match something. `menus.ts` is excluded
    // from the check above, so a pattern that stopped matching production's spelling (a `GROUPS[n]`
    // rewrite, a `row()` helper) would leave the check above green forever — matching nothing
    // anywhere is indistinguishable from matching nothing bad.
    test('positive control: `group: "` DOES match a line in src/menus.ts', () => {
        expect(
            src("menus.ts")
                .split("\n")
                .some((line) => groupPattern.test(line)),
        ).toBe(true);
    });

    test('no `class="menu-item"` outside src/Menu.svelte', () => {
        const bad = srcFiles.filter(
            (f) => f !== "Menu.svelte" && src(f).includes('class="menu-item"'),
        );
        expect(bad).toEqual([]);
    });

    // positive control: same shape as above — proves the literal still exists in the one place
    // it's allowed, so a rename there (a class-name refactor) can't leave this check vacuously
    // green.
    test('positive control: `class="menu-item"` DOES appear in src/Menu.svelte', () => {
        expect(src("Menu.svelte").includes('class="menu-item"')).toBe(true);
    });

    // the tightened pin (kex2d-burndown 1b): nothing outside this declared set may import the
    // `MenuItem` type at all. `menu.ts` DECLARES the type rather than importing it, so it's
    // excluded from the walk — the allowlist is who may READ it from elsewhere.
    const MenuItemAllowlist = new Set(["menus.ts", "Menu.svelte"]);

    function importsMenuItem(file: string): boolean {
        for (const m of src(file).matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/menu"/g))
            if (/\bMenuItem\b/.test(m[1])) return true;
        return false;
    }

    test("`MenuItem` is imported ONLY by the declared allowlist, both directions", () => {
        // an undeclared importer fails — a bespoke renderer that needs the type to accept a
        // `MenuItem[]` can't dodge this the way it dodges the markup-literal pin above.
        const bad = srcFiles.filter(
            (f) => f !== "menu.ts" && importsMenuItem(f) && !MenuItemAllowlist.has(f),
        );
        expect(bad, "undeclared MenuItem importers").toEqual([]);
        // and so does an allowlisted file that no longer imports it — a stale entry is a lie of
        // its own, the same both-directions law every other registry in this file keeps.
        const stale = [...MenuItemAllowlist].filter((f) => !importsMenuItem(f));
        expect(stale, "allowlisted files that no longer import MenuItem").toEqual([]);
    });
});
