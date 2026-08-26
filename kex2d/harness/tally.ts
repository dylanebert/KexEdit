// kex2d's capture-rate reader — the instrument the spec reads the capture gate as: N runs
// per tree, per-test failure counts tallied. Promoted from the device-local `tally.py`
// prototype so the instrument crosses devices (the prototype is gitignored and does not).
//
// A single run of one tree cannot attribute a capture failure — `bun run capture` is
// display-gated and one-at-a-time, and a single run manufactures both a false regression
// and a false clean bill inside one stage. So the gate is a RATE: N runs, per-test failure
// counts tallied, base and branch both. A stage ships when no test's branch rate exceeds its
// base rate.
//
// Usage: bun run tally <worktree> <label> <N> [extra capture args...]
//   e.g. bun run tally ../kex-kex2d-event-substrate-base base 4
//        bun run tally . branch 4
//
// Output-parsing hazard (measured): `geo.pw.ts:61` is a `test.fail()` pin — Playwright prints
// its per-test line with the failure mark on a GREEN run and counts it in `N passed`. Any
// mark-scraping logic must exclude it or every tree reads as a 4/4 red on that one test. This
// reader excludes it by location (`geo.pw.ts:61`).
//
// The failure mark is ENVIRONMENT-DEPENDENT, not the fixed `✘` this reader originally assumed:
// a UTF-8-capable terminal prints `✘`, but the WSL→Windows bridge this harness actually runs
// under prints plain ASCII `x` — witnessed directly off a saved capture log
// (`/tmp/kex2d-s1r3/tally-branch/cap-branch-1.log:75`, kex2d-event-substrate S4 repair,
// 2026-08-25): `  x   2 [chromium] › affordance.pw.ts:190:1 › …`. The original `✘`-only regex
// read that line as a pass (0 matches on the same text `parseFailures` now catches), which is
// how an 8/8 deterministic branch failure tallied as `failed=0` for an entire N=8 batch — the
// per-run `exit=1` was the only visible signal, and it went unread alongside the mis-tallied
// rate. The fix accepts either glyph, anchored to the line's own status column (`^\s*`, then a
// mandatory `\s+\d+\s+\[chromium\]` right after the mark) so a literal `x` inside a test title
// or path can never match — only Playwright's own per-test status token can.

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const FAIL_PIN = "geo.pw.ts:61"; // the test.fail() pin — ✘ on a GREEN run by design

interface RunResult {
    run: number;
    exit: number;
    secs: number;
    failed: string[];
    summary: string;
}

function runCapture(
    wt: string,
    outDir: string,
    extra: string[],
): { exitCode: number; stdout: string; secs: number } {
    const env = { ...process.env, KEX_WORKERS: "1" };
    const t0 = Date.now();
    const result = spawnSync("bun", ["run", "capture", "--out", outDir, "--", ...extra], {
        cwd: wt,
        env,
        encoding: "utf8",
        timeout: 2_700_000,
    });
    return {
        exitCode: result.status ?? 1,
        stdout: (result.stdout ?? "") + (result.stderr ?? ""),
        secs: Math.round((Date.now() - t0) / 100) / 10,
    };
}

// Parse Playwright's failure-marked lines: "  ✘  N [chromium] › file:line:col › title" (a
// UTF-8 terminal) or "  x   N [chromium] › file:line:col › title" (this harness's WSL→Windows
// bridge, ASCII-only) — anchored to line start so a literal `x` elsewhere in a title/path can't
// match: only whitespace may precede the mark, and `\s+\d+\s+\[chromium\]` must follow it
// immediately, the exact shape of Playwright's own status column.
function parseFailures(text: string): string[] {
    const re = /^\s*(?:✘|x)\s+\d+\s+\[chromium\]\s+›\s+(\S+:\d+):\d+\s+›\s+(.+?)\s*(?:\(\d|$)/gm;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const loc = m[1];
        if (loc === FAIL_PIN) continue; // the test.fail() pin — ✘ on a GREEN run by design
        out.push(`${loc} ${m[2].trim()}`);
    }
    return [...new Set(out)].sort();
}

function parseSummary(text: string): string {
    const m = text.match(/^\s*(?:(\d+) failed)?.*?(\d+) passed/im);
    return m ? m[0].trim() : "?";
}

// ── main ────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 3) {
    console.error("usage: bun run tally <worktree> <label> <N> [extra capture args...]");
    process.exit(2);
}

const wt = resolve(args[0]);
const label = args[1];
const n = parseInt(args[2], 10);
const extra = args.slice(3);

const outRoot = `/tmp/kex2d-s1r3/tally-${label}`;
mkdirSync(outRoot, { recursive: true });

const failCounts = new Map<string, number>();
const runs: RunResult[] = [];

for (let i = 1; i <= n; i++) {
    const outDir = join(outRoot, `shots-${i}`);
    const logPath = join(outRoot, `cap-${label}-${i}.log`);
    const result = runCapture(wt, outDir, extra);
    const failed = parseFailures(result.stdout);
    const summary = parseSummary(result.stdout);

    for (const f of failed) {
        failCounts.set(f, (failCounts.get(f) ?? 0) + 1);
    }

    runs.push({ run: i, exit: result.exitCode, secs: result.secs, failed, summary });
    writeFileSync(logPath, result.stdout);
    console.log(
        `[${label}] run ${i}/${n} exit=${result.exitCode} ${result.secs}s failed=${failed.length} :: ${summary}`,
    );
}

console.log(`\n=== ${label}: per-test failure RATE over N=${n} ===`);
if (failCounts.size === 0) {
    console.log("no test failed in any run");
}
const sorted = [...failCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [test, count] of sorted) {
    console.log(`${count}/${n}  ${test}`);
}

writeFileSync(
    join(outRoot, `tally-${label}.json`),
    JSON.stringify(
        {
            label,
            n,
            runs: runs.map((r) => ({
                run: r.run,
                exit: r.exit,
                secs: r.secs,
                failed: r.failed,
                summary: r.summary,
            })),
            rates: Object.fromEntries(failCounts),
        },
        null,
        1,
    ) + "\n",
);
