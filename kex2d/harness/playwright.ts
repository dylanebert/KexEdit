import { isWSL, stageOnWindows, type WindowsPaths } from "./wsl";

// The one place that runs `playwright test`. Native it spawns directly; under WSL it stages the
// config + flow onto the Windows host and drives them through powershell so the host's real-GPU
// Chrome runs them. The caller owns its config + flow and reads its screenshots back from
// `staged.wsl`. Mirrors shallot's harness/core + orrstead's harness.

export interface RunArgs {
    /** dir holding the playwright config + flow files — the harness's own directory */
    dir: string;
    /** config filename, relative to `dir` */
    config: string;
    /** trailing `playwright test` args */
    args?: string[];
    /** WSL staging: a temp-dir name + the files (relative to `dir`) copied to the host to run from */
    stage: { name: string; files: string[] };
    /** env for the run, built from the staged paths (`null` when native) so output dirs resolve host-side */
    env: (staged: WindowsPaths | null) => Record<string, string>;
    /** hard ceiling on the whole spawn — a backstop above Playwright's own timeout, never the guard */
    timeoutMs: number;
}

export interface RunResult {
    exitCode: number | null;
    stdout: string;
    timedOut: boolean;
    /** the Windows staging paths (WSL only, else `null`) — read screenshots back from `.wsl` */
    staged: WindowsPaths | null;
}

const quote = (s: string): string => s.replace(/'/g, "''");

function decode(stdout: Uint8Array | null | undefined): string {
    const out = new TextDecoder().decode(stdout ?? new Uint8Array());
    process.stdout.write(out);
    return out;
}

export function runPlaywright(run: RunArgs): RunResult {
    if (!isWSL) {
        const env = run.env(null);
        const result = Bun.spawnSync(
            ["bunx", "playwright", "test", "--config", run.config, ...(run.args ?? [])],
            {
                cwd: run.dir,
                stdout: "pipe",
                stderr: "inherit",
                timeout: run.timeoutMs,
                env: { ...process.env, ...env },
            },
        );
        return {
            exitCode: result.exitCode,
            stdout: decode(result.stdout),
            timedOut: result.exitCode === null,
            staged: null,
        };
    }

    const staged = stageOnWindows(run.dir, run.stage.name, run.stage.files);
    const env = run.env(staged);
    const assigns = Object.entries(env)
        .map(([k, v]) => `$env:${k} = '${quote(v)}';`)
        .join(" ");
    const tail = [run.config, ...(run.args ?? [])].map((a) => `'${quote(a)}'`).join(" ");
    const result = Bun.spawnSync(
        [
            "powershell.exe",
            "-Command",
            `${assigns} $env:PLAYWRIGHT_BROWSERS_PATH = "$env:LOCALAPPDATA\\ms-playwright"; cd '${staged.win}'; bunx playwright test --config ${tail}`,
        ],
        { stdout: "pipe", stderr: "inherit", timeout: run.timeoutMs },
    );
    return {
        exitCode: result.exitCode,
        stdout: decode(result.stdout),
        timedOut: result.exitCode === null,
        staged,
    };
}
