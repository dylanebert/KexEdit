// The capture orchestrator's pure decision layer: what a command line asks for, whether a `--out`
// dir may be wiped, and whether an env knob is a legal value. Split out of `capture.ts` (a script
// that runs a capture on import) so both are unit-testable — `tests/harness.test.ts`.

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

// `--out DIR` and `--out=DIR` share one value guard: a missing or itself-flag-shaped value means the
// directory was omitted. `--out -g` would otherwise resolve the shot dir to "-g", and `--out=-x`
// would create — then WIPE — `./-x`.
function outValue(value: string | undefined): string {
    if (value === undefined || value === "" || value.startsWith("-"))
        throw new UsageError(`--out needs a directory (got ${JSON.stringify(value ?? null)})`);
    return value;
}

/**
 * Split `bun run capture`'s argv into the harness's own `--out` and the Playwright passthrough.
 *
 * A bare `--` is DROPPED: `bun run capture -- -g <pattern>` is the documented recipe and bun
 * forwards the separator itself, but passed on it reaches Playwright's CLI as an end-of-options
 * marker, so `-g` degrades to a positional file filter — the whole suite runs while the caller
 * still counts the run selective (measured: 22 tests vs the filter's 1). It addresses bun, not us.
 *
 * That is also why `--out` is scanned across the WHOLE line rather than a leading harness-only
 * segment: bun swallows the boundary `--` before argv reaches this script, so there is no reliable
 * marker to split on and no "inside the passthrough" to protect. Nothing collides today — the
 * Playwright flag in this neighbourhood is `--output`.
 */
export function parseArgs(argv: string[]): CaptureArgs {
    const testArgs: string[] = [];
    let out: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--out") {
            out = outValue(argv[i + 1]);
            i++;
        } else if (arg.startsWith("--out=")) {
            out = outValue(arg.slice("--out=".length));
        } else if (arg !== "--") {
            testArgs.push(arg);
        }
    }
    return { out, testArgs, selective: testArgs.length > 0, listing: testArgs.includes("--list") };
}

/**
 * May a full run WIPE this `--out` dir? A full run owns the shot set, so `capture.ts` `rmSync`s the
 * dir before capturing — and the path is caller-supplied, so `--out=.` or `--out $HOME` would take
 * a source tree with it. Only a directory this harness could itself have written qualifies: absent
 * (`entries` null), empty, or a prior shot set — every capturing run stamps `RUN.json` beside its
 * shots, so that file is the set's provenance AND its permission slip.
 */
export function wipeable(entries: string[] | null): boolean {
    return entries === null || entries.length === 0 || entries.includes("RUN.json");
}

/**
 * An env knob as an integer in range, looked up BY NAME so the name in the error is the name that
 * was read. Every knob here is a non-negative count (workers, a port, a millisecond settle), so the
 * accepted form is a plain digit string: `Number` alone maps "" and " " to 0, reads "0x10"/"1e3"/
 * "+8"/"8." as numbers nobody typed on purpose, and garbage to NaN — and every one of those reaches
 * Playwright as a value rather than an error (zero workers runs no tests at all, burning to the
 * global timeout after the shot set is already wiped; NaN lands in a timeout).
 */
export function intEnv(
    env: Record<string, string | undefined>,
    name: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max)
        throw new UsageError(
            `${name} must be an integer in [${min}, ${max}] (got ${JSON.stringify(raw)})`,
        );
    return n;
}

/** an env flag, strictly `0` or `1` — an unset knob is false */
export function boolEnv(env: Record<string, string | undefined>, name: string): boolean {
    const raw = env[name];
    if (raw === undefined) return false;
    if (raw !== "0" && raw !== "1")
        throw new UsageError(`${name} must be 0 or 1 (got ${JSON.stringify(raw)})`);
    return raw === "1";
}
