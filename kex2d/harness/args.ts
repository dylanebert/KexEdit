// The capture orchestrator's pure decision layer: what a command line asks for, whether a `--out`
// dir may be wiped, and whether an env knob is a legal value. Split out of `capture.ts` (a script
// that runs a capture on import) so both are unit-testable — `tests/harness.test.ts`.

import { DECLARED_TITLES } from "./declared";
import { testTitle } from "./trend";

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

/**
 * The suite-count oracle's LEFT-hand side: what a `--list` pre-pass says the config COLLECTS,
 * off its `Total: 23 tests in 1 file` line. Null when no such line parsed — a config that collects
 * nothing (or a Playwright that failed before reporting) must fail the run, never pass it silently.
 */
export function collectedCount(stdout: string): number | null {
    const total = /^Total:\s+(\d+) test/m.exec(stdout);
    return total ? Number(total[1]) : null;
}

/** every category Playwright's summary can print, and the total they account for */
export interface RunCounts {
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    interrupted: number;
    didNotRun: number;
    /** the suite-count oracle's RIGHT-hand side: every test accounted for, whatever its outcome */
    total: number;
}

// Playwright's own word for each category → the field it lands in. The ONE list: the summary
// pattern below is built from these keys, so a category can never be matched without a field to
// count it in. Spelled separately, a drift fails OPEN — an unmatched category still reaches `total`
// (keeping the oracle's two sides equal) while its own count stays 0, which is exactly the silent
// pass the skip gate exists to close.
const FIELD = {
    passed: "passed",
    failed: "failed",
    flaky: "flaky",
    skipped: "skipped",
    interrupted: "interrupted",
    "did not run": "didNotRun",
} as const;

// A summary line — `  22 passed (17.4s)`, `  1 failed`, `  2 did not run`. Anchored at the line's
// leading indent so only the summary block matches: a per-test progress line
// (`ok  1 [chromium] › shot.pw.ts:321:1 › geo authoring flow`) and a failure-detail line
// (`1) [chromium] › …`) both start with something other than a digit after the indent.
const SUMMARY = new RegExp(String.raw`^\s+(\d+) (${Object.keys(FIELD).join("|")})\b`);

/**
 * Playwright's summary block, per category. `total` is what the suite-count oracle compares against
 * `collectedCount` — `did not run` is exactly what a `globalTimeout` truncation reports, and the
 * whole reason the total exists. `skipped` is read on its own: it keeps the two sides equal while
 * dropping coverage, so only its own number exposes it. Null when no summary line parsed at all,
 * which fails every comparison closed.
 */
export function runCounts(stdout: string): RunCounts | null {
    const counts: RunCounts = {
        passed: 0,
        failed: 0,
        flaky: 0,
        skipped: 0,
        interrupted: 0,
        didNotRun: 0,
        total: 0,
    };
    let seen = false;
    for (const line of stdout.split("\n")) {
        const m = SUMMARY.exec(line);
        if (!m) continue;
        counts[FIELD[m[2] as keyof typeof FIELD]] += Number(m[1]);
        counts.total += Number(m[1]);
        seen = true;
    }
    return seen ? counts : null;
}

/**
 * The titles of the flows that failed, off the summary block's own list: a `1 failed` line followed
 * by one indented `[chromium] › shot.pw.ts:3097:1 › temporary red probe ────` line per failure,
 * box-drawing pad and all. The reporter output is gone once the run is over, so these names are what
 * `RUN.json` carries into a flake post-mortem (`kex2d-harness.md`: a multi-flow red is presumptively
 * host-level — the SET of titles is the signature).
 *
 * The block is read as contiguous and only under `failed`: the same titles head the error dumps
 * above it (`1) [chromium] › …`) and reappear under `flaky`, and either would double-count.
 */
export function failedTitles(stdout: string): string[] {
    const titles: string[] = [];
    let collecting = false;
    for (const line of stdout.split("\n")) {
        const m = SUMMARY.exec(line);
        if (m) {
            collecting = m[2] === "failed";
            continue;
        }
        if (!collecting) continue;
        const title = line.replace(/[─\s]+$/, "").trim();
        if (title.includes("›")) titles.push(title);
        else collecting = false;
    }
    return titles;
}

/** what a finished run leaves to judge: its exit, what it collected, what its summary said */
export interface RunFacts {
    /** a filtered run — it merges its shots over the set and claims no coverage */
    selective: boolean;
    /** Playwright's exit code; null when the spawn ceiling fired and it never exited */
    exitCode: number | null;
    /** the `--list` pre-pass total; null on a selective run, which takes no pre-pass */
    collected: number | null;
    /** the summary parse (`runCounts`); null when Playwright printed no summary at all */
    counts: RunCounts | null;
    /** the knobs that change WHAT the set is are all at their defaults (resolved in `capture.ts`) */
    defaultKnobs: boolean;
    /** the titles of the flows that failed, parsed from the summary block (`failedTitles` above);
     * empty on a green run. Deciding field for declared-set membership: the title (after `testTitle`
     * extraction in `trend.ts`), not the raw `file:line` line — the roster's identity key. */
    failedTitles: string[];
}

export interface Verdict {
    /** the shot set IS the whole collected suite at this HEAD, at default knobs, green */
    reference: boolean;
    /** why the run must exit nonzero, or null when it stands */
    failure: string | null;
}

/**
 * The gate decision: whether the run stands, and whether its shot set may be stamped `reference`.
 *
 * A **boolean against the declared set** (`DECLARED_TITLES` in `declared.ts`): a full run whose
 * reds are all declared exits 0 (stands) and stamps `reference: false`; a full run with any red
 * outside the set exits 1 naming that title. The declared set is the committed punch list — never
 * a tolerance floor — so the gate distinguishes a regression (a new red outside the set) from
 * weather (a declared red with an owner). `reference: true` still requires a fully green run
 * (the existing invariant): a declared red stands but is never the reference set, because the
 * shot set it leaves is not the whole suite green. Deciding field for `reference`: `exitCode === 0
 * && failedTitles.length === 0` — checked directly, not inferred from `failure === null` (which
 * is null for a declared red).
 *
 * The declared-set check applies only to **full** (non-selective) runs. A selective run's red is
 * an iteration signal (`mutate.ts`'s pairings read coupling off exit codes — read the count off its
 * own `PAIRS` array, never off a number written here), not a gate
 * decision, so a selective run with a nonzero exit still fails with `"Playwright exited N"` —
 * the same behavior `mutate.ts` and the `freshness` script have always seen. Deciding field:
 * `selective` — a selective run never reaches the declared-set check.
 *
 * Fail-closed on every way a flow can be MISSING from the set: no exit at all, an unaccounted-for
 * tail, or a skip. A skipped test fails a full run like a truncation — it leaves collected ==
 * accounted, so the suite-count oracle sees nothing while a flow silently never ran, and no
 * legitimate `test.skip` exists in this suite (display gating exits before Playwright ever
 * starts). `flaky` deliberately does not fail: that flow DID run and shot, and the config carries
 * `retries: 0` so nothing can report flaky today — `RUN.json` records the count either way, which
 * is where a retries change would show up. Only `reference` follows from the knobs: a run at
 * non-default workers or settle is a sound run whose shots are simply not the reference set.
 */
export function verdict(facts: RunFacts): Verdict {
    const failure = failureOf(facts);
    // Deciding field: `exitCode === 0 && failedTitles.length === 0` — the existing invariant that
    // `reference: true` requires a fully green run. A declared red has `failure === null` but is
    // not fully green, so this check is separate from `failure === null`.
    const fullyGreen = facts.exitCode === 0 && facts.failedTitles.length === 0;
    return {
        reference: !facts.selective && facts.defaultKnobs && failure === null && fullyGreen,
        failure,
    };
}

function failureOf({
    selective,
    exitCode,
    collected,
    counts,
    failedTitles,
}: RunFacts): string | null {
    if (exitCode === null) return "the spawn ceiling fired — Playwright never exited";
    if (exitCode !== 0) {
        // A selective run's red is an iteration signal, not a gate decision — the declared set
        // applies only to full runs. Deciding field: `selective` — a selective run never reaches
        // the declared-set check, so `mutate.ts`'s coupling reads and the `freshness` script are
        // unchanged.
        if (selective) return `Playwright exited ${exitCode}`;
        // A full red run: check every failed title against the declared set. Deciding field:
        // `testTitle(t)` — the title, not the raw `file:line` line — the roster's identity key.
        if (failedTitles.length === 0) return `Playwright exited ${exitCode}`;
        const undeclared = failedTitles
            .map(testTitle)
            .filter((title) => !DECLARED_TITLES.has(title));
        if (undeclared.length > 0) return `red outside the declared set: ${undeclared.join(", ")}`;
        // All reds are declared — the run stands (exits 0), but `reference: false` (not fully green).
        return null;
    }
    if (selective) return null;
    if (counts === null || collected === null || counts.total !== collected)
        return `${counts?.total ?? "no"} of ${collected ?? "no"} collected tests accounted for — the run was truncated`;
    if (counts.skipped > 0)
        return `${counts.skipped} of ${collected} tests skipped — a full run that skips drops coverage with every gate green`;
    return null;
}
