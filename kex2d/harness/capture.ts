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
//                                       → only the matching flows; every arg but `--out` passes
//                                         through to `playwright test`, so `-g`/`--repeat-each`/
//                                         `--reporter` all work
//
// A full run (no passthrough args) owns the shot set and wipes `--out` first. A SELECTIVE run merges
// its shots over what's there instead, so iterating on one flow can't destroy the reference set. Every
// run — green or red — copies its shots back (a failure's shots are the diagnostic) and writes
// `RUN.json` beside them recording what produced the set: `reference: true` means a full run at that
// HEAD exited 0, anything else means the set is a subset, a failure, or both.

const harnessDir = import.meta.dir;
const projectDir = resolve(harnessDir, "..");
const PORT = 3014;

function usage(msg: string): never {
    console.error(`capture: ${msg}\nusage: bun run capture [--out DIR] [-- <playwright test args>]`);
    process.exit(2);
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
    } else {
        testArgs.push(arg);
    }
}
const outDir = resolve(out ?? join(harnessDir, "shots"));
const selective = testArgs.length > 0;

if (!detectDisplay()) {
    console.log("No display available. Skipping capture.");
    process.exit(0);
}

if (!selective) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const server = await startServer(projectDir, PORT, "kex2d");
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
const run = runPlaywright({
    dir: harnessDir,
    config: "capture.pw.config.ts",
    args: testArgs,
    stage: {
        name: "kex2d-harness",
        files: ["package.json", "capture.pw.config.ts", "shot.pw.ts"],
        clean: ["shots", "test-results"],
    },
    env: (staged) => ({
        KEX_PORT: String(PORT),
        KEX_OUT: staged ? `${staged.win}\\shots` : outDir,
    }),
    timeoutMs: 360_000,
});

if (run.staged) {
    const wslShots = join(run.staged.wsl, "shots");
    if (existsSync(wslShots)) cpSync(wslShots, outDir, { recursive: true });
}

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
            reference: !selective && run.exitCode === 0,
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
console.log(`PASS: screenshots → ${outDir}`);
process.exit(0);
