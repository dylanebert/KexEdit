// The one place that runs `playwright test`, and it runs it natively. The browser is this seat's own
// headed Chrome on the session's display (`capture.ts` owns the display guard); there is no host
// transport left to stage onto, so the caller's config and flow files run where they live and its
// screenshots are written straight into `--out`. Mirrors orrstead's harness.

export interface RunArgs {
    /** dir holding the playwright config + flow files — the harness's own directory */
    dir: string;
    /** config filename, relative to `dir` */
    config: string;
    /** trailing `playwright test` args */
    args?: string[];
    /** env for the run (ports, out dir, knobs) */
    env: Record<string, string>;
    /** hard ceiling on the whole spawn — a backstop above Playwright's own timeout, never the guard */
    timeoutMs: number;
}

export interface RunResult {
    /** null when the spawn ceiling fired and the child never exited (`args.ts` `verdict` reads it) */
    exitCode: number | null;
    stdout: string;
}

export function runPlaywright(run: RunArgs): RunResult {
    const result = Bun.spawnSync(
        ["bunx", "playwright", "test", "--config", run.config, ...(run.args ?? [])],
        {
            cwd: run.dir,
            stdout: "pipe",
            stderr: "inherit",
            timeout: run.timeoutMs,
            env: { ...process.env, ...run.env },
        },
    );
    const stdout = new TextDecoder().decode(result.stdout ?? new Uint8Array());
    process.stdout.write(stdout);
    return { exitCode: result.exitCode, stdout };
}
