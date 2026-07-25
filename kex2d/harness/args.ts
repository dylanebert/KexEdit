// The capture orchestrator's pure decision layer: what a command line asks for, and whether an env
// knob is a legal value. Split out of `capture.ts` (a script that runs a capture on import) so both
// are unit-testable — `tests/harness.test.ts`.

/** thrown by everything here; `capture.ts` turns it into the usage message + a nonzero exit */
export class UsageError extends Error {}

export interface CaptureArgs {
    /** the `--out DIR` value as written, or null for the default shot dir */
    out: string | null;
    /** everything else, forwarded verbatim to `playwright test` */
    testArgs: string[];
    /** a filtered run: it MERGES its shots over the set instead of wiping it */
    selective: boolean;
    /** a `--list` run: collects the suite without running it, so it touches no shots and no RUN.json */
    listing: boolean;
}

/**
 * Split `bun run capture`'s argv into the harness's own `--out` and the Playwright passthrough.
 *
 * A bare `--` is DROPPED: `bun run capture -- -g <pattern>` is the documented recipe and bun
 * forwards the separator itself, but passed on it reaches Playwright's CLI as an end-of-options
 * marker, so `-g` degrades to a positional file filter — the whole suite runs while the caller
 * still counts the run selective (measured: 22 tests vs the filter's 1). It addresses bun, not us.
 */
export function parseArgs(argv: string[]): CaptureArgs {
    const testArgs: string[] = [];
    let out: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--out") {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("-"))
                throw new UsageError("--out needs a directory");
            out = value;
            i++;
        } else if (arg.startsWith("--out=")) {
            const value = arg.slice("--out=".length);
            if (!value) throw new UsageError("--out= needs a directory");
            out = value;
        } else if (arg !== "--") {
            testArgs.push(arg);
        }
    }
    return { out, testArgs, selective: testArgs.length > 0, listing: testArgs.includes("--list") };
}

/**
 * An env knob as an integer in range. `Number` alone maps "" to 0 and garbage to NaN, and both
 * reach Playwright as a value rather than an error — zero workers runs no tests at all (burning to
 * the global timeout after the shot set is already wiped), NaN lands in a timeout.
 */
export function intEnv(
    name: string,
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
        throw new UsageError(
            `${name} must be an integer in [${min}, ${max}] (got ${JSON.stringify(raw)})`,
        );
    return n;
}

/** an env flag, strictly `0` or `1` — an unset knob is false */
export function boolEnv(name: string, raw: string | undefined): boolean {
    if (raw === undefined) return false;
    if (raw !== "0" && raw !== "1")
        throw new UsageError(`${name} must be 0 or 1 (got ${JSON.stringify(raw)})`);
    return raw === "1";
}
