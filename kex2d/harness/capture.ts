import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runPlaywright } from "./playwright";
import { startServer } from "./server";
import { detectDisplay } from "./wsl";

// kex2d's screenshot harness — boot the vite dev server, drive the Playwright flow under the host's
// real-GPU Chrome (shallot's runtime needs a device even though kex2d renders canvas2D), copy the
// screenshots back. Display-gated; on WSL it runs via Windows Chrome, on a headed Linux box natively.
//
//   bun run capture                     → screenshots into harness/shots/
//   bun run capture --out DIR           → into DIR (`--out=DIR` too)
//   bun run capture -- -g "geo authoring flow"
//                                       → only the matching flows; every arg but `--out` and a bare
//                                         `--` passes through to `playwright test`, so
//                                         `-g`/`--repeat-each`/`--reporter`/`--list` all work
//
// Env knobs, all validated here and forwarded explicitly to the staged host run: `KEX_WORKERS`
// (default 4), `KEX_HEADED=1` for the visible browser, `KEX_SHOT_MS` for the pre-screenshot settle,
// `KEX_PORT` (default 3014) + `KEX_STAGE` for the dev-server port and the host staging dir — the two
// that make a second session's capture isolatable (a capture kills whatever holds its port).
//
// A full run (no passthrough args) owns the shot set and wipes `--out` first. A SELECTIVE run merges
// its shots over what's there instead, so iterating on one flow can't destroy the reference set. A
// `--list` run captures nothing, so it touches neither. Every capturing run — green or red — copies
// its shots back (a failure's shots are the diagnostic) and writes `RUN.json` beside them recording
// what produced the set: `reference: true` means a full run at that HEAD, at the default knobs, ran
// the WHOLE collected suite and exited 0; anything else means the set is a subset, a failure, taken
// at non-default knobs, or all three.

const harnessDir = import.meta.dir;
const projectDir = resolve(harnessDir, "..");

// The knob defaults. Forwarded explicitly, so the staged run, the RUN.json record, and the reference
// gate all read one resolved value. `capture.pw.config.ts` (workers, headed) and `shot.pw.ts`
// (settle) carry the same literals as their own fallback, for a direct `playwright test` run.
const DEFAULT_PORT = 3014;
const DEFAULT_WORKERS = 4;
const DEFAULT_SHOT_MS = 300;
// The last-resort backstop above Playwright's own `globalTimeout` (420s) — it must stay above it, or
// this kills a run the config would have failed legibly.
const SPAWN_CEILING_MS = 480_000;

function fail(msg: string): never {
    console.error(`capture: ${msg}`);
    process.exit(2);
}

function usage(msg: string): never {
    fail(`${msg}\nusage: bun run capture [--out DIR] [-- <playwright test args>]`);
}

// An env knob as an integer in range. `Number` alone maps "" to 0 and garbage to NaN, and both reach
// Playwright as a value rather than an error — zero workers runs no tests at all (burning to the
// global timeout after the shot set is already wiped), NaN lands in a timeout.
function intEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
        usage(`${name} must be an integer in [${min}, ${max}] (got ${JSON.stringify(raw)})`);
    return n;
}

function boolEnv(name: string): boolean {
    const raw = process.env[name];
    if (raw === undefined) return false;
    if (raw !== "0" && raw !== "1") usage(`${name} must be 0 or 1 (got ${JSON.stringify(raw)})`);
    return raw === "1";
}

const argv = process.argv.slice(2);
const testArgs: string[] = [];
let out: string | null = null;
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) usage("--out needs a directory");
        out = value;
        i++;
    } else if (arg.startsWith("--out=")) {
        const value = arg.slice("--out=".length);
        if (!value) usage("--out= needs a directory");
        out = value;
    } else if (arg !== "--") {
        testArgs.push(arg);
    }
    // A bare `--` is dropped: `bun run capture -- -g <pattern>` is the documented recipe and bun
    // forwards the separator itself, but passed on it reaches Playwright's CLI as an end-of-options
    // marker, so `-g` degrades to a positional file filter — the whole suite runs while `capture.ts`
    // still counts the run selective (measured: 22 tests vs the filter's 1). It addresses bun, not us.
}
const outDir = resolve(out ?? join(harnessDir, "shots"));
const selective = testArgs.length > 0;
// `--list` collects and prints the suite without running it: no browser, no shots, no dev server.
const listing = testArgs.includes("--list");

const port = intEnv("KEX_PORT", DEFAULT_PORT, 1024, 65_535);
const workers = intEnv("KEX_WORKERS", DEFAULT_WORKERS, 1, 64);
const shotMs = intEnv("KEX_SHOT_MS", DEFAULT_SHOT_MS, 0, 60_000);
const headed = boolEnv("KEX_HEADED");
// The host staging dir is per-port by default, so two sessions on different ports never share one
// `node_modules`/`shots` tree (the concurrent-capture hazard: a second capture kills the first's
// server and rebinds the port with its own tree).
const stageName = process.env.KEX_STAGE || `kex2d-harness-${port}`;

if (!detectDisplay()) {
    console.log("No display available. Skipping capture.");
    process.exit(0);
}

const launch = (args: string[]): ReturnType<typeof runPlaywright> =>
    runPlaywright({
        dir: harnessDir,
        config: "capture.pw.config.ts",
        args,
        stage: {
            name: stageName,
            files: ["package.json", "capture.pw.config.ts", "shot.pw.ts"],
            clean: ["shots", "test-results"],
        },
        // The staged host run is a fresh powershell environment, so a knob only reaches the run if
        // it is passed here by name: `capture.pw.config.ts` reads KEX_WORKERS + KEX_HEADED,
        // `shot.pw.ts` reads KEX_PORT + KEX_OUT + KEX_SHOT_MS.
        env: (staged) => ({
            KEX_PORT: String(port),
            KEX_OUT: staged ? `${staged.win}\\shots` : outDir,
            KEX_WORKERS: String(workers),
            KEX_HEADED: headed ? "1" : "0",
            KEX_SHOT_MS: String(shotMs),
        }),
        timeoutMs: SPAWN_CEILING_MS,
    });

if (listing) {
    // A listing run produces no shots, so it must leave the shot set AND its RUN.json provenance
    // exactly as the last capturing run left them (a `--list` probe stamping `reference: false` over
    // a good set is how the reference flag was lost mid-spec).
    const list = launch(testArgs);
    process.exit(list.exitCode === 0 ? 0 : 1);
}

// The suite-count oracle's left-hand side: what the config COLLECTS for this run. Cheap (~3s, no
// browser) and taken before anything is wiped, so a config that collects nothing fails loud with the
// shot set intact.
const collected = ((): number | null => {
    if (selective) return null;
    console.log("Collecting the suite (--list)...");
    const list = launch(["--list"]);
    if (list.exitCode !== 0) fail(`the suite did not collect (--list exit ${list.exitCode})`);
    const total = /^Total:\s+(\d+) test/m.exec(list.stdout);
    if (!total) fail("the --list pre-pass reported no collected count");
    return Number(total[1]);
})();

// The oracle's right-hand side: every test Playwright ACCOUNTED FOR, summed across its summary lines
// ("22 passed (17.4s)", "1 failed", "2 did not run" — the last is exactly what a globalTimeout
// truncation reports). Null when no summary line parsed at all, which fails the comparison closed.
function executedCount(stdout: string): number | null {
    const re = /^\s+(\d+) (passed|failed|flaky|skipped|interrupted|did not run)\b/gm;
    let total = 0;
    let seen = false;
    for (const m of stdout.matchAll(re)) {
        total += Number(m[1]);
        seen = true;
    }
    return seen ? total : null;
}

if (!selective) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const server = await startServer(projectDir, port, "kex2d");
const cleanup = (): void => {
    server.kill();
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
});
process.on("SIGTERM", () => {
    cleanup();
    process.exit(1);
});

console.log("Running capture flow...");
const run = launch(testArgs);

if (run.staged) {
    const wslShots = join(run.staged.wsl, "shots");
    if (existsSync(wslShots)) cpSync(wslShots, outDir, { recursive: true });
}

const executed = selective ? null : executedCount(run.stdout);
const wholeSuite = selective || (collected !== null && executed === collected);
// Only the knobs that change what the shot set IS gate the reference flag; the port and the stage
// dir are provenance (they change where it ran, not what it captured).
const defaultKnobs = workers === DEFAULT_WORKERS && !headed && shotMs === DEFAULT_SHOT_MS;

const git = (args: string[]): string =>
    new TextDecoder()
        .decode(Bun.spawnSync(["git", ...args], { cwd: projectDir, stdout: "pipe" }).stdout)
        .trim();
writeFileSync(
    join(outDir, "RUN.json"),
    `${JSON.stringify(
        {
            head: git(["rev-parse", "--short", "HEAD"]) || null,
            dirty: git(["status", "--porcelain"]) !== "",
            args: testArgs,
            exitCode: run.exitCode,
            env: { workers, headed, shotMs, port, stage: stageName },
            counts: { collected, executed },
            reference: !selective && run.exitCode === 0 && wholeSuite && defaultKnobs,
        },
        null,
        2,
    )}\n`,
);

cleanup();
if (run.exitCode !== 0) {
    console.error(`capture FAILED${run.timedOut ? " (spawn ceiling — Playwright did not exit)" : ""}`);
    process.exit(1);
}
if (!wholeSuite) {
    console.error(
        `capture FAILED: ${executed ?? "no"} of ${collected} collected tests accounted for — the run was truncated`,
    );
    process.exit(1);
}
console.log(`PASS: screenshots → ${outDir}`);
process.exit(0);
