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
//   - rate: one failing title recorded on two or more DISTINCT branch units (slug prefixes).
//     A recurrence must mean the red crossed a unit boundary, so the axis is the branch's slug
//     prefix — not distinct heads, which an author manufacturing recurrences by iterating on
//     one in-flight unit inflates. Dirty-tree runs and legacy (pre-version) records are excluded
//     from the roster population; legacy records keep feeding the duration windows.
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
import { DECLARED_TITLES } from "./declared";

/** the phases `capture.ts` stamps; `collect` is null on a selective run, which spends no --list pre-pass */
export type Durations = {
    collect: number | null;
    server: number;
    run: number;
    total: number;
};

/** the record schema version this reader writes and consumes; absent on legacy (pre-version) records */
export const RECORD_VERSION = 2;

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
    /** record schema version; absent on legacy (pre-version) records */
    version?: number;
    /** the branch name; required when version >= RECORD_VERSION, absent on legacy records */
    branch?: string | null;
    /** whether the tree was dirty; required when version >= RECORD_VERSION, absent on legacy records */
    dirty?: boolean;
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
type FieldType =
    | "string"
    | "string-or-null"
    | "boolean"
    | "number"
    | "number-or-null"
    | "string[]"
    | "object";

const TYPE_DESCRIPTIONS: Record<FieldType, string> = {
    string: "a string",
    "string-or-null": "a string or null",
    boolean: "a boolean",
    number: "a finite number",
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
        case "number":
            return typeof value === "number" && Number.isFinite(value);
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

/** fields required when version >= RECORD_VERSION; absent on legacy (pre-version) records.
 * The new fields arrive behind a record version, never as a defaulted field — `parseHistory`
 * fails loud on a versioned record missing one of these, and the 227 existing legacy records
 * keep feeding durations while feeding no roster entry. */
export const VERSIONED_FIELDS = [
    { name: "branch", type: "string-or-null" as const },
    { name: "dirty", type: "boolean" as const },
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
 *
 * `label` names the file in every diagnostic. The CLI reads an arbitrary path (`process.argv[2]`),
 * so a message hardcoding the default filename would send a reader at the wrong file exactly when
 * the reader is being witnessed against a scratch history.
 * @example parseHistory(readFileSync(HISTORY, "utf8"))
 */
export function parseHistory(text: string, label: string = "runs.jsonl"): RunRecord[] {
    const records: RunRecord[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        const where = `${label} line ${i + 1}`;
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
        // version gates the versioned fields: absent = legacy, present = versioned. A versioned
        // record missing `branch` or `dirty` fails loud — the new fields never arrive as defaults.
        if ("version" in raw) {
            if (!matchesType(raw.version, "number"))
                throw new Error(`${where}: "version" is not ${TYPE_DESCRIPTIONS.number}`);
            if ((raw.version as number) >= RECORD_VERSION) {
                for (const field of VERSIONED_FIELDS) {
                    if (!(field.name in raw))
                        throw new Error(`${where}: missing field "${field.name}"`);
                    if (!matchesType(raw[field.name], field.type))
                        throw new Error(
                            `${where}: "${field.name}" is not ${TYPE_DESCRIPTIONS[field.type]}`,
                        );
                }
            }
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
 * shares, and this append takes no lock. What makes that safe is the GPU bridge being one
 * machine-level seat (`kex2d-harness.md`), so captures on this host never overlap at all — NOT
 * merely one capture per port, which permits a second session on another port and would put
 * two sanctioned writers on this one file. Neither is enforced here. `appendFileSync` racing a
 * second concurrent writer would interleave two partial lines, and `parseHistory` throws loud on
 * the resulting malformed line for every consumer, not just the racing pair. Do not add a lock
 * here or make the reader skip malformed lines; the loud throw is correct, and the fix for a torn
 * write is to hold the seat premise, not to paper over its violation.
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
    /** failing titles by the distinct branch-slug prefixes they were recorded on, most-recurrent first.
     * Only versioned, non-dirty records populate the roster — legacy and dirty-tree records are
     * excluded, so a run on an uncommitted edit enters nothing at all. */
    roster: { title: string; units: string[] }[];
    /** full reds in the roster population whose branch did not resolve (`git rev-parse
     * --abbrev-ref HEAD` returned "HEAD" in a detached state, mapped to null in `capture.ts`)
     * — invisible to the roster's per-branch bucketing, since a null branch slug can never be
     * counted as distinct. Dirty-tree runs and legacy records are deliberately excluded from
     * the roster (an uncommitted edit enters nothing at all; a legacy record feeds no roster
     * entry), so only a versioned, non-dirty red with an unresolvable branch identity is
     * counted. Recorded so an unresolvable branch identity on this seat cannot read as "not
     * yet recurring" forever. */
    unresolvedBranchReds: number;
};

function median(xs: number[]): number {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * extract the test title from a Playwright failed-title line: `[project] › file:line:col › title`.
 * The title is the part after the last ` › ` separator, so the same test recorded under different
 * line numbers (a line-key split) reads as one roster entry. Zero duplicate titles across 79 tests
 * in `harness/*.pw.ts` — the title is a lawful key.
 * @example testTitle("[chromium] › shot.pw.ts:2017:1 › deselect")
 */
export function testTitle(failedTitle: string): string {
    const idx = failedTitle.lastIndexOf(" › ");
    return idx === -1 ? failedTitle : failedTitle.slice(idx + 3);
}

/**
 * extract the branch-slug prefix from a branch name: `kex2d-capture-roster/s1` → `kex2d-capture-roster`.
 * The slug prefix is the unit identifier — the part before the first `/` — so N commits of one
 * in-flight unit count as one occurrence, not N distinct heads. A null or absent branch returns null.
 * @example branchSlug("kex2d-capture-roster/s1")
 */
export function branchSlug(branch: string | null | undefined): string | null {
    if (branch === null || branch === undefined) return null;
    const idx = branch.indexOf("/");
    return idx === -1 ? branch : branch.slice(0, idx);
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

    // roster population: only versioned, non-dirty records. Legacy (pre-version) records and
    // dirty-tree runs are excluded — a run on an uncommitted edit is the author's iteration, not a
    // ship, and enters nothing at all. Legacy records keep feeding the duration windows above.
    const rosterRecords = full.filter(
        (r) => r.version !== undefined && r.version >= RECORD_VERSION && !r.dirty,
    );
    const units = new Map<string, string[]>();
    for (const r of rosterRecords)
        for (const rawTitle of r.failedTitles) {
            const title = testTitle(rawTitle);
            const slug = branchSlug(r.branch);
            const seen = units.get(title) ?? [];
            if (slug !== null && !seen.includes(slug)) seen.push(slug);
            units.set(title, seen);
        }

    return {
        population: full.length,
        red: full.filter((r) => r.exitCode !== 0).length,
        span: full.length === 0 ? null : { since: full[0].at, until: full[full.length - 1].at },
        phases,
        roster: [...units.entries()]
            .map(([title, slugs]) => ({ title, units: slugs }))
            .sort((a, b) => b.units.length - a.units.length),
        // The tripwire's subject: a versioned, non-dirty red whose branch slug is null — the
        // roster cannot bucket it, so it reads as "not yet recurring" forever. Dirty-tree runs
        // are a deliberate exclusion (the Locked decision: an uncommitted edit enters nothing at
        // all), not a broken identity; legacy records are excluded the same way. Only an
        // unresolvable branch identity trips.
        unresolvedBranchReds: rosterRecords.filter(
            (r) => r.exitCode !== 0 && branchSlug(r.branch) === null,
        ).length,
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
        if (entry.units.length >= 2)
            breaches.push(
                `rate: "${entry.title}" reddened on ${entry.units.length} distinct branch units (${entry.units.join(", ")}) — a roster entry is a defect with an owner`,
            );
    if (summary.unresolvedBranchReds > 0)
        breaches.push(
            `branch: ${summary.unresolvedBranchReds} red run(s) recorded with no resolvable branch — cannot join the roster, branch identity is unresolvable on this seat`,
        );
    return breaches;
}

function ms(v: number): string {
    return `${(v / 1000).toFixed(1)}s`;
}

/**
 * The stale-entry removal summons: a declared entry absent from the recent unit-keyed population
 * prints a summons. The summons is a printed message, NOT a tripwire — it does not cause exit 1,
 * because a summons a person has not yet acted on should not block the gate. "Acknowledging" the
 * summons means removing the entry from the declared set; once removed, reading the same fixture
 * again returns no summons (the entry is no longer in the declared set).
 *
 * **Empty-population latch.** The summons is silent until the population can actually support the
 * judgment — the v2 population is empty or tiny today (one baseline run), so firing for every
 * entry would rebuild the very latch this spec exists to remove. The threshold is `WINDOW` recent
 * versioned, non-dirty runs: if fewer than `WINDOW` such runs exist, the population is too small
 * to say an entry has stopped recurring, and the summons stays silent. Deciding field:
 * `version >= RECORD_VERSION && !dirty` — the same filter `summarize` uses for the roster
 * population, so the summons and the roster read the same set.
 *
 * @example removalSummons(parseHistory(text), DECLARED_TITLES)
 */
export function removalSummons(
    records: RunRecord[],
    declaredTitles: ReadonlySet<string>,
): string[] {
    // The roster population: versioned, non-dirty, full default-knob runs. Deciding field:
    // `version >= RECORD_VERSION && !dirty` — the same filter `summarize` uses for the roster.
    const rosterRecords = records.filter(
        (r) =>
            !r.selective &&
            r.defaultKnobs &&
            r.version !== undefined &&
            r.version >= RECORD_VERSION &&
            !r.dirty,
    );
    // Silent until the population can support the judgment. Deciding field: `rosterRecords.length
    // < WINDOW` — the v2 population is empty or tiny today, so firing for every entry would
    // rebuild the very latch this spec exists to remove.
    if (rosterRecords.length < WINDOW) return [];
    const recent = rosterRecords.slice(-WINDOW);
    const recentTitles = new Set<string>();
    for (const r of recent)
        for (const rawTitle of r.failedTitles) recentTitles.add(testTitle(rawTitle));
    const summons: string[] = [];
    for (const title of declaredTitles)
        if (!recentTitles.has(title))
            summons.push(
                `removal: "${title}" has not reddened in the last ${WINDOW} versioned runs — consider removing it from the declared set`,
            );
    return summons;
}

if (import.meta.main) {
    // an explicit path is how this reader is witnessed without writing over the real history
    const path = process.argv[2] ?? HISTORY;
    if (!existsSync(path)) {
        console.log(`no runs recorded yet (${path}) — run \`bun run capture\``);
        process.exit(0);
    }
    const records = parseHistory(readFileSync(path, "utf8"), path);
    const summary = summarize(records);
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
        console.log(`  roster: ${entry.title} — units ${entry.units.join(", ")}`);
    // The stale-entry removal summons: printed, not a tripwire (does not cause exit 1).
    const summons = removalSummons(records, DECLARED_TITLES);
    for (const s of summons) console.log(`SUMMONS ${s}`);
    const breaches = tripwires(summary);
    for (const breach of breaches) console.error(`TRIPWIRE ${breach}`);
    process.exit(breaches.length === 0 ? 0 : 1);
}
