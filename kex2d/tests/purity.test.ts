import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// The write-site census (`menu.test.ts`'s module-graph walker precedent
// pointed at a different property): every module reachable from `src/` is scanned for a
// literal write to an authored ECS component field (`Track.*.set(`, `Section.*.set(`, …
// — the seven components AGENTS.md's Authoring API section names as the one source of
// truth). `track.ts` OWNS the setter surface and `history.ts` owns the gesture
// machinery, so both are excluded from the walk by construction — the question is
// whether anything ELSE writes an authored field WITHOUT going through a `history`
// gesture. "No second write path" (the spec's locked decision) means every foreign
// write-site is bracketed by a `begin*`/`commit`/`cancel` call — a live drag
// (`controls.ts`) or a command (`commands.ts`) writing `Handle.pos.set` mid-gesture is
// sanctioned exactly like a `track.ts` setter function would be, because the gesture is
// what makes it undo/redo-tracked. That bracket is sometimes in the write's OWN
// enclosing function and sometimes one level up, at the function's call site
// (`controls.ts`'s `applyMultiDelta`/`placeNode` are called from inside a
// `beginMoves(...)…commit(...)` bracket, not wrapped internally) — the walk below
// climbs one level of same-file call graph before calling a write un-gestured. The
// 2026-08-28 S2 census named two un-gestured exceptions outside {track.ts, history.ts}:
// `doc.ts`'s whole-document load/rollback (a fresh document is not an edit to undo
// past) and `main.ts`'s DEV-only `__kex` hook (test setup, never ships) — specifically
// its `nudge` member, the hook's only direct field write at the time. S6 delegates
// `nudge` to `commands.applyOp`'s `node-move` (AGENTS.md's Authoring API: a `__kex`
// write member delegates to the command layer where the mapping is 1:1 — `node-move`
// refuses order 0 the same way and writes the same absolute position), which is safe
// because nothing in the capture harness's own `Kex` mirror (`harness/flow.ts`) calls
// it — so `main.ts` now carries no un-gestured write-site at all, and the exception set
// this census pins is `doc.ts` alone. `main.ts`'s OTHER write member, `seedHill`, still
// bypasses `history` (a raw destroy-and-recreate no single op expresses), but it does so
// through `track.ts`'s own `addNode`/`ecs.destroy` rather than a direct `.set(` on an
// authored field, so it doesn't register as a write-site under this arm's signature —
// AGENTS.md still names `__kex` as a sanctioned exception in prose for that reason, even
// though this narrower mechanical census no longer needs to.
//
// What this DOES prove: every write-site outside {track.ts, history.ts} is either
// gesture-bracketed (in its own function or one call-site up), or lives in `doc.ts`. What
// it does NOT prove: that a gesture-bracketed write is semantically correct (S2's
// differential arm covers that), that an un-gestured write inside `doc.ts` is itself safe
// (S4's document-boundary validation covers that), or that `seedHill`'s raw
// destroy-and-recreate is safe (it's DEV-only, never ships, and the capture harness that
// depends on it is its own coverage).
//
// Mechanism, positive-controlled below: a string/template/comment-aware char
// classifier (so a `` `Handle.pos.set(...)` `` mentioned in a comment doesn't count)
// pairs every brace in "code" position; for each write-site match it climbs to the
// nearest FUNCTION-shaped enclosing brace (an arrow, a declaration, or a method — never
// an `if`/`for`/`while`/`switch`/`catch` block, which would stop the climb one level too
// early) and checks that function's body for a gesture call, then — if that function has
// a resolvable name — greps the file for call sites of that name and repeats the check
// one level up (depth-capped at 2, self-recursive calls excluded, the definition's own
// signature excluded from its own call-site scan). Known blind spot: a gesture two or
// more call levels away, or reached only via a DIFFERENT file, would misread as
// un-gestured — none of today's write-sites take that shape, and a new one that does is
// exactly the kind of thing this census should surface for a human to look at, not
// silently pass.

const srcRoot = join(import.meta.dir, "..", "src");

test("spliceRunMembers mutation phase has no projection-backed read", () => {
    const source = readFileSync(join(srcRoot, "track.ts"), "utf8");
    const start = source.indexOf("export function spliceRunMembers");
    const firstMutation = source.indexOf("// First mutation:", start);
    const lastMutation = source.indexOf("refreshRunEntryForce(ecs, runId);", firstMutation);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(firstMutation).toBeGreaterThan(start);
    expect(lastMutation).toBeGreaterThan(firstMutation);
    const transaction = source.slice(firstMutation, lastMutation);
    expect(transaction).not.toContain("rebuildRunProjection");
    expect(transaction).not.toContain("sections(");
    expect(transaction).not.toContain("sectionAt(");
});

const AUTHORED_COMPONENTS = [
    "Track",
    "Segment",
    "TrackStart",
    "Section",
    "Handle",
    "Force",
    "ForceBoundary",
    "Strip",
    "StripKeyframe",
    "OneShot",
] as const;
const WRITE_RE = new RegExp(`\\b(?:${AUTHORED_COMPONENTS.join("|")})\\.\\w+\\.set\\(`, "g");
const GESTURE_RE = /\b(?:begin\w*|commit\w*|cancel)\(/;
const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch"]);

interface WriteSite {
    file: string;
    line: number;
    text: string;
    gestured: boolean;
}

function collectSrcFiles(dir: string, prefix = ""): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return collectSrcFiles(join(dir, entry.name), rel);
        return entry.name.endsWith(".ts") || entry.name.endsWith(".svelte") ? [rel] : [];
    });
}

/** classifies every character offset as "code" (1) or string/comment content (0).
 *  Handles '...', "...", `...` (template, `${}` interpolation treated as code so a
 *  write-site call inside one is still findable — tracked via a depth stack so the
 *  scanner returns to "tpl" state at the matching `}`, not at the next stray backtick),
 *  `//` line comments, `/* *\/` block comments. */
function codeMask(text: string): Uint8Array {
    const mask = new Uint8Array(text.length);
    const n = text.length;
    let i = 0;
    let state: "code" | "sq" | "dq" | "tpl" | "line" | "block" = "code";
    const tplDepthStack: number[] = [];
    let braceDepth = 0;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        if (state === "code") {
            mask[i] = 1;
            if (c === "/" && c2 === "/") {
                state = "line";
                i += 2;
                continue;
            }
            if (c === "/" && c2 === "*") {
                state = "block";
                i += 2;
                continue;
            }
            if (c === "'") {
                state = "sq";
                i++;
                continue;
            }
            if (c === '"') {
                state = "dq";
                i++;
                continue;
            }
            if (c === "`") {
                state = "tpl";
                i++;
                continue;
            }
            if (c === "{") braceDepth++;
            if (c === "}") {
                braceDepth--;
                if (
                    tplDepthStack.length > 0 &&
                    braceDepth === tplDepthStack[tplDepthStack.length - 1]
                ) {
                    tplDepthStack.pop();
                    state = "tpl";
                }
            }
            i++;
            continue;
        }
        if (state === "line") {
            if (c === "\n") state = "code";
            i++;
            continue;
        }
        if (state === "block") {
            if (c === "*" && c2 === "/") {
                state = "code";
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (state === "sq" || state === "dq") {
            const quote = state === "sq" ? "'" : '"';
            if (c === "\\") {
                i += 2;
                continue;
            }
            if (c === quote) {
                state = "code";
                i++;
                continue;
            }
            i++;
            continue;
        }
        // state === "tpl"
        mask[i] = 1;
        if (c === "\\") {
            i += 2;
            continue;
        }
        if (c === "`") {
            state = "code";
            i++;
            continue;
        }
        if (c === "$" && c2 === "{") {
            tplDepthStack.push(braceDepth);
            braceDepth++;
            state = "code";
            i += 2;
            continue;
        }
        i++;
    }
    return mask;
}

/** every `{`/`}` pair whose braces both sit in "code" position, keyed by open index. */
function braceMatches(text: string, mask: Uint8Array): Map<number, number> {
    const stack: number[] = [];
    const pairs = new Map<number, number>();
    for (let i = 0; i < text.length; i++) {
        if (!mask[i]) continue;
        if (text[i] === "{") stack.push(i);
        else if (text[i] === "}") {
            const open = stack.pop();
            if (open !== undefined) pairs.set(open, i);
        }
    }
    return pairs;
}

/** the matching `(` for the `)` at `closeIdx`, over "code" positions only. */
function matchingOpenParen(text: string, mask: Uint8Array, closeIdx: number): number {
    let depth = 1;
    let k = closeIdx - 1;
    while (k >= 0 && depth > 0) {
        if (!mask[k]) {
            k--;
            continue;
        }
        if (text[k] === ")") depth++;
        else if (text[k] === "(") depth--;
        if (depth === 0) return k;
        k--;
    }
    return -1;
}

/** true (with the param-list's open-paren index) if the `{` at `openIdx` opens a
 *  function-shaped body — an arrow (`=>`, optionally past a return-type annotation,
 *  right before it) or a `)`/`): Type` that is NOT an if/for/while/switch/catch (so a
 *  declaration, a method shorthand, or a class/object method reads true; a control-flow
 *  block does not, so the walk climbs past it to the function that actually encloses it). */
function isFunctionOpen(
    text: string,
    mask: Uint8Array,
    openIdx: number,
): { open: boolean; parenOpen: number } {
    let j = openIdx - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j < 0) return { open: false, parenOpen: -1 };
    if (text[j] === ">" && text[j - 1] === "=") {
        let p = j - 2;
        while (p >= 0 && /\s/.test(text[p])) p--;
        if (text[p] !== ")") {
            let k = p;
            const TypeChar = /[\w$<>[\]|&.,'"\s?]/;
            while (k >= 0 && TypeChar.test(text[k])) k--;
            if (k < 0 || text[k] !== ":") return { open: true, parenOpen: -1 };
            p = k - 1;
            while (p >= 0 && /\s/.test(text[p])) p--;
        }
        if (text[p] !== ")") return { open: true, parenOpen: -1 }; // single-param arrow, no parens
        return { open: true, parenOpen: matchingOpenParen(text, mask, p) };
    }
    let closeParen = j;
    if (text[j] !== ")") {
        let k = j;
        const TypeChar = /[\w$<>[\]|&.,'"\s?]/;
        while (k >= 0 && TypeChar.test(text[k])) k--;
        if (k < 0 || text[k] !== ":") return { open: false, parenOpen: -1 };
        let p = k - 1;
        while (p >= 0 && /\s/.test(text[p])) p--;
        if (p < 0 || text[p] !== ")") return { open: false, parenOpen: -1 };
        closeParen = p;
    }
    const parenOpen = matchingOpenParen(text, mask, closeParen);
    if (parenOpen < 0) return { open: false, parenOpen: -1 };
    let m = parenOpen - 1;
    while (m >= 0 && /\s/.test(text[m])) m--;
    const idEnd = m + 1;
    while (m >= 0 && /[\w$]/.test(text[m])) m--;
    const ident = text.slice(m + 1, idEnd);
    if (CONTROL_KEYWORDS.has(ident)) return { open: false, parenOpen: -1 };
    return { open: true, parenOpen };
}

/** the function name for a param-list open-paren at `parenOpen` — covers
 *  `function NAME(`, `NAME(` (method shorthand), and `const/let NAME = (` /
 *  `NAME: (` (arrow assigned to a variable or object property): the last identifier in
 *  a window before the paren, after stripping a trailing `=`/`:`. */
function functionName(text: string, parenOpen: number): string | null {
    if (parenOpen < 0) return null;
    let window = text.slice(Math.max(0, parenOpen - 80), parenOpen);
    window = window.replace(/[=:]\s*$/, "").trimEnd();
    const m = /([A-Za-z_$][\w$]*)\s*$/.exec(window);
    return m ? m[1] : null;
}

function enclosingFunctionSpans(
    text: string,
    mask: Uint8Array,
    pairs: Map<number, number>,
    matchIndex: number,
): [open: number, close: number, parenOpen: number][] {
    const enclosing: [number, number][] = [];
    for (const [open, close] of pairs)
        if (open < matchIndex && matchIndex < close) enclosing.push([open, close]);
    enclosing.sort((a, b) => b[0] - a[0]); // innermost first
    const out: [number, number, number][] = [];
    for (const [open, close] of enclosing) {
        const r = isFunctionOpen(text, mask, open);
        if (r.open) out.push([open, close, r.parenOpen]);
    }
    return out;
}

/** is the write at `matchIndex` inside a `history` gesture — in its own enclosing
 *  function, or (depth-capped at 2, self-recursion excluded) at a call site of that
 *  function elsewhere in the same file? Module-scope writes (no enclosing function)
 *  fall back to a whole-file gesture-presence read, which correctly fails for any file
 *  that never calls a gesture function at all. */
function isGestured(
    text: string,
    mask: Uint8Array,
    pairs: Map<number, number>,
    matchIndex: number,
    depth = 0,
    seen = new Set<string>(),
): boolean {
    const spans = enclosingFunctionSpans(text, mask, pairs, matchIndex);
    if (spans.length === 0) return GESTURE_RE.test(text);
    const [open, close, parenOpen] = spans[0];
    if (GESTURE_RE.test(text.slice(open, close + 1))) return true;
    if (depth >= 2) return false;
    const name = functionName(text, parenOpen);
    if (!name || seen.has(name)) return false;
    seen.add(name);
    const CallRe = new RegExp(`\\b${name}\\(`, "g");
    let m: RegExpExecArray | null = CallRe.exec(text);
    while (m !== null) {
        const parenIdx = m.index + m[0].length - 1;
        const isOwnBody = m.index >= open && m.index < close;
        const isOwnSignature = parenIdx === parenOpen;
        if (!isOwnBody && !isOwnSignature && mask[m.index]) {
            if (isGestured(text, mask, pairs, m.index, depth + 1, seen)) return true;
        }
        m = CallRe.exec(text);
    }
    return false;
}

/** every authored-component write-site outside `track.ts`/`history.ts`, resolved
 *  gestured or not. This IS the census — its population is every `src/` file. */
function sitesIn(file: string, text: string): WriteSite[] {
    const sites: WriteSite[] = [];
    const mask = codeMask(text);
    const pairs = braceMatches(text, mask);
    WRITE_RE.lastIndex = 0;
    let m: RegExpExecArray | null = WRITE_RE.exec(text);
    while (m !== null) {
        if (mask[m.index]) {
            sites.push({
                file,
                line: text.slice(0, m.index).split("\n").length,
                text: m[0],
                gestured: isGestured(text, mask, pairs, m.index),
            });
        }
        m = WRITE_RE.exec(text);
    }
    return sites;
}

function writeSites(): WriteSite[] {
    const sites: WriteSite[] = [];
    for (const file of collectSrcFiles(srcRoot)) {
        if (file === "track.ts" || file === "history.ts") continue;
        sites.push(...sitesIn(file, readFileSync(join(srcRoot, file), "utf8")));
    }
    return sites;
}

test("every live @temporary source symbol has an adapter-inventory row", () => {
    const inventory = readFileSync(join(srcRoot, "..", "ADAPTERS.md"), "utf8");
    const symbols: string[] = [];
    for (const file of collectSrcFiles(srcRoot).filter((name) => name.endsWith(".ts"))) {
        const source = readFileSync(join(srcRoot, file), "utf8");
        for (const match of source.matchAll(/@temporary/g)) {
            const tail = source.slice(match.index! + match[0].length, match.index! + 500);
            const afterComment = tail.slice(tail.indexOf("*/") + 2);
            const declaration = /\b(?:export\s+)?(?:interface|function|type|const)\s+(\w+)/.exec(
                afterComment,
            );
            const field = /^\s*(\w+)\s*:/m.exec(afterComment);
            const symbol =
                field && (!declaration || field.index! < declaration.index!)
                    ? field[1]
                    : declaration?.[1];
            expect(
                symbol,
                `${file}:${source.slice(0, match.index).split("\n").length}`,
            ).toBeTruthy();
            symbols.push(symbol!);
        }
    }
    expect(symbols.length).toBeGreaterThan(0);
    for (const symbol of symbols)
        expect(inventory, `missing adapter inventory row for ${symbol}`).toMatch(
            new RegExp("\\| `[^`]*\\b" + symbol + "\\b[^`]*` \\|"),
        );
});

describe("authored-component writer census — no second write path", () => {
    test("positive control: the walker reaches real write-sites in both classes", () => {
        // proves the census isn't vacuously empty before its verdict is read below.
        const sites = writeSites();
        expect(sites.length).toBeGreaterThan(0);
        expect(sites.some((s) => s.file === "doc.ts")).toBe(true);
    });

    test("foreign velocity writers route only through canonical command setters", () => {
        const velocity = new Set(["Segment", "TrackStart", "Strip", "StripKeyframe", "OneShot"]);
        const sites = writeSites().filter((site) => velocity.has(site.text.split(".")[0]!));
        expect(sites).toHaveLength(0);
        const commands = readFileSync(join(srcRoot, "commands.ts"), "utf8");
        expect(commands).toContain("applyVelocitySegmentOp");
        expect(commands).toContain("setStrip(ecs, op.id, op.start, op.end, op.value)");
        expect(commands).toContain("setStripKeyframe(ecs, op.id, op.s, op.v)");
        expect(commands).toContain("setOneShotValue(ecs, os.id, op.value)");
        expect(commands).toContain("StartVelocity.v(ecs)");
    });

    test("foreign geometry writers route through the canonical position setter", () => {
        const commands = readFileSync(join(srcRoot, "commands.ts"), "utf8");
        const controls = readFileSync(join(srcRoot, "controls.ts"), "utf8");
        expect(writeSites().filter((s) => s.file === "commands.ts")).toHaveLength(0);
        expect(writeSites().filter((s) => s.file === "controls.ts")).toHaveLength(0);
        expect(commands).toContain("setHandlePosition(ecs, eid, op.x, op.y)");
        expect(controls.match(/setHandlePosition\(ecs, eid,/g)?.length).toBeGreaterThanOrEqual(4);
    });

    test("positive control: the walker masks comments and climbs to a gestured caller", () => {
        const source = `
            // Handle.pos.set(eid, 1, 2)
            function write(eid: number): void { Handle.pos.set(eid, 3, 4); }
            function gesture(eid: number): void { beginMove(); write(eid); commit(); }
        `;
        const sites = sitesIn("control.ts", source);
        expect(sites).toHaveLength(1);
        expect(sites[0].text).toBe("Handle.pos.set(");
        expect(sites[0].gestured).toBe(true);

        const productionSites = writeSites();
        // `doc.ts`'s whole-document load writes `Track.ds` with no `history` bracket at
        // all — deliberately, a fresh document is not an edit to undo past.
        expect(productionSites.some((s) => s.file === "doc.ts" && !s.gestured)).toBe(true);
        // The migrated force value/easing owner must remain in the census rather than
        // letting the force-authoring arm pass vacuously on station-only `Force` writes.
        expect(AUTHORED_COMPONENTS).toContain("ForceBoundary");
        expect(AUTHORED_COMPONENTS).toContain("Segment");
        expect(AUTHORED_COMPONENTS).toContain("TrackStart");
        expect(AUTHORED_COMPONENTS).toContain("Strip");
        expect(AUTHORED_COMPONENTS).toContain("StripKeyframe");
        expect(AUTHORED_COMPONENTS).toContain("OneShot");
    });

    test("every un-gestured write-site lives in doc.ts, and doc.ts actually has one", () => {
        const ungestured = writeSites().filter((s) => !s.gestured);
        const files = new Set(ungestured.map((s) => s.file));
        expect([...files].sort()).toEqual(["doc.ts"]);
    });
});
