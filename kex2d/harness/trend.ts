// kex2d's capture-cost anti-rot instrument: the recorded run distribution and its tripwires.
//
// `RUN.json` records what ONE run cost and whether it went red, but a full run wipes the shot set,
// so the prior run's record is gone by the time anyone would compare against it. This module is the
// history: `capture.ts` appends one line to `runs.jsonl` for every run that reaches `RUN.json` (a
// collect-fail exit, a bad-arg exit, or a SIGINT/SIGTERM never gets there, so the recorded
// population undercounts by that class), and this reader surfaces the two quantities the ship
// protocol depends on (`kex2d-harness.md` § Recorded distribution) — per-phase duration trend, and
// the across-ship flake roster the escalation ladder's step 3 records into.
//
//   bun run trend        → the recorded distribution, exit 1 if a tripwire breached
//
// A duration threshold gates the host and not the artifact (`checks.md`), so this is never wired
// into `bun test`/`bun check`: it is run, it prints, and a breach summons a person. Both tripwires
// are derived from the recorded data rather than fitted to it, because a fitted constant is a
// threshold tuned to today's host:
//
//   - duration: the recent window's MEDIAN sits ABOVE the prior window's whole observed range.
//     The suite's own run-to-run spread is the noise bound — several times any lever's effect —
//     so the prior window's max IS the instrument's resolution — no multiplier, no fitted
//     slack. One-sided on purpose: this is an anti-ROT instrument, and a suite that got faster
//     is the outcome, not the breach. A speedup that bought its time by dropping work is the
//     suite-count oracle's to catch, not this reader's.
//   - rate: one failing title recorded on two or more DISTINCT heads. That is the protocol's own
//     definition of a roster entry ("a single-flow red recurring across runs is a defect with an
//     owner, never weather"), not a rate cutoff. Distinct heads, so N repro runs inside one pass
//     cannot manufacture a recurrence.
//
// The history lives outside any checkout, at a machine-stable path (`resolveHistory`, below) — not
// because it is gitignored (every unit's confirmation capture runs from a fresh worktree that starts
// empty and is retired at ship, so a per-checkout path can never accumulate a distribution), but
// because `bun run capture` is display-gated to the one GPU-bridge host: every run in the population
// came off the same seat, so a durations column pooled across two machines would compare hosts, not
// trees, and a path outside the checkout is what lets it survive past the worktree that wrote it.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** the phases `capture.ts` stamps; `collect` is null on a selective run, which spends no --list pre-pass */
export type Durations = {
    collect: number | null;
    server: number;
    run: number;
    total: number;
};

/** one capturing run, as appended by `capture.ts` after it writes `RUN.json` */
export type RunRecord = {
    at: string;
    head: string | null;
    selective: boolean;
    defaultKnobs: boolean;
    /** null when the run was killed by a signal rather than exiting — red, never a pass */
    exitCode: number | null;
    failedTitles: string[];
    durations: Durations;
};

/** the phases a trend is read over, in the order the run spends them */
export const PHASES = ["collect", "server", "run", "total"] as const;

/**
 * runs per window. A median over five survives two extreme readings, which is the shape this
 * suite actually produces — S2 read 45.6s and 66.0s off consecutive runs of the SAME tree. Three
 * would be moved by one such reading; this is a sample size, not a threshold.
 */
export const WINDOW = 5;

/** the type each top-level field must carry — the presence check and the type check both walk
 * this table, so a hand-typed second list can never disagree with what the reader actually
 * requires */
type FieldType = "string" | "string-or-null" | "boolean" | "number-or-null" | "string[]" | "object";

const TYPE_DESCRIPTIONS: Record<FieldType, string> = {
    string: "a string",
    "string-or-null": "a string or null",
    boolean: "a boolean",
    "number-or-null": "a finite number or null",
    "string[]": "an array of strings",
    object: "an object",
};

function matchesType(value: unknown, type: FieldType): boolean {
    switch (type) {
        case "string":
            return typeof value === "string";
        case "string-or-null":
            return value === null || typeof value === "string";
        case "boolean":
            return typeof value === "boolean";
        case "number-or-null":
            return value === null || (typeof value === "number" && Number.isFinite(value));
        case "string[]":
            return Array.isArray(value) && value.every((v) => typeof v === "string");
        case "object":
            return typeof value === "object" && value !== null && !Array.isArray(value);
    }
}

/** the top-level fields the reader consumes, with the type each must carry; exported so the arm
 * sweeping them isn't a second hand list */
export const FIELDS = [
    { name: "at", type: "string" },
    { name: "head", type: "string-or-null" },
    { name: "selective", type: "boolean" },
    { name: "defaultKnobs", type: "boolean" },
    { name: "exitCode", type: "number-or-null" },
    { name: "failedTitles", type: "string[]" },
    { name: "durations", type: "object" },
] as const satisfies readonly { name: keyof RunRecord; type: FieldType }[];

/**
 * where the history lives: `KEX2D_TREND_HISTORY` wins outright, else `$XDG_STATE_HOME/kex2d` (or
 * `~/.local/state/kex2d` when unset) — a fixed function of the environment alone, never of
 * `import.meta.dir`, so the resolution can't vary with which checkout or worktree calls it.
 * @example resolveHistory(process.env)
 */
export function resolveHistory(env: Record<string, string | undefined>): string {
    if (env.KEX2D_TREND_HISTORY) return env.KEX2D_TREND_HISTORY;
    const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    return join(stateHome, "kex2d", "runs.jsonl");
}

export const HISTORY = resolveHistory(process.env);

/**
 * parse the appended history, failing loud on a record missing a field the reader consumes — an
 * absent field is a writer that stopped recording, and a reader that defaults it silently reports a
 * healthy trend off a column nobody is filling.
 * @example parseHistory(readFileSync(HISTORY, "utf8"))
 */
export function parseHistory(text: string): RunRecord[] {
    const records: RunRecord[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        const where = `runs.jsonl line ${i + 1}`;
        let raw: Record<string, unknown>;
        try {
            raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
            throw new Error(`${where}: not JSON`);
        }
        for (const field of FIELDS) {
            if (!(field.name in raw)) throw new Error(`${where}: missing field "${field.name}"`);
            if (!matchesType(raw[field.name], field.type))
                throw new Error(
                    `${where}: "${field.name}" is not ${TYPE_DESCRIPTIONS[field.type]}`,
                );
        }
        const durations = raw.durations as Record<string, unknown>;
        for (const phase of PHASES) {
            if (!(phase in durations))
                throw new Error(`${where}: missing field "durations.${phase}"`);
            const value = durations[phase];
            // `collect` is the one phase legitimately null (a selective run spends no --list
            // pre-pass); every other value must be a finite number, or a NaN/string flows into
            // `median` and the breach check `recentMedian > priorMax` false-branches to no
            // breach — both sides of that comparison are false under NaN, so a two-sided check
            // over a value that could be non-finite refuses nothing unless finiteness is checked
            // here, at the boundary, rather than implied by the comparison downstream.
            if (value === null) {
                if (phase === "collect") continue;
                throw new Error(`${where}: "durations.${phase}" is null`);
            }
            if (typeof value !== "number" || !Number.isFinite(value))
                throw new Error(`${where}: "durations.${phase}" is not a finite number`);
        }
        records.push(raw as unknown as RunRecord);
    }
    return records;
}

/**
 * append one run to the history; called by `capture.ts` once `RUN.json` is written.
 *
 * The default `path` (`HISTORY`) is now a machine-stable location every worktree on the host
 * shares, and this append takes no lock. That is safe only because `kex2d-harness.md`'s "one
 * capture at a time per port" is a standing premise on the host, not a guarantee this function
 * enforces — `appendFileSync` racing a second concurrent writer would interleave two partial
 * lines, and `parseHistory` throws loud on the resulting malformed line for every consumer, not
 * just the racing pair. Do not add a lock here or make the reader skip malformed lines; the loud
 * throw is correct, and the fix for a torn write is to hold the premise, not to paper over its
 * violation.
 * @example appendRun(record)
 */
export function appendRun(record: RunRecord, path: string = HISTORY): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export type PhaseTrend = {
    phase: string;
    recentMedian: number;
    priorMedian: number;
    priorMin: number;
    priorMax: number;
};

export type Summary = {
    /** full default-knob runs — the only population whose durations and reds are comparable */
    population: number;
    red: number;
    /** the population's first and last stamps — what window a person is being shown; null when empty */
    span: { since: string; until: string } | null;
    phases: PhaseTrend[];
    /** failing titles by the distinct heads they were recorded on, most-recurrent first */
    roster: { title: string; heads: string[] }[];
    /** full reds whose HEAD did not resolve (`git rev-parse --short HEAD` returned empty,
     * mapped to null in `capture.ts`) — invisible to the roster's per-head bucketing, since a
     * null head can never be counted as distinct from itself or from a real head. Recorded so a
     * broken git identity on this seat cannot read as "not yet recurring" forever. */
    unresolvedHeadReds: number;
};

function median(xs: number[]): number {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * reduce the history to what the tripwires read: the comparable population, its red count, the
 * per-phase recent-vs-prior windows, and the across-ship roster.
 * @example tripwires(summarize(parseHistory(text)))
 */
export function summarize(records: RunRecord[]): Summary {
    // a selective or non-default-knob run captured a different suite at different settings — its
    // wall clock is not the same quantity, and its red is not a confirmation run's red.
    const full = records.filter((r) => !r.selective && r.defaultKnobs);

    const phases: PhaseTrend[] = [];
    if (full.length >= WINDOW * 2) {
        const recent = full.slice(-WINDOW);
        const prior = full.slice(-WINDOW * 2, -WINDOW);
        for (const phase of PHASES) {
            const at = (r: RunRecord): number | null => r.durations[phase];
            const recentValues = recent.map(at).filter((v): v is number => v !== null);
            const priorValues = prior.map(at).filter((v): v is number => v !== null);
            if (recentValues.length < WINDOW || priorValues.length < WINDOW) continue;
            phases.push({
                phase,
                recentMedian: median(recentValues),
                priorMedian: median(priorValues),
                priorMin: Math.min(...priorValues),
                priorMax: Math.max(...priorValues),
            });
        }
    }

    const heads = new Map<string, string[]>();
    for (const r of full)
        for (const title of r.failedTitles) {
            const seen = heads.get(title) ?? [];
            if (r.head !== null && !seen.includes(r.head)) seen.push(r.head);
            heads.set(title, seen);
        }

    return {
        population: full.length,
        red: full.filter((r) => r.exitCode !== 0).length,
        span: full.length === 0 ? null : { since: full[0].at, until: full[full.length - 1].at },
        phases,
        roster: [...heads.entries()]
            .map(([title, hs]) => ({ title, heads: hs }))
            .sort((a, b) => b.heads.length - a.heads.length),
        unresolvedHeadReds: full.filter((r) => r.exitCode !== 0 && r.head === null).length,
    };
}

/** the breaches a person is summoned for; empty means the recorded distribution says nothing new */
export function tripwires(summary: Summary): string[] {
    const breaches: string[] = [];
    for (const p of summary.phases)
        if (p.recentMedian > p.priorMax)
            breaches.push(
                `duration: ${p.phase} median over the last ${WINDOW} runs (${ms(p.recentMedian)}) is above the whole prior window's range (${ms(p.priorMin)}–${ms(p.priorMax)})`,
            );
    for (const entry of summary.roster)
        if (entry.heads.length >= 2)
            breaches.push(
                `rate: "${entry.title}" reddened on ${entry.heads.length} distinct heads (${entry.heads.join(", ")}) — a roster entry is a defect with an owner`,
            );
    if (summary.unresolvedHeadReds > 0)
        breaches.push(
            `head: ${summary.unresolvedHeadReds} red run(s) recorded with no resolvable HEAD — cannot join the roster, git identity is broken on this seat`,
        );
    return breaches;
}

function ms(v: number): string {
    return `${(v / 1000).toFixed(1)}s`;
}

if (import.meta.main) {
    // an explicit path is how this reader is witnessed without writing over the real history
    const path = process.argv[2] ?? HISTORY;
    if (!existsSync(path)) {
        console.log(`no runs recorded yet (${path}) — run \`bun run capture\``);
        process.exit(0);
    }
    const summary = summarize(parseHistory(readFileSync(path, "utf8")));
    const span = summary.span === null ? "" : ` — ${summary.span.since} to ${summary.span.until}`;
    console.log(
        `full default-knob runs recorded: ${summary.population} (${summary.red} red)${span}`,
    );
    if (summary.phases.length === 0)
        console.log(
            `no duration trend yet — needs ${WINDOW * 2} full runs, two windows of ${WINDOW}`,
        );
    for (const p of summary.phases)
        console.log(
            `  ${p.phase.padEnd(8)} recent median ${ms(p.recentMedian)}  prior median ${ms(p.priorMedian)}  prior range ${ms(p.priorMin)}–${ms(p.priorMax)}`,
        );
    for (const entry of summary.roster)
        console.log(`  roster: ${entry.title} — heads ${entry.heads.join(", ")}`);
    const breaches = tripwires(summary);
    for (const breach of breaches) console.error(`TRIPWIRE ${breach}`);
    process.exit(breaches.length === 0 ? 0 : 1);
}
