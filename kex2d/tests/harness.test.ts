import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
import {
    appendRun,
    FIELDS,
    HISTORY,
    parseHistory,
    PHASES,
    resolveHistory,
    type RunRecord,
    summarize,
    tripwires,
    WINDOW,
} from "../harness/trend";
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
    // paren rather than the first one encountered. This is a text scan, not an AST parse, so a
    // `waitForTimeout(200)` spelled inside a COMMENT or a string literal within a scanned
    // `harness/*.pw.ts` file false-positives identically to a real call — a shape the scan
    // cannot distinguish from the one it exists to catch. The population is empty today (no
    // scanned file quotes the call as text), so this is latent, not live.
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

describe("kex2d-harness.md's Cost levers section carries no pasted measurement", () => {
    // kex2d-capture-deflake S3a: the three cost levers (worker count, aggregate SHOT_MS spend,
    // the behavior-only-mode ceiling) are recorded as DERIVATIONS — the command that reads each
    // factor and the structural relation between them, never a frozen wall-clock or count
    // (`doc-hygiene.md` §9: a quoted count is drift by construction). The surrounding doc
    // legitimately carries numbers (the port, the worker/SHOT_MS defaults quoted verbatim from
    // source), so this scan is section-scoped to "## Cost levers" by heading boundary, never the
    // whole file — an unscoped literal gate over this doc is unreachable and stops being evidence
    // (`doc-hygiene.md` §9's own "per file, not per sweep" point).
    const docPath = join(import.meta.dir, "..", "..", ".claude", "rules", "kex2d-harness.md");

    function costLeversSection(): string {
        const text = readFileSync(docPath, "utf8");
        const heading = "## Cost levers";
        const start = text.indexOf(heading);
        if (start === -1) throw new Error(`${heading} not found in ${docPath}`);
        const rest = text.slice(start + heading.length);
        const next = rest.indexOf("\n## ");
        return next === -1 ? rest : rest.slice(0, next);
    }

    // a wall-clock figure: a number immediately followed by a time unit — "60.8s", "134.2s",
    // "2.2m" all match. A source-quoted default (the `4` in `intEnv(..., "KEX_WORKERS", 4, 1,
    // 64)`, `300` in `KEX_SHOT_MS`'s default) never matches: nothing in this section follows one
    // of those digits directly with a time-unit word.
    const WallClock = /\d[\d.,_]*\s*(?:s|sec|secs|second|seconds|ms|m|min|mins|minute|minutes)\b/i;
    // a pasted run/call-site count — "63 passed", "1653 pass", "49 call sites" — the shape a
    // `bun test` / `bun run capture` summary line prints.
    const RunCount = /\d[\d,]*\s*(?:passed|pass|failed|fail|call sites?|flows?|tests?)\b/i;

    test("carries no wall-clock figure", () => {
        const section = costLeversSection();
        const hit = WallClock.exec(section);
        expect(
            hit?.[0] ?? null,
            hit ? `"${hit[0]}" reads as a pasted wall-clock figure` : "none",
        ).toBeNull();
    });

    test("carries no pasted run/call-site count", () => {
        const section = costLeversSection();
        const hit = RunCount.exec(section);
        expect(hit?.[0] ?? null, hit ? `"${hit[0]}" reads as a pasted count` : "none").toBeNull();
    });

    // RED-FIRST WITNESS, both directions (run by hand, not shipped as a mutation the suite
    // re-runs): seeded the sentence "measured 60.8s at default workers vs 134.2s at
    // KEX_WORKERS=1, 49 call sites total" into the Cost levers section's worker-count bullet and
    // re-ran `bun test ./tests/harness.test.ts -t "Cost levers"` — 2 fail, 0 pass: the wall-clock
    // arm reported `"60.8s" reads as a pasted wall-clock figure` and the count arm reported
    // `"49 call sites" reads as a pasted count`, exit code 1. Deleted the seed (never
    // `git checkout`/`restore` on a file with other live edits, `git.md`) and re-ran the same
    // filter — 2 pass, 0 fail, exit code 0. Both directions witnessed 2026-08-25.
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

describe("trend — the recorded run distribution and its tripwires", () => {
    // `kex2d-iteration-speed` S4. `RUN.json` records ONE run and the next full run wipes the shot
    // set it lives in, so the distribution and the across-ship roster the Ship protocol's escalation
    // ladder records into can only exist in the appended history. These arms pin the reader's three
    // decisions: which population is comparable, what a missing field does, and what breaches.
    const run = (over: Partial<RunRecord> = {}): RunRecord => ({
        at: "2026-08-26T00:00:00.000Z",
        head: "aaaaaaa",
        selective: false,
        defaultKnobs: true,
        exitCode: 0,
        failedTitles: [],
        durations: { collect: 1_600, server: 500, run: 70_000, total: 74_000 },
        ...over,
    });

    test("blank lines are skipped, records survive round-trip", () => {
        const text = `${JSON.stringify(run())}\n\n${JSON.stringify(run({ head: "bbbbbbb" }))}\n`;
        expect(parseHistory(text).map((r) => r.head)).toEqual(["aaaaaaa", "bbbbbbb"]);
        expect(parseHistory("")).toEqual([]);
    });

    test("the required-field registry cannot silently shrink", () => {
        // `FIELDS` is one source of truth: the reader validates against it and the sweep below
        // derives from it, so the two can never disagree — which is exactly why a DROPPED entry is
        // invisible to that sweep (the reader stops requiring it and the sweep stops testing it, in
        // lockstep). This is the registry's own membership pin, the only leg that reds on a shrink.
        expect(FIELDS.map((f) => f.name)).toEqual([
            "at",
            "head",
            "selective",
            "defaultKnobs",
            "exitCode",
            "failedTitles",
            "durations",
        ]);
    });

    test("a record missing a consumed field fails loud, naming the field", () => {
        // The witness the spec's Validation names: delete the field and the READER reds. A reader
        // that defaulted it would report a healthy trend off a column nobody is filling. Swept over
        // the reader's OWN exported field list, not a second hand list here — dropping an entry
        // from `FIELDS` reds this arm's `durations`/`failedTitles` legs rather than going unnoticed.
        for (const field of FIELDS) {
            const dropped = { ...run() } as Record<string, unknown>;
            delete dropped[field.name];
            expect(
                () => parseHistory(`${JSON.stringify(dropped)}\n`),
                `dropping "${field.name}" did not red the reader`,
            ).toThrow(`runs.jsonl line 1: missing field "${field.name}"`);
        }
        for (const phase of PHASES) {
            const partial = { ...run().durations } as Record<string, unknown>;
            delete partial[phase];
            expect(() =>
                parseHistory(`${JSON.stringify({ ...run(), durations: partial })}\n`),
            ).toThrow(`runs.jsonl line 1: missing field "durations.${phase}"`);
        }
        expect(() => parseHistory("not json\n")).toThrow("runs.jsonl line 1: not JSON");
    });

    test("a wrongly-typed top-level field fails loud, naming the field and its expected type", () => {
        // The presence check alone (`field in raw`) never inspects what's IN the field —
        // `exitCode: "0"` passes it and then reads `"0" !== 0` as true anywhere a consumer
        // compares against the number 0, flipping a pass into a red count; the CLI accepts an
        // arbitrary path (`process.argv[2] ?? HISTORY`), so a hand-edited or legacy-format file
        // is a sanctioned input, not a hypothetical one. `FIELDS` carries each field's type, so
        // this check derives from the same registry the presence check already walks.
        const cases: [keyof RunRecord, unknown, string][] = [
            ["at", 123, "a string"],
            ["head", 7, "a string or null"],
            ["selective", "false", "a boolean"],
            ["defaultKnobs", 1, "a boolean"],
            ["exitCode", "0", "a finite number or null"],
            ["failedTitles", "none", "an array of strings"],
            ["failedTitles", [1, 2], "an array of strings"],
            ["durations", "nope", "an object"],
        ];
        for (const [field, value, expectedType] of cases) {
            const bad = { ...run(), [field]: value };
            expect(
                () => parseHistory(`${JSON.stringify(bad)}\n`),
                `"${field}" = ${JSON.stringify(value)} did not red the reader`,
            ).toThrow(`runs.jsonl line 1: "${field}" is not ${expectedType}`);
        }
    });

    test("a non-finite duration fails loud rather than defeating the tripwire's comparison", () => {
        // NaN itself has no valid JSON representation (`JSON.parse('{"a":NaN}')` throws a
        // SyntaxError before this reader ever sees it — checked directly against Bun's parser).
        // The two classes of non-finite value real JSON text CAN carry are a string in a numeric
        // slot (a writer bug) and Infinity (a legal JSON literal like `1e400` overflows to it) —
        // both would otherwise flow into `median` and make `recentMedian > priorMax` false on
        // BOTH sides, so a duration-rot tripwire over such a record silently reports no breach.
        for (const phase of ["server", "run", "total"] as const) {
            const stringy = { ...run(), durations: { ...run().durations, [phase]: "74000" } };
            expect(() => parseHistory(`${JSON.stringify(stringy)}\n`)).toThrow(
                `runs.jsonl line 1: "durations.${phase}" is not a finite number`,
            );
            const overflowLine = JSON.stringify(run()).replace(
                new RegExp(`"${phase}":\\d+`),
                `"${phase}":1e400`,
            );
            expect(() => parseHistory(`${overflowLine}\n`)).toThrow(
                `runs.jsonl line 1: "durations.${phase}" is not a finite number`,
            );
        }
        // `collect` is the one phase legitimately null (a selective run spends no --list
        // pre-pass) — null still passes, but a non-finite `collect` still reds like its siblings.
        const nullCollect = { ...run(), durations: { ...run().durations, collect: null } };
        expect(() => parseHistory(`${JSON.stringify(nullCollect)}\n`)).not.toThrow();
        const stringCollect = { ...run(), durations: { ...run().durations, collect: "1600" } };
        expect(() => parseHistory(`${JSON.stringify(stringCollect)}\n`)).toThrow(
            'runs.jsonl line 1: "durations.collect" is not a finite number',
        );
    });

    test("only full default-knob runs are the comparable population", () => {
        const summary = summarize([
            run(),
            run({ selective: true, exitCode: 1, failedTitles: ["t"] }),
            run({ defaultKnobs: false, exitCode: 1, failedTitles: ["t"] }),
            run({ exitCode: 1, failedTitles: ["t"] }),
        ]);
        expect(summary.population).toBe(2);
        expect(summary.red).toBe(1);
        // `at` is a required field, so it owes a consumer: the span a person is being shown
        expect(summary.span).toEqual({
            since: "2026-08-26T00:00:00.000Z",
            until: "2026-08-26T00:00:00.000Z",
        });
        // the selective and knob-shifted reds carried the same title and contributed no head
        expect(summary.roster).toEqual([{ title: "t", heads: ["aaaaaaa"] }]);
    });

    test("a trend needs two full windows, and reads recent against the prior RANGE", () => {
        const at = (total: number): RunRecord =>
            run({ durations: { collect: 1, server: 1, run: total, total } });
        expect(summarize(Array.from({ length: WINDOW * 2 - 1 }, () => at(70_000))).phases).toEqual(
            [],
        );

        const prior = [70_000, 90_000, 70_000, 70_000, 70_000].map(at);
        const inside = summarize([...prior, ...Array.from({ length: WINDOW }, () => at(80_000))]);
        expect(inside.phases.find((p) => p.phase === "total")).toMatchObject({
            recentMedian: 80_000,
            priorMedian: 70_000,
            priorMax: 90_000,
        });
        expect(inside.phases.map((p) => p.phase)).toEqual([...PHASES]);
        // the prior window's own spread is the resolution: 80s is above its median and inside its
        // range, so it is not yet a signal.
        expect(tripwires(inside)).toEqual([]);

        const above = summarize([...prior, ...Array.from({ length: WINDOW }, () => at(95_000))]);
        const breaches = tripwires(above);
        // only the two phases the fixture actually moved — collect and server stayed flat
        expect(breaches).toHaveLength(2);
        expect(breaches.every((b) => b.startsWith("duration:"))).toBe(true);
    });

    test("the roster breaches on distinct heads, never on repeats within one pass", () => {
        const red = (head: string): RunRecord =>
            run({ head, exitCode: 1, failedTitles: ["section.pw.ts:2017 › deselect"] });
        expect(tripwires(summarize([red("aaaaaaa"), red("aaaaaaa"), red("aaaaaaa")]))).toEqual([]);
        const breach = tripwires(summarize([red("aaaaaaa"), red("bbbbbbb")]));
        expect(breach).toHaveLength(1);
        expect(breach[0]).toContain("2 distinct heads");
    });

    test("a red run with an unresolved HEAD is a loud tripwire, never a silent roster drop", () => {
        // `git rev-parse --short HEAD` returning empty (`capture.ts` maps it to `null` at both
        // `RUN.json` and `appendRun`) makes `head: null` a live input, not a hypothetical one.
        // The roster's per-head bucketing (`if (r.head !== null && ...) seen.push(r.head)`) can
        // never place a null head into a distinct-heads count, so a title that keeps reddening
        // on unresolved heads would otherwise read identically to "not yet recurring" forever —
        // the exact miscategorization `coding.md`'s no-silent-swallowing clause names: an
        // unpopulated signal reading as a healthy, sanctioned state rather than the broken-git
        // wiring it actually is. Verdict: loud, not silent — a red run with no resolvable HEAD
        // gets its own tripwire, since it can never earn one through the roster.
        const redNull = (): RunRecord =>
            run({ head: null, exitCode: 1, failedTitles: ["section.pw.ts:2017 › deselect"] });
        const summary = summarize([redNull(), redNull()]);
        // the roster mechanism alone stays silent — no head ever gets bucketed
        expect(summary.roster).toEqual([{ title: "section.pw.ts:2017 › deselect", heads: [] }]);
        // which is exactly why the count exists as its own signal
        expect(summary.unresolvedHeadReds).toBe(2);
        const breaches = tripwires(summary);
        expect(breaches.some((b) => b.startsWith("head:"))).toBe(true);
    });

    test("capture.ts stamps every phase the reader consumes", () => {
        // `capture.ts` is a top-level script (it boots a server and spawns Playwright), so no arm
        // can import it — this is a source read, and it pins only that each phase the reader
        // requires is stamped and that the record reaches `appendRun`. It cannot see whether a
        // stamp brackets the right work; that is the capture run's own reading.
        const capture = readFileSync(join(import.meta.dir, "..", "harness", "capture.ts"), "utf8");
        expect(capture).toContain('import { appendRun } from "./trend";');
        expect(capture).toContain("appendRun({");
        for (const [phase, stamp] of [
            ["collect", "collectMs"],
            ["server", "serverMs"],
            ["run", "runMs"],
            ["total", "Math.round(performance.now() - started)"],
        ])
            expect(capture, `durations.${phase} is not stamped`).toContain(`${phase}: ${stamp},`);
    });

    // RED-FIRST WITNESS for the CLI half (run by hand — this suite never shells out to a reader
    // whose whole job is to summon a person). Witnessed at the shell against a scratch history:
    // a history whose recent window sits inside the prior range printed the trend and exited 0;
    // the same history with five slower runs appended printed `TRIPWIRE duration: …` and exited 1.
    // Exit codes read from `$?`, not off a pipe.
});

describe("resolveHistory — a machine-stable path, never a per-checkout one", () => {
    // `kex2d-iteration-speed` close. Every unit's confirmation capture runs from its OWN fresh
    // worktree, retired at ship — a history resolved from `import.meta.dir` starts empty every
    // time and can never accumulate the across-ship roster the escalation ladder depends on.
    //
    // RED-FIRST WITNESS (hand-verified against the pre-repair line `HISTORY = join(import.meta.dir,
    // "runs.jsonl")`, before `resolveHistory` existed): with that resolution, `HISTORY` was
    // `<this checkout>/harness/runs.jsonl` — literally built from `import.meta.dir` — so the "does
    // not vary with the checkout" and "outside the harness checkout" arms below both failed on it
    // (the resolved path DID contain `import.meta.dir`, and it sat inside `harnessDir`). Confirmed
    // by hand-evaluating the old expression rather than by re-adding it, since restoring the old
    // line would itself need a forbidden checkout of a file already fixed.

    test("KEX2D_TREND_HISTORY wins outright", () => {
        expect(resolveHistory({ KEX2D_TREND_HISTORY: "/tmp/kex2d-custom/runs.jsonl" })).toBe(
            "/tmp/kex2d-custom/runs.jsonl",
        );
    });

    test("XDG_STATE_HOME composes the default path", () => {
        expect(resolveHistory({ XDG_STATE_HOME: "/tmp/kex2d-state" })).toBe(
            join("/tmp/kex2d-state", "kex2d", "runs.jsonl"),
        );
    });

    test("the default is absolute and outside the harness checkout", () => {
        const p = resolveHistory({});
        expect(isAbsolute(p)).toBe(true);
        const harnessDir = join(import.meta.dir, "..", "harness");
        expect(p.startsWith(harnessDir)).toBe(false);
        // the sharpest form of the same check: the resolved path never contains this checkout's
        // own directory at all, which is exactly the property the pre-repair line violated.
        expect(p).not.toContain(import.meta.dir);
    });

    test("HISTORY does not vary with the checkout — resolveHistory takes no directory input", () => {
        // A per-checkout HISTORY would have to thread `import.meta.dir` (or an equivalent)
        // through this function; it doesn't, so two calls from different `cwd`s agree by
        // construction. Exercised, not just asserted: chdir and re-resolve.
        const before = process.cwd();
        try {
            process.chdir("/tmp");
            const fromTmp = resolveHistory({});
            process.chdir(before);
            const fromHere = resolveHistory({});
            expect(fromTmp).toBe(fromHere);
        } finally {
            process.chdir(before);
        }
    });

    test("the exported HISTORY constant is resolveHistory(process.env)", () => {
        expect(HISTORY).toBe(resolveHistory(process.env));
    });

    test("appendRun creates the parent directory on demand", () => {
        // a machine-stable path outside any checkout starts with no directory at all on a fresh
        // machine — `appendRun` must create it rather than throw `ENOENT`.
        const root = mkdtempSync(join(tmpdir(), "kex2d-history-"));
        const path = join(root, "nested", "kex2d", "runs.jsonl");
        try {
            appendRun(
                {
                    at: "2026-08-26T00:00:00.000Z",
                    head: "aaaaaaa",
                    selective: false,
                    defaultKnobs: true,
                    exitCode: 0,
                    failedTitles: [],
                    durations: { collect: 1_600, server: 500, run: 70_000, total: 74_000 },
                },
                path,
            );
            expect(parseHistory(readFileSync(path, "utf8"))).toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("kex2d-harness.md's Recorded distribution section says what trend.ts implements", () => {
    // The two-values-must-agree defect (`coding.md`): the doc states the derivations and the code
    // performs them, so the doc drifts silently the moment either moves. Pins the section exists,
    // names its own artifacts, and — like Cost levers above — carries no pasted measurement, a
    // section about durations being the likeliest place for one to land.
    const docPath = join(import.meta.dir, "..", "..", ".claude", "rules", "kex2d-harness.md");
    const section = ((): string => {
        const text = readFileSync(docPath, "utf8");
        const heading = "## Recorded distribution";
        const start = text.indexOf(heading);
        if (start === -1) throw new Error(`${heading} not found in ${docPath}`);
        const rest = text.slice(start + heading.length);
        const next = rest.indexOf("\n## ");
        return next === -1 ? rest : rest.slice(0, next);
    })();

    test("names the artifacts a reader has to find", () => {
        // `resolveHistory`, not `harness/runs.jsonl`: the latter is the RETIRED per-checkout
        // shape and the section still contains that literal string inside the clause that names
        // it as retired (`kex2d-iteration-speed` close) — a token match on it would pass for the
        // wrong reason, pinning a foil rather than the current mechanism. `resolveHistory` is
        // reachable only from the section's live description of where the history actually
        // lives.
        for (const token of ["resolveHistory", "trend.ts", "bun run trend", "WINDOW"])
            expect(section).toContain(token);
    });

    test("carries no pasted wall-clock figure or run count", () => {
        const wall =
            /\d[\d.,_]*\s*(?:s|sec|secs|second|seconds|ms|m|min|mins|minute|minutes)\b/i.exec(
                section,
            );
        expect(
            wall?.[0] ?? null,
            wall ? `"${wall[0]}" reads as a wall-clock figure` : "none",
        ).toBeNull();
        const count =
            /\d[\d,]*\s*(?:passed|pass|failed|fail|call sites?|flows?|tests?|runs?)\b/i.exec(
                section,
            );
        expect(
            count?.[0] ?? null,
            count ? `"${count[0]}" reads as a pasted count` : "none",
        ).toBeNull();
    });
});
