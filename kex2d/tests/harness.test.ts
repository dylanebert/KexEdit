import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
    boolEnv,
    collectedCount,
    failedTitles,
    intEnv,
    parseArgs,
    quietMode,
    runCounts,
    UsageError,
    verdict,
    wipeable,
} from "../harness/args";
import { type Baseline, readSurface } from "../harness/surface-budget";
import { startServer } from "../harness/server";

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

describe("quiet carrier boundary", () => {
    test("selection only; launch, reporter and timeout overrides refuse", () => {
        const env = { KEX_QUIET: "1" };
        for (const args of [
            [],
            ["--list"],
            ["-g", "S3f tools —"],
            ["--grep=x"],
            ["--grep-invert", "x"],
        ])
            expect(quietMode(env, args)).toBe(true);
        for (const arg of [
            "--headed",
            "--debug",
            "--ui",
            "--ui-port=9222",
            "--ui-host",
            "--config=x",
            "-c",
            "-cx",
            "--project=chromium",
            "--browser=chromium",
            "--reporter=html",
            "--timeout=0",
            "--global-timeout=0",
            "--retries=1",
            "--repeat-each=2",
            "--pass-with-no-tests",
            "--only-changed",
            "--",
            "--list=x",
        ])
            expect(() => quietMode(env, [arg])).toThrow("KEX_QUIET refuses");
        for (const debug of ["", "0", "1", "console"])
            expect(() => quietMode({ ...env, PWDEBUG: debug }, [])).toThrow("PWDEBUG");
        for (const name of [
            "PW_TEST_CONNECT_WS_ENDPOINT",
            "PW_TEST_REUSE_CONTEXT",
            "PW_TEST_SOURCE_TRANSFORM",
            "PW_TEST_REPORTER",
            "PLAYWRIGHT_HTML_OPEN",
            "PLAYWRIGHT_DASHBOARD",
        ])
            expect(() => quietMode({ ...env, [name]: "1" }, [])).toThrow(name);
        expect(() => quietMode(env, ["-g"])).toThrow("selection");
        expect(quietMode({}, ["--headed"])).toBe(false);
        expect(quietMode({ KEX_QUIET: "0" }, [])).toBe(false);
        expect(() => quietMode({ KEX_QUIET: "true" }, [])).toThrow(UsageError);
    });

    const launchEnv: [string, string][] = [
        ["npm_config_pwdebug", "1"],
        ["npm_package_config_pwdebug", "1"],
        ["SELENIUM_REMOTE_URL", "http://127.0.0.1:4444"],
        ["SELENIUM_REMOTE_CAPABILITIES", '{"goog:chromeOptions":{"args":[]}}'],
        ["SELENIUM_REMOTE_HEADERS", '{"x-quiet-test":"1"}'],
    ];

    test("debug aliases and Selenium routes refuse, absent overrides permit selection", () => {
        expect(quietMode({ KEX_QUIET: "1" }, ["--list"])).toBe(true);
        for (const [name, value] of launchEnv) {
            for (const raw of [value, "", "0"])
                expect(() => quietMode({ KEX_QUIET: "1", [name]: raw }, ["--list"])).toThrow(name);
        }
    });

    // Always list-only, including on a broken guard: no browser/server/Selenium launch.
    for (const [name, value] of launchEnv)
        test(`capture entry refuses ${name} before list collection`, () => {
            const result = Bun.spawnSync(["bun", "run", "harness/capture.ts", "--", "--list"], {
                cwd: join(import.meta.dir, ".."),
                env: { ...process.env, KEX_QUIET: "1", [name]: value },
                stdout: "pipe",
                stderr: "pipe",
                timeout: 15_000,
            });
            const output =
                new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
            expect(result.exitCode, name).toBe(2);
            expect(output).toContain(`KEX_QUIET refuses ${name}`);
            expect(output).not.toMatch(
                /Listing tests|Collecting the suite|server ready|Running capture flow/,
            );
        });

    test("every selected test must pass once, even with zero child exit", () => {
        for (const quiet of [true, false])
            for (const selective of [true, false]) {
                const facts = {
                    quiet,
                    selective,
                    exitCode: 0,
                    collected: 2,
                    counts: runCounts("  2 passed\n"),
                    defaultKnobs: true,
                    failedTitles: [] as string[],
                };
                expect(verdict(facts)).toEqual({ reference: !quiet && !selective, failure: null });
                for (const category of ["failed", "skipped", "flaky", "interrupted", "did not run"])
                    expect(
                        verdict({ ...facts, counts: runCounts(`  1 passed\n  1 ${category}\n`) })
                            .failure,
                    ).not.toBeNull();
                for (const collected of [0, null, 1, 3])
                    expect(verdict({ ...facts, collected }).failure).not.toBeNull();
                expect(verdict({ ...facts, counts: null }).failure).not.toBeNull();
                expect(verdict({ ...facts, exitCode: null }).failure).not.toBeNull();
                expect(verdict({ ...facts, exitCode: 1, failedTitles: ["red"] }).failure).toBe(
                    "Playwright exited 1",
                );
            }
    });

    test("occupied port refuses without harming its listener", async () => {
        const listener = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response("owned scratch"),
        });
        try {
            await expect(
                startServer("/nonexistent-must-not-spawn", listener.port!),
            ).rejects.toThrow("refusing occupied");
            expect(await (await fetch(listener.url)).text()).toBe("owned scratch");
        } finally {
            await listener.stop(true);
        }
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
        expect(boolEnv({}, "KEX_FLAG")).toBe(false);
    });

    test("a legal value parses, at the range's ends included", () => {
        expect(intEnv({ KEX_WORKERS: "8" }, "KEX_WORKERS", 4, 1, 64)).toBe(8);
        expect(intEnv({ KEX_WORKERS: "1" }, "KEX_WORKERS", 4, 1, 64)).toBe(1);
        expect(intEnv({ KEX_WORKERS: "64" }, "KEX_WORKERS", 4, 1, 64)).toBe(64);
        expect(boolEnv({ KEX_FLAG: "1" }, "KEX_FLAG")).toBe(true);
        expect(boolEnv({ KEX_FLAG: "0" }, "KEX_FLAG")).toBe(false);
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
        expect(() => boolEnv({ KEX_FLAG: "true" }, "KEX_FLAG")).toThrow(
            'KEX_FLAG must be 0 or 1 (got "true")',
        );
    });

    test("a boolean knob takes only 0 or 1 — no truthy-string coercion", () => {
        expect(() => boolEnv({ KEX_FLAG: "true" }, "KEX_FLAG")).toThrow(UsageError);
        expect(() => boolEnv({ KEX_FLAG: "" }, "KEX_FLAG")).toThrow(UsageError);
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
    // title per failure), which is the reporter the capture already runs.

    // Recorded verbatim from a live run on the retired WSL seat (2026-08-25, a deliberately-red
    // probe flow), tail included — hence the host path in its stack line. The parse it pins is
    // reporter-shaped, not seat-shaped: the summary block is the LAST thing Playwright prints, the
    // title carries the `[project] › ` prefix, and the box-drawing pad runs to the terminal width.
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

    // RETIRED with its contract (`checks.md`, "Retirement is a coverage decision"): the CRLF arm
    // pinned that a title survives the `\r\n` line endings the retired WSL seat's powershell
    // transport handed back. The capture now spawns `playwright test` natively on this seat, so no
    // CRLF stdout reaches the parse and there is no surviving check to name for it — an explicit
    // coverage cut, not a moved property. The `[─\s]+$` strip that made it pass is unchanged.

    test("a green run leaves none", () => {
        // a real progress line, ASCII `ok` form included, with the `[chromium] › ` project prefix a
        // `›`-hunting parse could mistake for a title.
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
        failedTitles: [] as string[],
    };

    test("a green full run at default knobs is the reference set", () => {
        expect(verdict(full)).toEqual({ reference: true, failure: null });
    });

    test("a selective run stands but is never the reference set", () => {
        const sel = verdict({ ...full, selective: true });
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

    test("a selective run also refuses skipped execution", () => {
        expect(
            verdict({
                ...full,
                selective: true,
                collected: 1,
                counts: runCounts("  1 skipped\n"),
            }).failure,
        ).toContain("skipped");
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

describe("the standalone-loaded files mirror the knob guards verbatim", () => {
    // `capture.pw.config.ts` and `flow.ts` are loaded by Playwright's own loader and import nothing
    // local, so they carry their own copy of the guards. Hand-written copies had
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
        expect(fn(config, "assertQuietEnv")).toBe(fn(args, "assertQuietEnv"));
        expect(config).toContain("if (quiet) assertQuietEnv(process.env)");
        expect(fn(args, "quietMode")).toContain("assertQuietEnv(env)");
        expect(config).toContain('boolEnv(process.env, "KEX_QUIET")');
        expect(config).toContain("headless: quiet");
        expect(capture).toContain("quietMode(process.env, testArgs)");
        expect(fn(flow, "intEnv")).toBe(fn(args, "intEnv"));
    });

    test("every knob is read through a guard, at the same range on both sides", () => {
        expect(config).toContain('intEnv(process.env, "KEX_WORKERS", 4, 1, 64)');
        expect(flow).toContain('intEnv(process.env, "KEX_PORT", 3014, 1024, 65_535)');
        expect(flow).toContain('intEnv(process.env, "KEX_SHOT_MS", 300, 0, 60_000)');
        expect(capture).toContain('intEnv(process.env, "KEX_PORT", DEFAULT_PORT, 1024, 65_535)');
        expect(capture).toContain('intEnv(process.env, "KEX_WORKERS", DEFAULT_WORKERS, 1, 64)');
        expect(capture).toContain('intEnv(process.env, "KEX_SHOT_MS", DEFAULT_SHOT_MS, 0, 60_000)');
    });

    test("the orchestrator's defaults are the numbers the host-side fallbacks use", () => {
        expect(capture).toContain("const DEFAULT_PORT = 3014;");
        expect(capture).toContain("const DEFAULT_WORKERS = 4;");
        expect(capture).toContain("const DEFAULT_SHOT_MS = 300;");
    });
});

describe("every flow file is in capture.ts's suite.files list", () => {
    // The split (`kex2d-harness.md` "Verifier integrity") turned the suite from "the one file" into
    // a file LIST — `capture.ts`'s `suite.files` — and a list can silently drop an entry a glob
    // never would. This walks the harness dir for the real flow set (`flow.ts` + every `*.pw.ts`
    // flow file) and pins that each one is named in `suite.files`, so a new flow file landing
    // without its own line fails HERE, not as a suite nobody declared. Proven red by
    // hand: dropping `lab.pw.ts` from the list below and re-running failed this test, as the rule
    // that introduced the split requires (`coding.md`: a check is evidence only if seen failing).
    const harnessDir = join(import.meta.dir, "..", "harness");
    const capture = readFileSync(join(harnessDir, "capture.ts"), "utf8");
    const start = capture.indexOf("files: [");
    const end = capture.indexOf("]", start);
    if (start < 0 || end < 0) throw new Error("no suite.files list found in capture.ts");
    const staged = new Set([...capture.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    const real = readdirSync(harnessDir).filter(
        (name) => name === "flow.ts" || name.endsWith(".pw.ts"),
    );

    test("the real flow set is non-empty (a broken glob can't pass vacuously)", () => {
        expect(real.length).toBeGreaterThan(0);
    });

    test("every real flow.ts / *.pw.ts file is named in suite.files", () => {
        for (const name of real)
            expect(staged.has(name), `${name} missing from suite.files`).toBe(true);
    });
});

describe("no raw waitForTimeout except the SHOT_MS settle before a screenshot", () => {
    // kex2d-capture-deflake S1: two standing rules banned a raw `waitForTimeout` sleep racing
    // per-RAF `$derived` propagation and found zero of the class across green-gated stages — the
    // ban had no enumerator. This walks the SAME real flow set the block above already derives
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
    // per-file sample — so a violation in any flow file reds this arm regardless of
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

    test("the real flow set is non-empty (a broken glob can't pass vacuously)", () => {
        expect(real.length).toBeGreaterThan(0);
    });

    // the "a real member carries the lawful SHOT_MS form" arm retired with the flows themselves
    // (`retired/pose-ux`): the only `*.pw.ts` in the tree is `adapter.pw.ts`, the display witness,
    // which takes no screenshot and so carries no settle — there is still no member to name. The
    // violation arm below runs over the whole flow set regardless, and the first lane-gesture flow
    // restores the positive member.

    test("no flow file carries a waitForTimeout whose argument is not SHOT_MS", () => {
        const violations = nonShotSleeps();
        expect(
            violations,
            violations.map((v) => `${v.file}:${v.line} waitForTimeout(${v.arg})`).join("\n") ||
                "no violations",
        ).toEqual([]);
    });

    // RED-FIRST WITNESS (run by hand, not shipped as a mutation the suite re-runs): seeded
    // `await page.waitForTimeout(200);` into `harness/lab.pw.ts` (an unexcluded flow
    // file, live at the time) and re-ran this file alone — the arm above reported exactly one violation
    // (`lab.pw.ts:<line> waitForTimeout(200)`), exit code 1. Deleted the seed (never
    // `git checkout`/`restore` on a file with no other edits, `git.md`) and re-ran — 0
    // violations, exit code 0. Both directions witnessed 2026-08-25.
    //
    // MULTI-LINE WITNESS (2026-08-25, same protocol): a per-line regex misses a call split
    // across lines, so the scan above is joined-text/paren-depth, not per-line. Seeded
    // `await page.waitForTimeout(\n    200\n);` before `lab.pw.ts`'s own `waitForTimeout
    // (SHOT_MS)` line and re-ran `bun test ./tests/harness.test.ts -t "no flow file
    // carries a waitForTimeout"` — one violation, `lab.pw.ts:207 waitForTimeout(200)` (the
    // line the call's `(` opens on), exit code 1. Deleted the seed, re-ran — 0 violations,
    // exit code 0. The scan reads only the files under `harness/` this arm walks (`flow.ts` +
    // every `*.pw.ts`), never this test file's own prose, so a docblock elsewhere in this repo
    // quoting `waitForTimeout(200)` as text (as this comment now does) cannot trip it — the
    // scanned text and the file holding this comment are disjoint by construction.
});

// RETIRED with the WSL→Windows staging bridge (`harness/wsl.ts`, deleted this stage):
// `provisionKey`/`provisioned` decided when the persistent host stage reinstalled its
// `node_modules`, and `stalePrune` decided which `*.pw.ts` a persistent stage dir had to drop. The
// capture now runs `playwright test` in `harness/` itself, so there is no second tree to provision
// and no stage dir a deleted flow file can outlive — the checkout IS the run dir and the glob reads
// it directly. Both contracts ENDED; no surviving check is named for them, because there is nothing
// left to hold (`checks.md`, "Retirement is a coverage decision"). The harness's own dependency
// install is `package.json`'s `harness:deps`, frozen, covered by `bun run check` running it.

describe("surface-budget — portable production refusals and monotone baseline", () => {
    const implementation = readFileSync(
        join(import.meta.dir, "../harness/surface-budget.ts"),
        "utf8",
    );
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    const initial: Baseline = {
        version: 1,
        files: { "AGENTS.md": { bytes: 12, maxParagraphChars: 5 } },
        totalBytes: 12,
        processChecks: [],
    };
    function fixture(
        body: (f: {
            root: string;
            put: (path: string, text: string) => void;
            save: (value: Baseline) => void;
            bytes: () => string;
            run: (...args: string[]) => { exit: number; output: string };
        }) => void,
    ): void {
        const root = mkdtempSync(join(tmpdir(), "kex2d-surface-"));
        const baselinePath = join(root, "kex2d/harness/surface-budget.json");
        const put = (path: string, text: string) => {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        };
        put("AGENTS.md", "alpha\n\nbeta\n");
        put("kex2d/harness/surface-budget.ts", implementation);
        const save = (value: Baseline) => writeFileSync(baselinePath, JSON.stringify(value));
        save(structuredClone(initial));
        try {
            body({
                root,
                put,
                save,
                bytes: () => readFileSync(baselinePath, "utf8"),
                run: (...args) => {
                    const child = Bun.spawnSync(
                        [
                            process.execPath,
                            ...pkg.scripts["surface-budget"].split(" ").slice(1),
                            ...args,
                        ],
                        {
                            cwd: join(root, "kex2d"),
                        },
                    );
                    return {
                        exit: child.exitCode,
                        output: child.stdout.toString() + child.stderr.toString(),
                    };
                },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
    test("manifest command runs outside the checkout without private imports; unchanged is byte-identical", () => {
        expect(pkg.scripts["surface-budget"]).toBe("bun run harness/surface-budget.ts");
        fixture((f) => {
            const before = f.bytes();
            expect(f.run().exit).toBe(0);
            expect(f.bytes()).toBe(before);
            expect(readSurface(f.root)).toEqual({
                files: initial.files,
                totalBytes: 12,
                processChecks: [],
            });
        });
    });
    for (const [name, edit, expected] of [
        [
            "file bytes",
            (b: Baseline) => {
                b.totalBytes = 99;
                b.files["AGENTS.md"]!.maxParagraphChars = 99;
            },
            "file bytes: AGENTS.md",
        ],
        [
            "aggregate bytes",
            (b: Baseline) => {
                b.files["AGENTS.md"] = { bytes: 99, maxParagraphChars: 99 };
            },
            "total bytes",
        ],
        ["paragraph growth despite byte reduction", (_b: Baseline) => {}, "paragraph: AGENTS.md"],
    ] as const) {
        test(`refuses ${name} independently and never writes the baseline`, () =>
            fixture((f) => {
                const b = structuredClone(initial);
                edit(b);
                f.save(b);
                f.put(
                    "AGENTS.md",
                    name === "paragraph growth despite byte reduction"
                        ? "alpha beta\n"
                        : "alpha\n\nbeta!\n",
                );
                const before = f.bytes();
                const result = f.run();
                expect(result.exit).toBe(1);
                expect(result.output.match(/\[FAIL\].*/g)).toEqual([`[FAIL] ${expected}`]);
                expect(f.bytes()).toBe(before);
            }));
    }
    for (const path of [
        ".claude/rules/new.md",
        ".claude/skills/new/SKILL.md",
        ".claude/commands/plant.md",
        "nested/deeper/AGENTS.md",
        "layers/structure.md",
        "nested/context.md",
    ]) {
        test(`discovers and refuses unlisted ${path}`, () =>
            fixture((f) => {
                f.save({ ...initial, totalBytes: 999 });
                f.put(path, "new\n");
                const before = f.bytes();
                const result = f.run();
                expect(result.exit).toBe(1);
                expect(result.output.match(/\[FAIL\].*/g)).toEqual([
                    `[FAIL] unlisted instruction: ${path}`,
                ]);
                expect(f.bytes()).toBe(before);
            }));
    }
    test("discovers process checks by harness location and imports, not all product tests", () =>
        fixture((f) => {
            f.put("kex2d/tests/track.test.ts", 'import { test } from "bun:test";');
            expect(readSurface(f.root).processChecks).toEqual([]);
            for (const path of [
                "kex2d/harness/new.test.ts",
                "kex2d/tests/arbitrary.test.ts",
                "kex2d/tests/harness.test.ts",
            ]) {
                f.put(path, 'import { readSurface } from "../harness/surface-budget";');
                const before = f.bytes();
                const result = f.run();
                expect(result.exit).toBe(1);
                expect(result.output).toContain(`[FAIL] unlisted process check: ${path}`);
                expect(f.bytes()).toBe(before);
                rmSync(join(f.root, path));
            }
        }));
    test("process replacement refuses even at the same count", () =>
        fixture((f) => {
            f.save({ ...initial, processChecks: ["kex2d/tests/harness.test.ts"] });
            f.put("kex2d/harness/replacement.test.ts", "");
            const before = f.bytes();
            expect(f.run().exit).toBe(1);
            expect(f.bytes()).toBe(before);
        }));
    test("successful reduction removes deleted members and ceilings; second pass is identical", () =>
        fixture((f) => {
            f.save({
                ...initial,
                files: { ...initial.files, "CLAUDE.md": { bytes: 8, maxParagraphChars: 8 } },
                totalBytes: 20,
                processChecks: ["kex2d/tests/harness.test.ts"],
            });
            f.put("AGENTS.md", "a\n");
            expect(f.run().exit).toBe(0);
            const lowered = f.bytes();
            expect(JSON.parse(lowered)).toEqual({
                version: 1,
                files: { "AGENTS.md": { bytes: 2, maxParagraphChars: 2 } },
                totalBytes: 2,
                processChecks: [],
            });
            expect(f.run().exit).toBe(0);
            expect(f.bytes()).toBe(lowered);
        }));
    test("CLAUDE pointers count separately, physical aliases once", () =>
        fixture((f) => {
            f.put("CLAUDE.md", "@AGENTS.md\n");
            symlinkSync(join(f.root, "AGENTS.md"), join(f.root, "context.md"));
            const reading = readSurface(f.root);
            expect(Object.keys(reading.files)).toEqual(["AGENTS.md", "CLAUDE.md"]);
            expect(reading.totalBytes).toBe(23);
        }));
    test("missing or invalid baseline and seed arguments cannot initialize or replace it", () =>
        fixture((f) => {
            const before = f.bytes();
            expect(f.run("--seed").exit).toBe(1);
            expect(f.bytes()).toBe(before);
            f.put("kex2d/harness/surface-budget.json", '{"version":1}');
            expect(f.run().exit).toBe(1);
            expect(f.bytes()).toBe('{"version":1}');
            rmSync(join(f.root, "kex2d/harness/surface-budget.json"));
            expect(f.run().exit).toBe(1);
            expect(existsSync(join(f.root, "kex2d/harness/surface-budget.json"))).toBe(false);
        }));
});
