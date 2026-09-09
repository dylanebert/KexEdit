import { createServer } from "node:net";
import { basename } from "node:path";

const STARTUP_TIMEOUT_MS = Number(process.env.SERVER_STARTUP_TIMEOUT_MS) || 60_000;
const PROBE_TIMEOUT_MS = 2000;

async function answers(url: string): Promise<boolean> {
    try {
        await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return true;
    } catch {
        return false;
    }
}

/** A TCP holder need not answer HTTP. Probe both loopback families, never kill the holder. */
async function available(port: number, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.once("error", () =>
            reject(new Error(`refusing occupied/unavailable port ${port} (${host})`)),
        );
        probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve()));
    });
}

/** Boot only an owned, bounded Vite child. strictPort closes the preflight/start race. */
export async function startServer(
    cwd: string,
    port: number,
    label = basename(cwd),
): Promise<ReturnType<typeof Bun.spawn>> {
    await available(port, "127.0.0.1");
    await available(port, "::1");
    const url = `http://localhost:${port}`;
    const proc = Bun.spawn(["bun", "run", "dev", "--port", String(port), "--strictPort"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, BROWSER: "none" },
    });
    // Also owns teardown if the caller exits while startup is still pending.
    const stop = (): void => {
        if (proc.exitCode === null) proc.kill();
    };
    process.once("exit", stop);
    void proc.exited.then(() => process.removeListener("exit", stop));
    let output = "";
    const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    };
    void drain(proc.stdout);
    void drain(proc.stderr);
    try {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (proc.exitCode !== null)
                throw new Error(
                    `${label} dev server exited early (code ${proc.exitCode}): ${output}`,
                );
            // An unrelated listener winning the race cannot supply our child's readiness line.
            if (
                output.includes(`localhost:${port}`) &&
                (await answers(url)) &&
                proc.exitCode === null
            ) {
                console.log(`${label} server ready on ${url}`);
                return proc;
            }
            await Bun.sleep(100);
        }
        throw new Error(
            `${label} server failed to answer on ${url} within ${STARTUP_TIMEOUT_MS}ms`,
        );
    } catch (error) {
        proc.kill();
        await proc.exited;
        throw error;
    }
}
