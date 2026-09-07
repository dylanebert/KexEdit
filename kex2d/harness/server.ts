import { basename } from "node:path";

// total readiness budget; past it a non-answering server is wedged, not slow
const STARTUP_TIMEOUT_MS = Number(process.env.SERVER_STARTUP_TIMEOUT_MS) || 60_000;
// every probe is time-bounded so the budget above is the only authority on how long boot waits
const PROBE_TIMEOUT_MS = 2000;
// how long a killed port holder gets to stop answering before `--strictPort` is left to say so
const PORT_QUIET_TIMEOUT_MS = 3000;

async function answers(url: string): Promise<boolean> {
    try {
        await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return true;
    } catch {
        return false;
    }
}

// Boot the kex2d vite dev server on `port` and resolve once it answers. The server runs WSL-side;
// the host Chrome reaches it over WSL2's localhost forwarding. `BROWSER=none` suppresses vite's
// auto-open — a capture never wants a tab. Throws (naming the server + port, killing the child)
// within STARTUP_TIMEOUT_MS rather than hanging.
export async function startServer(
    cwd: string,
    port: number,
    label = basename(cwd),
): Promise<ReturnType<typeof Bun.spawn>> {
    const url = `http://localhost:${port}`;
    // Something already holds this port — a stale capture, or a concurrent one on the same KEX_PORT.
    // Kill it and wait for the port to actually go QUIET rather than for a fixed grace period: the
    // wait is a condition everywhere else in this harness, and a blind one either overpays or comes
    // up short. Past the budget, `--strictPort` below turns a still-held port into the legible
    // "exited early" throw instead of a silently wrong server.
    if (await answers(url)) {
        Bun.spawnSync(["fuser", "-k", `${port}/tcp`], { stdout: "ignore", stderr: "ignore" });
        const quietBy = Date.now() + PORT_QUIET_TIMEOUT_MS;
        while (Date.now() < quietBy && (await answers(url))) await Bun.sleep(100);
    }

    const proc = Bun.spawn(["bun", "run", "dev", "--port", String(port), "--strictPort"], {
        cwd,
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, BROWSER: "none" },
    });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) {
            const stderr = await new Response(proc.stderr).text();
            throw new Error(`${label} dev server exited early (code ${proc.exitCode}): ${stderr}`);
        }
        if (await answers(url)) {
            console.log(`${label} server ready on ${url}`);
            return proc;
        }
        await Bun.sleep(500);
    }
    proc.kill();
    throw new Error(`${label} server failed to answer on ${url} within ${STARTUP_TIMEOUT_MS}ms`);
}
