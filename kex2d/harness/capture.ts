import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runPlaywright } from "./playwright";
import { startServer } from "./server";
import { detectDisplay } from "./wsl";

// kex2d's screenshot harness — boot the vite dev server, drive the Playwright flow under the host's
// real-GPU Chrome (shallot's runtime needs a device even though kex2d renders canvas2D), copy the
// screenshots back. Display-gated; on WSL it runs via Windows Chrome, on a headed Linux box natively.
//
//   bun run capture                     → screenshots into harness/shots/
//   bun run capture --out DIR           → into DIR
//   bun run capture -- -g "geo authoring flow"
//                                       → only the matching flows; every arg but `--out` passes
//                                         through to `playwright test`, so `-g`/`--repeat-each`/
//                                         `--reporter` all work

const harnessDir = import.meta.dir;
const projectDir = resolve(harnessDir, "..");
const PORT = 3014;

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx !== -1 ? args[outIdx + 1] : join(harnessDir, "shots"));
const testArgs = outIdx !== -1 ? [...args.slice(0, outIdx), ...args.slice(outIdx + 2)] : args;

if (!detectDisplay()) {
    console.log("No display available. Skipping capture.");
    process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
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

cleanup();
if (run.exitCode !== 0) {
    console.error(`capture FAILED${run.timedOut ? " (spawn ceiling — Playwright did not exit)" : ""}`);
    process.exit(1);
}
console.log(`PASS: screenshots → ${outDir}`);
process.exit(0);
