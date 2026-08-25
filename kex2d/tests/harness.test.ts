import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
    boolEnv,
    collectedCount,
    failedTitles,
    intEnv,
    parseArgs,
    runCounts,
    UsageError,
    verdict,
    wipeable,
} from "../harness/args";
import { provisioned, provisionKey, stalePrune } from "../harness/wsl";

// The capture orchestrator's pure decision layer. Everything here decides something the gate's
// honesty rests on: whether a run merges or WIPES the shot set, whether the host reinstalls, and
// whether a knob value is legal at all (the fail-closed pass that runs before anything is wiped).

describe("parseArgs — the shot-set fate of a command line", () => {
    test("a bare run is a full run: no passthrough, default out, wipes-and-captures", () => {
        expect(parseArgs([])).toEqual({
            out: null,
            testArgs: [],
            selective: false,
            listing: false,
        });
    });

    test("a filter is passthrough and makes the run SELECTIVE (merge, never wipe)", () => {
        const args = parseArgs(["-g", "geo authoring flow"]);
        expect(args.testArgs).toEqual(["-g", "geo authoring flow"]);
        expect(args.selective).toBe(true);
        expect(args.listing).toBe(false);
    });

    test("the bare `--` bun forwards is DROPPED, so `-g` stays an option", () => {
        // passed through, Playwright reads `--` as end-of-options and `-g` degrades to a positional
        // file filter: the whole suite runs while the caller still counts the run selective.
        expect(parseArgs(["--", "-g", "force authoring flow"]).testArgs).toEqual([
            "-g",
            "force authoring flow",
        ]);
    });

    test("--out is consumed by the harness, never forwarded — and it alone is not selective", () => {
        expect(parseArgs(["--out", "/tmp/iter"])).toEqual({
            out: "/tmp/iter",
            testArgs: [],
            selective: false,
            listing: false,
        });
        expect(parseArgs(["--out=/tmp/iter"]).out).toBe("/tmp/iter");
    });

    test("--out sits anywhere in the line, leaving the rest of the args in order", () => {
        const args = parseArgs(["-g", "lab", "--out", "/tmp/iter", "--repeat-each", "3"]);
        expect(args.out).toBe("/tmp/iter");
        expect(args.testArgs).toEqual(["-g", "lab", "--repeat-each", "3"]);
        expect(args.selective).toBe(true);
    });

    test("--list is recognized through the passthrough (it captures nothing)", () => {
        expect(parseArgs(["--list"])).toEqual({
            out: null,
            testArgs: ["--list"],
            selective: true,
            listing: true,
        });
    });

    test("a directory-less --out is a usage error, not a swallowed flag", () => {
        // the interesting edge: the next arg is the NEXT FLAG, so a naive shift would eat it and
        // resolve the shot dir to "-g" — a wipe of a directory nobody named.
        expect(() => parseArgs(["--out", "-g"])).toThrow(UsageError);
        expect(() => parseArgs(["--out"])).toThrow(UsageError);
        expect(() => parseArgs(["--out="])).toThrow(UsageError);
    });

    test("the `=` form takes the same flag-shaped-value guard as the spaced one", () => {
        // `--out=-g` reads as a typo for `--out -g`, and a bare `./-x` would be created and then
        // WIPED. Both forms resolve through one guard, so neither can be the lenient one.
        expect(() => parseArgs(["--out=-g"])).toThrow(UsageError);
        expect(() => parseArgs(["--out=-x"])).toThrow(UsageError);
    });
});

describe("wipeable — what a full run is allowed to destroy", () => {
    test("a dir this harness could have written is fair game", () => {
        expect(wipeable(null)).toBe(true); // nothing there yet
        expect(wipeable([])).toBe(true); // an empty dir
        expect(wipeable(["RUN.json", "full.png"])).toBe(true); // a prior shot set
    });

    test("anything else is refused — `--out=.` must never reach the wipe", () => {
        // the live hazard: `--out` is caller-supplied and a full run `rmSync(recursive)`s it, so
        // `--out=.` / `--out ..` / `--out $HOME` all reach a source tree. RUN.json is the shot set's
        // provenance stamp AND its permission slip; without it the dir is somebody else's.
        expect(wipeable(["src", "harness", "package.json"])).toBe(false);
        expect(wipeable(["full.png"])).toBe(false); // shot-shaped, but nothing says we wrote it
        expect(wipeable([".git"])).toBe(false);
    });
});

describe("intEnv / boolEnv — the fail-closed knob pass", () => {
    test("an unset knob takes the default", () => {
        expect(intEnv({}, "KEX_WORKERS", 4, 1, 64)).toBe(4);
        expect(boolEnv({}, "KEX_HEADED")).toBe(false);
    });

    test("a legal value parses, at the range's ends included", () => {
        expect(intEnv({ KEX_WORKERS: "8" }, "KEX_WORKERS", 4, 1, 64)).toBe(8);
        expect(intEnv({ KEX_WORKERS: "1" }, "KEX_WORKERS", 4, 1, 64)).toBe(1);
        expect(intEnv({ KEX_WORKERS: "64" }, "KEX_WORKERS", 4, 1, 64)).toBe(64);
        expect(boolEnv({ KEX_HEADED: "1" }, "KEX_HEADED")).toBe(true);
        expect(boolEnv({ KEX_HEADED: "0" }, "KEX_HEADED")).toBe(false);
    });

    test("the knob is read by NAME, so the value can't drift from the name in the error", () => {
        // the whole env goes in and the lookup happens inside: a call site can't pass KEX_WORKERS's
        // raw value under KEX_PORT's name and range.
        const env = { KEX_PORT: "3015", KEX_WORKERS: "2" };
        expect(intEnv(env, "KEX_PORT", 3014, 1024, 65_535)).toBe(3015);
        expect(intEnv(env, "KEX_SHOT_MS", 300, 0, 60_000)).toBe(300); // absent → default
    });

    test("blank is rejected even where 0 is IN range — the fail-open case", () => {
        // `Number("")` is 0 and so is `Number(" ")`. At `min: 0` (KEX_SHOT_MS) the range check
        // backstops nothing, so an empty knob would silently kill every pre-shot settle; at
        // `min: 1` it would run zero workers, burning to the global timeout with the shot set
        // already wiped. The blank forms are rejected by the parse, not by the range.
        for (const raw of ["", " ", "\t", "\n"]) {
            expect(() => intEnv({ KEX_SHOT_MS: raw }, "KEX_SHOT_MS", 300, 0, 60_000)).toThrow(
                UsageError,
            );
            expect(() => intEnv({ KEX_WORKERS: raw }, "KEX_WORKERS", 4, 1, 64)).toThrow(UsageError);
        }
        expect(intEnv({ KEX_SHOT_MS: "0" }, "KEX_SHOT_MS", 300, 0, 60_000)).toBe(0); // a real 0 passes
    });

    test("only a plain digit string parses — no `Number` coercion sneaks a value in", () => {
        // every one of these is a number to `Number` and none of them is what the caller typed:
        // 0x10 is 16, 1e3 is 1000, "+8"/"8."/" 3014 " are 8/8/3014. They reach Playwright as
        // silently different knobs, so they're usage errors.
        for (const raw of ["0x10", "1e3", "+8", "8.", " 3014 ", "08_", "50%", "2.5", "-1"])
            expect(() => intEnv({ KEX_WORKERS: raw }, "KEX_WORKERS", 4, 1, 64)).toThrow(UsageError);
    });

    test("out-of-range values are rejected", () => {
        expect(() => intEnv({ KEX_WORKERS: "0" }, "KEX_WORKERS", 4, 1, 64)).toThrow(UsageError);
        expect(() => intEnv({ KEX_WORKERS: "65" }, "KEX_WORKERS", 4, 1, 64)).toThrow(UsageError);
        expect(() => intEnv({ KEX_PORT: "80" }, "KEX_PORT", 3014, 1024, 65_535)).toThrow(
            UsageError,
        );
        expect(() => intEnv({ KEX_PORT: "65536" }, "KEX_PORT", 3014, 1024, 65_535)).toThrow(
            UsageError,
        );
        expect(() => intEnv({ KEX_SHOT_MS: "60001" }, "KEX_SHOT_MS", 300, 0, 60_000)).toThrow(
            UsageError,
        );
    });

    test("the error names the knob and the value it saw", () => {
        expect(() => intEnv({ KEX_PORT: "80" }, "KEX_PORT", 3014, 1024, 65_535)).toThrow(
            'KEX_PORT must be an integer in [1024, 65535] (got "80")',
        );
        expect(() => boolEnv({ KEX_HEADED: "true" }, "KEX_HEADED")).toThrow(
            'KEX_HEADED must be 0 or 1 (got "true")',
        );
    });

    test("a boolean knob takes only 0 or 1 — no truthy-string coercion", () => {
        expect(() => boolEnv({ KEX_HEADED: "true" }, "KEX_HEADED")).toThrow(UsageError);
        expect(() => boolEnv({ KEX_HEADED: "" }, "KEX_HEADED")).toThrow(UsageError);
    });
});

describe("collectedCount / runCounts — the suite-count oracle's two sides", () => {
    // Both sides parse ANOTHER tool's stdout, so the fixtures are Playwright list-reporter text
    // verbatim in shape. The oracle exists because a truncated run reports the tests it did run as
    // green: without the comparison, a `globalTimeout` that kills the tail reads as a clean gate.
    const executedCount = (stdout: string): number | null => runCounts(stdout)?.total ?? null;

    test("the collected side reads the --list total, singular form included", () => {
        expect(
            collectedCount(
                [
                    "Listing tests:",
                    "  shot.pw.ts:321:1 › geo authoring flow",
                    "  shot.pw.ts:521:1 › tangent edit flow",
                    "Total: 23 tests in 1 file",
                    "",
                ].join("\n"),
            ),
        ).toBe(23);
        expect(collectedCount("Total: 1 test in 1 file\n")).toBe(1);
    });

    test("no Total line is null, never 0 — the pre-pass must fail loud, not collect nothing", () => {
        expect(collectedCount("")).toBeNull();
        expect(
            collectedCount("Listing tests:\n  shot.pw.ts:321:1 › geo authoring flow\n"),
        ).toBeNull();
    });

    test("a clean run accounts for every collected test", () => {
        const green = [
            "Running 23 tests using 4 workers",
            "",
            "  ✓  1 shot.pw.ts:321:1 › geo authoring flow (12.1s)",
            "  ✓  2 shot.pw.ts:521:1 › tangent edit flow (8.3s)",
            "",
            "  23 passed (17.4s)",
            "",
        ].join("\n");
        expect(executedCount(green)).toBe(23);
    });

    test("a FAILED run still accounts for all 23 — this is a coverage count, not a pass count", () => {
        // load-bearing: `capture.ts` reports "the run was truncated" when the two sides disagree, so
        // a summary that forgot to sum `failed` would misdiagnose every ordinary red run as a
        // truncation. The exit code is what fails a red run; this count only asks "did they all run".
        const failed = [
            "Running 23 tests using 4 workers",
            "",
            "  ✘  2 shot.pw.ts:521:1 › tangent edit flow (9.0s)",
            "",
            "  1 failed",
            "    shot.pw.ts:521:1 › tangent edit flow ──────────────────────────────",
            "  22 passed (21.0s)",
            "",
        ].join("\n");
        expect(executedCount(failed)).toBe(23);
    });

    test("every accounted-for category counts, `did not run` above all", () => {
        // `did not run` is what a globalTimeout truncation reports for the tests it killed; the rest
        // round out the set Playwright can print. A category left out of the alternation goes
        // uncounted, and an uncounted test is exactly the run the oracle must refuse.
        expect(executedCount("  2 did not run\n  19 passed (120.0s)\n")).toBe(21);
        expect(executedCount("  1 flaky\n  1 skipped\n  1 interrupted\n  20 passed (30s)\n")).toBe(
            23,
        );
    });

    test("a summary short of the collected total is the truncation the gate refuses", () => {
        // the other truncation shape: the tail is simply missing from the summary. 21 ≠ 23, so
        // `wholeSuite` is false and the capture exits 1 with the shot set marked non-reference.
        expect(executedCount("  21 passed (120.0s)\n")).toBe(21);
    });

    test("no summary line at all is null, which fails the comparison closed", () => {
        expect(executedCount("")).toBeNull();
        expect(executedCount("Running 23 tests using 4 workers\n")).toBeNull();
    });

    test("only the summary block counts — a test TITLE can't inflate the total", () => {
        // the anchor is the guard: a count is a line's first token after its indent. Drop `^\s+` and
        // the title's own "3 passed" lands in the sum, so a green run reads as more tests than were
        // ever collected — a mismatch in the direction nothing else catches.
        const titled = [
            "  ✓  1 shot.pw.ts:900:1 › force 3 passed points flow (4.0s)",
            "  1) shot.pw.ts:900:1 › force 3 passed points flow ───────────────",
            "  23 passed (17.4s)",
        ].join("\n");
        expect(executedCount(titled)).toBe(23);
    });

    test("each category is its OWN number, not just a share of the total", () => {
        // `skipped` is the one the reference gate reads on its own: a stray `test.skip` keeps
        // collected == accounted, so the total says nothing and only the per-category number
        // exposes the coverage drop.
        expect(runCounts("  1 skipped\n  23 passed (17.4s)\n")).toEqual({
            passed: 23,
            failed: 0,
            flaky: 0,
            skipped: 1,
            interrupted: 0,
            didNotRun: 0,
            total: 24,
        });
    });

    test("`did not run` lands in its own field — the truncation category is nameable", () => {
        const counts = runCounts(
            "  2 did not run\n  1 flaky\n  1 interrupted\n  19 passed (120s)\n",
        );
        expect(counts).toEqual({
            passed: 19,
            failed: 0,
            flaky: 1,
            skipped: 0,
            interrupted: 1,
            didNotRun: 2,
            total: 23,
        });
    });
});

describe("failedTitles — what a red run leaves behind", () => {
    // Flake forensics: the reporter output is gone once the run is over, so `RUN.json` carries the
    // names. Parsed from the list reporter's summary block (a `N failed` line, then one indented
    // title per failure), because a JSON reporter would mean another artifact staged to and copied
    // back from the Windows host.

    // Verbatim from a live staged run (a deliberately-red probe flow), tail included: the summary
    // block is the LAST thing Playwright prints, the title carries the `[project] › ` prefix, and
    // the box-drawing pad runs to the terminal width.
    const red = [
        "  x  1 [chromium] › shot.pw.ts:3097:1 › temporary red probe (8ms)",
        "",
        "",
        "  1) [chromium] › shot.pw.ts:3097:1 › temporary red probe ─────────────────────────────────",
        "",
        "    Error: expect(received).toBe(expected) // Object.is equality",
        "",
        "    Expected: 2",
        "    Received: 1",
        "",
        "        at C:\\Users\\dylan\\AppData\\Local\\Temp\\kex2d-harness-3014\\shot.pw.ts:3098:15",
        "",
        "  1 failed",
        "    [chromium] › shot.pw.ts:3097:1 › temporary red probe ────────────────────────────────────",
        "",
    ].join("\n");

    test("the failed flow's title comes back once, pad stripped", () => {
        // once: `1) [chromium] › …` heads the error dump above and repeats every failed title
        // verbatim, so a parse that isn't anchored on the summary block reports each failure twice.
        expect(failedTitles(red)).toEqual(["[chromium] › shot.pw.ts:3097:1 › temporary red probe"]);
    });

    test("CRLF is stripped — the bridge hands back powershell's line endings", () => {
        // the whole stdout arrives from `powershell.exe` through `Bun.spawnSync`, so the real
        // separator is `\r\n` and every line carries a trailing `\r`. It survives today only
        // because `\r` sits inside the `[─\s]+$` strip: narrow that to `─+$` and every recorded
        // title grows an invisible `\r` with all these tests still green.
        expect(failedTitles(red.replace(/\n/g, "\r\n"))).toEqual([
            "[chromium] › shot.pw.ts:3097:1 › temporary red probe",
        ]);
    });

    test("a green run leaves none", () => {
        // the bridge's real progress line: ASCII `ok` (the host has no unicode marks) and the
        // `[chromium] › ` project prefix, which a `›`-hunting parse could mistake for a title.
        expect(
            failedTitles(
                "  ok  1 [chromium] › shot.pw.ts:321:1 › geo flow (12.1s)\n\n  24 passed (17.4s)\n",
            ),
        ).toEqual([]);
        expect(failedTitles("")).toEqual([]);
    });

    test("the list ends at the next summary category — a flaky title is not a failure", () => {
        const mixed = [
            "  2 failed",
            "    [chromium] › shot.pw.ts:321:1 › geo authoring flow ──────────────",
            "    [chromium] › shot.pw.ts:521:1 › tangent edit flow ───────────────",
            "  1 flaky",
            "    [chromium] › shot.pw.ts:900:1 › force authoring flow ────────────",
            "  21 passed (30.0s)",
        ].join("\n");
        expect(failedTitles(mixed)).toEqual([
            "[chromium] › shot.pw.ts:321:1 › geo authoring flow",
            "[chromium] › shot.pw.ts:521:1 › tangent edit flow",
        ]);
    });

    test("the block is contiguous — a later line naming a test can't join it", () => {
        // the summary is the tail of the output, so anything after the block belongs to another
        // tool. Without the contiguity guard a trailing report line reads as one more failure.
        const trailing = [
            "  1 failed",
            "    [chromium] › shot.pw.ts:321:1 › geo authoring flow ──────────────",
            "",
            "Serving HTML report › http://localhost:9323",
        ].join("\n");
        expect(failedTitles(trailing)).toEqual([
            "[chromium] › shot.pw.ts:321:1 › geo authoring flow",
        ]);
    });
});

describe("verdict — the reference stamp and the fail-closed exits", () => {
    // The gate decision itself, moved out of `capture.ts` into the seam every other harness
    // predicate is tested in. `reference: true` on a shot set is the claim that this set IS the
    // whole suite at HEAD, at default knobs, green — so every way that claim can be false has to
    // be a decision made here, not an inline conjunction nothing exercises.
    const full = {
        selective: false,
        exitCode: 0,
        collected: 24,
        counts: runCounts("  24 passed (17.4s)\n"),
        defaultKnobs: true,
    };

    test("a green full run at default knobs is the reference set", () => {
        expect(verdict(full)).toEqual({ reference: true, failure: null });
    });

    test("a selective run stands but is never the reference set", () => {
        const sel = verdict({ ...full, selective: true, collected: null });
        expect(sel.failure).toBeNull();
        expect(sel.reference).toBe(false);
    });

    test("non-default knobs make a subset-shaped set: green, but not reference", () => {
        expect(verdict({ ...full, defaultKnobs: false })).toEqual({
            reference: false,
            failure: null,
        });
    });

    test("a nonzero exit fails, and the spawn ceiling says so by name", () => {
        const red = verdict({
            ...full,
            exitCode: 1,
            counts: runCounts("  1 failed\n  23 passed\n"),
        });
        expect(red.reference).toBe(false);
        expect(red.failure).toBe("Playwright exited 1");
        expect(verdict({ ...full, exitCode: null }).failure).toContain("spawn ceiling");
    });

    test("a truncated run fails — accounted-for short of collected", () => {
        // the tail is simply missing from the summary: 21 accounted for, 24 collected. (The other
        // truncation shape — `2 did not run` alongside the rest — Playwright exits nonzero for.)
        const cut = verdict({ ...full, counts: runCounts("  21 passed (120s)\n") });
        expect(cut.reference).toBe(false);
        expect(cut.failure).toContain("truncated");
    });

    test("no summary parsed at all fails closed, never passes as a full run", () => {
        expect(verdict({ ...full, counts: null }).failure).toContain("truncated");
        expect(verdict({ ...full, collected: null }).failure).toContain("truncated");
    });

    test("a SKIPPED test fails a full run — the silent coverage drop the oracle can't see", () => {
        // the whole soft spot: `1 skipped + 23 passed` accounts for all 24, exits 0, and every
        // other gate reads green while one flow never ran. There is no legitimate `test.skip` in
        // this suite (display gating exits before Playwright), so it fails like a truncation.
        const skipped = verdict({
            ...full,
            counts: runCounts("  1 skipped\n  23 passed (17.4s)\n"),
        });
        expect(skipped.reference).toBe(false);
        expect(skipped.failure).toContain("skipped");
    });

    test("a selective run is exempt from the skip gate — it claims no coverage", () => {
        expect(
            verdict({
                ...full,
                selective: true,
                collected: null,
                counts: runCounts("  1 skipped\n"),
            }).failure,
        ).toBeNull();
    });

    test("a failing full run is never stamped reference, whatever the knobs", () => {
        for (const counts of [
            runCounts("  1 skipped\n  23 passed\n"),
            runCounts("  22 passed\n"),
            null,
        ])
            for (const defaultKnobs of [true, false])
                expect(verdict({ ...full, counts, defaultKnobs }).reference).toBe(false);
    });
});

describe("the staged host files mirror the knob guards verbatim", () => {
    // `capture.pw.config.ts` and `flow.ts` are staged to the Windows host STANDALONE (`wsl.ts`),
    // so they can import nothing and carry their own copy of the guards. Hand-written copies had
    // already drifted — no upper bound on either host-side knob, `KEX_PORT` read raw, and a comment
    // claiming a blank-guard that wasn't there — so the copies are pinned character-identical to
    // the original, and pinned to be REACHED (a verbatim but unused copy guards nothing).
    const read = (name: string): string =>
        readFileSync(join(import.meta.dir, "..", "harness", name), "utf8");
    const fn = (source: string, name: string): string => {
        const start = source.indexOf(`function ${name}(`);
        const end = source.indexOf("\n}\n", start);
        if (start < 0 || end < 0) throw new Error(`no ${name}() found in the source`);
        return source.slice(start, end + 2);
    };
    const args = read("args.ts");
    const config = read("capture.pw.config.ts");
    const flow = read("flow.ts");
    const capture = read("capture.ts");

    test("the copies are character-identical to args.ts", () => {
        expect(fn(config, "intEnv")).toBe(fn(args, "intEnv"));
        expect(fn(config, "boolEnv")).toBe(fn(args, "boolEnv"));
        expect(fn(flow, "intEnv")).toBe(fn(args, "intEnv"));
    });

    test("every knob is read through a guard, at the same range on both sides", () => {
        expect(config).toContain('intEnv(process.env, "KEX_WORKERS", 4, 1, 64)');
        expect(config).toContain('boolEnv(process.env, "KEX_HEADED")');
        expect(flow).toContain('intEnv(process.env, "KEX_PORT", 3014, 1024, 65_535)');
        expect(flow).toContain('intEnv(process.env, "KEX_SHOT_MS", 300, 0, 60_000)');
        expect(capture).toContain('intEnv(process.env, "KEX_PORT", DEFAULT_PORT, 1024, 65_535)');
        expect(capture).toContain('intEnv(process.env, "KEX_WORKERS", DEFAULT_WORKERS, 1, 64)');
        expect(capture).toContain('intEnv(process.env, "KEX_SHOT_MS", DEFAULT_SHOT_MS, 0, 60_000)');
        expect(capture).toContain('boolEnv(process.env, "KEX_HEADED")');
    });

    test("the orchestrator's defaults are the numbers the host-side fallbacks use", () => {
        expect(capture).toContain("const DEFAULT_PORT = 3014;");
        expect(capture).toContain("const DEFAULT_WORKERS = 4;");
        expect(capture).toContain("const DEFAULT_SHOT_MS = 300;");
    });
});

describe("every staged flow file is in capture.ts's stage.files list", () => {
    // The split (`kex2d-harness.md` "Growth") turned staging from "the one file" into a file
    // LIST — `capture.ts`'s `stage.files` — and a list can silently drop an entry a glob never
    // would. This walks the harness dir for the real staged set (`flow.ts` + every `*.pw.ts` flow
    // file) and pins that each one is named in `stage.files`, so a new flow file landing without
    // its own staging line fails HERE, not as a truncated run on the Windows host. Proven red by
    // hand: dropping `lab.pw.ts` from the list below and re-running failed this test, as the rule
    // that introduced the split requires (`coding.md`: a check is evidence only if seen failing).
    const harnessDir = join(import.meta.dir, "..", "harness");
    const capture = readFileSync(join(harnessDir, "capture.ts"), "utf8");
    const start = capture.indexOf("files: [");
    const end = capture.indexOf("]", start);
    if (start < 0 || end < 0) throw new Error("no stage.files list found in capture.ts");
    const staged = new Set([...capture.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    const real = readdirSync(harnessDir).filter(
        (name) => name === "flow.ts" || name.endsWith(".pw.ts"),
    );

    test("the real staged set is non-empty (a broken glob can't pass vacuously)", () => {
        expect(real.length).toBeGreaterThan(0);
    });

    test("every real flow.ts / *.pw.ts file is named in stage.files", () => {
        for (const name of real)
            expect(staged.has(name), `${name} missing from stage.files`).toBe(true);
    });
});

describe("no raw waitForTimeout except the SHOT_MS settle before a screenshot", () => {
    // kex2d-capture-deflake S1: two standing rules banned a raw `waitForTimeout` sleep racing
    // per-RAF `$derived` propagation and found zero of the class across green-gated stages — the
    // ban had no enumerator. This walks the SAME real staged set the block above already derives
    // (`flow.ts` + every `*.pw.ts` file in `harness/`, never a hand-picked list) and reds any
    // `waitForTimeout(...)` call whose argument is not exactly `SHOT_MS` — the one lawful sleep
    // (`flow.ts`'s own docblock: "used only immediately before a screenshot... every other wait
    // here is a condition"). The exclusion is asserted both ways in the flow files themselves:
    // a real member exists (every `*.pw.ts` file's own `waitForTimeout(SHOT_MS)` lines), and it
    // is genuinely the only shape admitted — this test's own seed-and-revert proof, run by hand
    // at write time (see the docblock below), is what makes that claim more than assumed.
    const harnessDir = join(import.meta.dir, "..", "harness");
    const real = readdirSync(harnessDir).filter(
        (name) => name === "flow.ts" || name.endsWith(".pw.ts"),
    );

    // one (production line, arg) pair per call site, across the whole real set — never a
    // per-file sample — so a violation in any staged flow file reds this arm regardless of
    // which file it lands in.
    // Scans the joined file text, not per line, so a call split across lines (`waitForTimeout(\n
    // 200\n)`) is still found — a per-line regex misses it entirely (zero violations, silent).
    // The reported `line` is where the call's `(` opens, matching what a per-line scan reported
    // for the single-line shapes this replaces. Paren-depth tracking (not `[^)]*`) is what lets
    // a nested-paren or computed arg (`SHOT_MS * 2`, `someFn(x)`) resolve to its real closing
    // paren rather than the first one encountered.
    function nonShotSleeps(): { file: string; line: number; arg: string }[] {
        const violations: { file: string; line: number; arg: string }[] = [];
        for (const name of real) {
            const text = readFileSync(join(harnessDir, name), "utf8");
            const callRe = /waitForTimeout\(/g;
            let m: RegExpExecArray | null;
            while ((m = callRe.exec(text))) {
                const argStart = m.index + m[0].length;
                let depth = 1;
                let i = argStart;
                while (i < text.length && depth > 0) {
                    if (text[i] === "(") depth++;
                    else if (text[i] === ")") depth--;
                    i++;
                }
                const arg = text
                    .slice(argStart, i - 1)
                    .replace(/\s+/g, " ")
                    .trim();
                if (arg !== "SHOT_MS") {
                    const line = text.slice(0, m.index).split("\n").length;
                    violations.push({ file: name, line, arg });
                }
            }
        }
        return violations;
    }

    test("the real staged set is non-empty (a broken glob can't pass vacuously)", () => {
        expect(real.length).toBeGreaterThan(0);
    });

    test("at least one file carries the lawful SHOT_MS form (the exclusion names a real member)", () => {
        const hasShotMs = real.some((name) =>
            readFileSync(join(harnessDir, name), "utf8").includes("waitForTimeout(SHOT_MS)"),
        );
        expect(hasShotMs).toBe(true);
    });

    test("no staged flow file carries a waitForTimeout whose argument is not SHOT_MS", () => {
        const violations = nonShotSleeps();
        expect(
            violations,
            violations.map((v) => `${v.file}:${v.line} waitForTimeout(${v.arg})`).join("\n") ||
                "no violations",
        ).toEqual([]);
    });

    // RED-FIRST WITNESS (run by hand, not shipped as a mutation the suite re-runs): seeded
    // `await page.waitForTimeout(200);` into `harness/lab.pw.ts` (an unexcluded staged flow
    // file) and re-ran this file alone — the arm above reported exactly one violation
    // (`lab.pw.ts:<line> waitForTimeout(200)`), exit code 1. Deleted the seed (never
    // `git checkout`/`restore` on a file with no other edits, `git.md`) and re-ran — 0
    // violations, exit code 0. Both directions witnessed 2026-08-25.
    //
    // MULTI-LINE WITNESS (2026-08-25, same protocol): a per-line regex misses a call split
    // across lines, so the scan above is joined-text/paren-depth, not per-line. Seeded
    // `await page.waitForTimeout(\n    200\n);` before `lab.pw.ts`'s own `waitForTimeout
    // (SHOT_MS)` line and re-ran `bun test ./tests/harness.test.ts -t "no staged flow file
    // carries a waitForTimeout"` — one violation, `lab.pw.ts:207 waitForTimeout(200)` (the
    // line the call's `(` opens on), exit code 1. Deleted the seed, re-ran — 0 violations,
    // exit code 0. The scan reads only the files under `harness/` this arm walks (`flow.ts` +
    // every `*.pw.ts`), never this test file's own prose, so a docblock elsewhere in this repo
    // quoting `waitForTimeout(200)` as text (as this comment now does) cannot trip it — the
    // scanned text and the file holding this comment are disjoint by construction.
});

describe("provisionKey / provisioned — when the host reinstalls", () => {
    const pkg = { dependencies: { "@playwright/test": "^1.59.1", playwright: "^1.59.1" } };
    const lock =
        '{"lockfileVersion":1,"packages":{"@playwright/test":["@playwright/test@1.59.1"]}}';
    const key = (p: Record<string, unknown>, l = lock): string => provisionKey(p, l).key;

    test("the key covers the whole dependency block and is order-independent", () => {
        const { key: k, pin } = provisionKey(pkg, lock);
        expect(pin).toBe("^1.59.1");
        expect(
            key({ dependencies: { playwright: "^1.59.1", "@playwright/test": "^1.59.1" } }),
        ).toBe(k);
    });

    test("a changed RANGE changes the key even though the installed version still satisfies it", () => {
        // the whole point of hashing the block rather than reading the installed version: 1.59.1
        // satisfies ^1.59.1 forever, so a version key would never reinstall after this edit.
        expect(
            key({ dependencies: { ...pkg.dependencies, "@playwright/test": "^1.62.0" } }),
        ).not.toBe(key(pkg));
    });

    test("an added dependency changes the key", () => {
        expect(
            key({ dependencies: { ...pkg.dependencies, "@axe-core/playwright": "^4.0.0" } }),
        ).not.toBe(key(pkg));
    });

    test("EVERY dependency-relevant block is in the key, not just `dependencies`", () => {
        // a caret range resolves to whatever is newest, so the blocks that steer resolution decide
        // what the host's node_modules actually becomes: an override or a devDependency edit that
        // left the key alone would be a stage serving a tree nobody asked for.
        for (const block of [
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
            "overrides",
        ])
            expect(key({ ...pkg, [block]: { "@playwright/test": "1.60.0" } })).not.toBe(key(pkg));
        expect(key({ ...pkg, trustedDependencies: ["playwright"] })).not.toBe(key(pkg));
    });

    test("the LOCK is in the key — a transitive bump the ranges can't see still reinstalls", () => {
        // the lock is what the host installs from (`--frozen-lockfile`), so an identical
        // package.json over a different lock is a different tree.
        expect(key(pkg, `${lock}\n// resolved elsewhere`)).not.toBe(key(pkg));
        expect(key(pkg, "")).not.toBe(key(pkg)); // no lock staged at all is its own state
    });

    test("a package.json declaring no Playwright is a hard error, not an empty key", () => {
        expect(() => provisionKey({ dependencies: { svelte: "^5.0.0" } }, lock)).toThrow(
            "no @playwright/test dependency",
        );
        expect(() => provisionKey({}, lock)).toThrow("no @playwright/test dependency");
    });

    test("the stage is reused only when the marker matches AND the tree is really there", () => {
        const k = key(pkg);
        expect(provisioned(`${k}\n`, k, true)).toBe(true); // the marker is written with a newline
        expect(provisioned(null, k, true)).toBe(false); // never provisioned
        expect(provisioned("deadbeef", k, true)).toBe(false); // provisioned for other deps
        // the marker's own ordering (deleted before the install, written after the result is
        // verified) already rules a torn install out; this half catches a node_modules deleted
        // from under a valid marker — a hand-cleaned stage dir, or the host's TEMP swept.
        expect(provisioned(`${k}\n`, k, false)).toBe(false);
    });
});

describe("stalePrune — a deleted flow file must not outlive the checkout in the stage", () => {
    // The stage dir is persistent (its `node_modules` is the point) and the config collects tests
    // by GLOB, so a staged `*.pw.ts` the repo no longer has keeps running there. Observed live: a
    // pre-split `shot.pw.ts` ran a whole suite of REMOVED features beside the current 28 flows and
    // the run reported a mix of passes and failures for code that isn't in the tree.
    const files = ["package.json", "bun.lock", "capture.pw.config.ts", "flow.ts", "geo.pw.ts"];
    const stale = /\.pw\.ts$/;

    test("deletes a staged flow file the current set no longer lists", () => {
        expect(stalePrune(["flow.ts", "geo.pw.ts", "shot.pw.ts"], files, stale)).toEqual([
            "shot.pw.ts",
        ]);
    });

    test("keeps every file the stage still stages, and everything the pattern doesn't name", () => {
        expect(
            stalePrune(
                [
                    "package.json",
                    "bun.lock",
                    "flow.ts",
                    "geo.pw.ts",
                    ".provisioned",
                    "node_modules",
                ],
                files,
                stale,
            ),
        ).toEqual([]);
    });

    test("no pattern means no pruning — the opt-in stays opt-in", () => {
        expect(stalePrune(["shot.pw.ts"], files, undefined)).toEqual([]);
    });
});
