import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
} from "./args";
import { runPlaywright } from "./playwright";
import { startServer } from "./server";
import { appendRun, RECORD_VERSION } from "./trend";
import { detectDisplay } from "./wsl";

// Wall-clock origin for the phase stamps `RUN.json` records. Taken before anything is parsed so
// `total` is the whole process, and the stamped phases summing under it is what makes the
// unattributed remainder visible rather than absorbed.
const started = performance.now();

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
// A full run (no passthrough args) owns the shot set and wipes `--out` first — so it refuses to run
// at all unless that dir is absent, empty, or a prior shot set (`args.ts` `wipeable`). A SELECTIVE
// run merges its shots over what's there instead, so iterating on one flow can't destroy the set. A
// `--list` run captures nothing, so it touches neither. Every capturing run — green or red — copies
// its shots back (a failure's shots are the diagnostic) and writes `RUN.json` beside them recording
// what produced the set: `reference: true` means a full run at that HEAD, at the default knobs, ran
// the WHOLE collected suite (nothing skipped) and exited 0; anything else means the set is a subset,
// a failure, taken at non-default knobs, or all three. Alongside it: the per-category counts, and a
// red run's failed flow TITLES — the reporter output is gone by the time anyone reads the set, and
// the set of titles is the signature a host-level flake is diagnosed from (`args.ts`).

const harnessDir = import.meta.dir;
const projectDir = resolve(harnessDir, "..");

// The knob defaults. Forwarded explicitly, so the staged run, the RUN.json record, and the reference
// gate all read one resolved value. `capture.pw.config.ts` (workers, headed) and `flow.ts`
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

// The pure decision layer (`args.ts`) throws; here is where a bad command line becomes an exit.
function resolveArgs<T>(f: () => T): T {
    try {
        return f();
    } catch (e) {
        if (e instanceof UsageError)
            fail(`${e.message}\nusage: bun run capture [--out DIR] [-- <playwright test args>]`);
        throw e;
    }
}

const { out, testArgs, selective, listing } = resolveArgs(() => parseArgs(process.argv.slice(2)));
const outDir = resolve(out ?? join(harnessDir, "shots"));

const { port, workers, shotMs, headed } = resolveArgs(() => ({
    port: intEnv(process.env, "KEX_PORT", DEFAULT_PORT, 1024, 65_535),
    workers: intEnv(process.env, "KEX_WORKERS", DEFAULT_WORKERS, 1, 64),
    shotMs: intEnv(process.env, "KEX_SHOT_MS", DEFAULT_SHOT_MS, 0, 60_000),
    headed: boolEnv(process.env, "KEX_HEADED"),
}));
// The host staging dir is per-port by default, so two sessions on different ports never share one
// `node_modules`/`shots` tree (the concurrent-capture hazard: a second capture kills the first's
// server and rebinds the port with its own tree).
const stageName = process.env.KEX_STAGE || `kex2d-harness-${port}`;

// A full run wipes `--out` (below) and the path is caller-supplied, so the target is checked before
// anything else happens: a directory holding files this harness did not write is a usage error, not
// a shot dir. Without this, `--out=.` deletes the kex2d tree.
if (!selective) {
    const stat = statSync(outDir, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) fail(`--out ${outDir} is not a directory`);
    if (!wipeable(stat ? readdirSync(outDir) : null))
        fail(
            `refusing to wipe ${outDir}: it holds files this harness did not write (a shot set carries RUN.json).\nname a fresh --out DIR, or clear that one yourself if it really is a stale shot set`,
        );
}

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
            files: [
                "package.json",
                "bun.lock",
                "capture.pw.config.ts",
                "flow.ts",
                "geo.pw.ts",
                "force.pw.ts",
                "section.pw.ts",
                "lab.pw.ts",
                "affordance.pw.ts",
                "freshness.pw.ts",
                "substrate.pw.ts",
            ],
            clean: ["shots", "test-results"],
            // the config collects by glob, so a flow file this repo deleted must not survive in the
            // persistent stage and run beside the current set (`stalePrune`, wsl.ts).
            stale: /\.pw\.ts$/,
        },
        // The staged host run is a fresh powershell environment, so a knob only reaches the run if
        // it is passed here by name: `capture.pw.config.ts` reads KEX_WORKERS + KEX_HEADED,
        // `flow.ts` reads KEX_PORT + KEX_OUT + KEX_SHOT_MS.
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
// shot set intact. Both sides of the oracle parse in `args.ts`, where they are unit-tested.
let collectMs: number | null = null;
const collected = ((): number | null => {
    if (selective) return null;
    console.log("Collecting the suite (--list)...");
    const listStart = performance.now();
    const list = launch(["--list"]);
    collectMs = Math.round(performance.now() - listStart);
    if (list.exitCode !== 0) fail(`the suite did not collect (--list exit ${list.exitCode})`);
    const total = collectedCount(list.stdout);
    if (total === null) fail("the --list pre-pass reported no collected count");
    return total;
})();

if (!selective) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const serverStart = performance.now();
const server = await startServer(projectDir, port, "kex2d");
const serverMs = Math.round(performance.now() - serverStart);
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
const runStart = performance.now();
const run = launch(testArgs);
const runMs = Math.round(performance.now() - runStart);

if (run.staged) {
    const wslShots = join(run.staged.wsl, "shots");
    if (existsSync(wslShots)) cpSync(wslShots, outDir, { recursive: true });
}

// The gate decision lives in `args.ts` with every other harness predicate, where it is unit-tested:
// what the run stands or dies on, and whether its shots may be stamped `reference`. Only the knobs
// that change what the shot set IS reach it; the port and the stage dir are provenance (they change
// where it ran, not what it captured).
const counts = runCounts(run.stdout);
// One resolved value: the gate reads it to decide whether the shots may be stamped `reference`, and
// the recorded distribution reads it to decide whether this run's wall clock belongs in the same
// population as the others (`trend.ts` — a non-default-knob run captured a different quantity).
const defaultKnobs = workers === DEFAULT_WORKERS && !headed && shotMs === DEFAULT_SHOT_MS;
const titles = failedTitles(run.stdout);
const { reference, failure } = verdict({
    selective,
    exitCode: run.exitCode,
    collected,
    counts,
    defaultKnobs,
    failedTitles: titles,
});

const durations = {
    collect: collectMs,
    server: serverMs,
    run: runMs,
    total: Math.round(performance.now() - started),
};

const git = (args: string[]): string =>
    new TextDecoder()
        .decode(Bun.spawnSync(["git", ...args], { cwd: projectDir, stdout: "pipe" }).stdout)
        .trim();
const head = git(["rev-parse", "--short", "HEAD"]) || null;
const dirty = git(["status", "--porcelain"]) !== "";
// `--abbrev-ref HEAD` returns "HEAD" in a detached state — not a real branch name
const branchRaw = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
writeFileSync(
    join(outDir, "RUN.json"),
    `${JSON.stringify(
        {
            head,
            branch,
            dirty,
            args: testArgs,
            exitCode: run.exitCode,
            env: { workers, headed, shotMs, port, stage: stageName },
            // The oracle's two sides (`collected` vs `total`) plus the whole category split — a red
            // or flaky run's shape is what a post-mortem reads, and `runCounts` already computed it.
            // A summary that didn't parse leaves the categories absent, never zeroed.
            counts: { collected, ...counts },
            failedTitles: titles,
            // What the run SPENT, per phase. A duration threshold gates the host and not the
            // artifact (`checks.md`), so nothing reds on these — they are recorded, and
            // `trend.ts` reads the distribution they accumulate into.
            durations,
            reference,
        },
        null,
        2,
    )}\n`,
);

// Same run, appended to the history `trend.ts` reads: `RUN.json` lives inside the shot set the next
// full run WIPES, so it can record a run but never a distribution or an across-ship roster.
appendRun({
    at: new Date().toISOString(),
    head,
    branch,
    dirty,
    version: RECORD_VERSION,
    selective,
    defaultKnobs,
    exitCode: run.exitCode,
    failedTitles: titles,
    durations,
});

cleanup();
if (failure !== null) {
    console.error(`capture FAILED: ${failure}`);
    process.exit(1);
}
console.log(`PASS: screenshots → ${outDir}`);
process.exit(0);
