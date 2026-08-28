// The declared set: one entry per tolerated title, each carrying an **owner** and its **first-seen
// evidence**. This is the committed punch list the boolean gate (`verdict()` in `args.ts`) reads:
// a run whose reds are all in this set exits 0 (stamping `reference: false`), and a run with any
// red outside it exits 1 naming that title. The set cannot accumulate — the corpus arm
// (`declaredCorpusViolations`) reds an entry whose owner names nothing live and a title matching
// no test in `stage.files`, and the stale-entry summons (`removalSummons` in `trend.ts`) fires for
// an entry absent from the recent unit-keyed population.
//
// An owner is a roadmap item, a spec slug, or a git-history slug — never a tolerance. Declaring an
// entry with an owner is what clears its alarm; no expiry, no schedule, no clearing ritual — an
// entry moves only on evidence (`kex2d-capture-roster` Locked decision).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** what kind of owner a declared entry carries */
export type OwnerKind = "roadmap" | "spec" | "git-history";

/** who owns a declared red: a roadmap item, a live spec slug, or a closed spec's git-history slug */
export interface DeclaredOwner {
    /**
     * The kind of owner, which decides which liveness check the corpus arm runs:
     * - `roadmap`: `ref` is a substring matched against `roadmap.md`'s text
     * - `spec`: `ref` is a slug matched against `specs/<ref>.md` (the spec must exist)
     * - `git-history`: `ref` is a closed spec's slug matched against `git log -- specs/<ref>.md`
     *   (the spec is deleted, but its slug has git history — never cite a deleted spec as `spec`,
     *   or the corpus arm reds it)
     */
    kind: OwnerKind;
    /** the identifier, interpreted by `kind` above */
    ref: string;
}

/** first-seen evidence: the run that first recorded this red */
export interface DeclaredEvidence {
    /** the `at` timestamp of the first v2 record carrying this title */
    at: string;
    /** the head the red was first seen on */
    head: string;
    /** the branch the red was first seen on */
    branch: string;
}

/** one tolerated title in the declared set */
export interface DeclaredEntry {
    /** the test title — the roster's identity key (not `file:line`) */
    title: string;
    /** who owns this red: a roadmap item, a spec slug, or a git-history slug */
    owner: DeclaredOwner;
    /** first-seen evidence: the run that first recorded this red */
    evidence: DeclaredEvidence;
}

/**
 * The declared set, seeded from the baseline capture run on `kex2d-capture-roster/s2` at `061fdce`
 * (2026-08-28). The baseline run reddened only the S6c2 title (owned by this spec's own S3).
 * The fold-time capture on a clean tree reddened two additional `section.pw.ts` titles — both
 * selection-after-click failures from the band-click defect (`roadmap.md` line 43, "A band click
 * before the RAF flush selects nothing"), which the spec names as their owner. Declaring against
 * an open defect with a named owner is the intended design, not a defect.
 */
export const DECLARED: readonly DeclaredEntry[] = [
    {
        title: "timeline domain flow — Time-view double-click create writes arclength (S6c2)",
        owner: { kind: "spec", ref: "kex2d-capture-roster" },
        evidence: {
            at: "2026-08-28T00:39:15.066Z",
            head: "061fdce",
            branch: "kex2d-capture-roster/s2",
        },
    },
    {
        title: "popup label scrub reaches the strip keyframe and one-shot popovers (S10, F8)",
        owner: {
            kind: "roadmap",
            ref: "A band click before the RAF flush selects nothing",
        },
        evidence: {
            at: "2026-08-28T00:49:18.247Z",
            head: "0ab41a0",
            branch: "kex2d-capture-roster/s2",
        },
    },
    {
        title: "mixed-set drag axis law: horizontal moves all, vertical moves none when the set spans both domains (S5)",
        owner: {
            kind: "roadmap",
            ref: "A band click before the RAF flush selects nothing",
        },
        evidence: {
            at: "2026-08-28T00:49:18.247Z",
            head: "0ab41a0",
            branch: "kex2d-capture-roster/s2",
        },
    },
];

/** the declared titles, for O(1) membership in `verdict()` */
export const DECLARED_TITLES: ReadonlySet<string> = new Set(DECLARED.map((e) => e.title));

/** one departure from the declared set's corpus contract */
export interface DeclaredViolation {
    /** the declared entry's title */
    title: string;
    /** what's wrong */
    reason: string;
}

/**
 * Does this owner name something live? The check is I/O-bearing (reads files, runs `git log`), so
 * the corpus arm calls it with the repo root. Deciding field: `owner.kind` — the kind determines
 * which check runs, and a kind that names a deleted spec as `spec` (rather than `git-history`)
 * reds, which is the hazard the task brief names ("cite it as a git-history slug, never as a live
 * spec path, or your own corpus arm will red it").
 */
function ownerLive(owner: DeclaredOwner, root: string): boolean {
    switch (owner.kind) {
        case "roadmap":
            // Deciding field: `owner.ref` matched as a substring against roadmap.md's text —
            // the roadmap item's own text is the anchor, not a line number (which drifts).
            return readFileSync(join(root, "roadmap.md"), "utf8").includes(owner.ref);
        case "spec":
            // Deciding field: `owner.ref` as a slug — `specs/<ref>.md` must exist. A deleted
            // spec cited as `spec` reds here; cite it as `git-history` instead.
            return existsSync(join(root, "specs", `${owner.ref}.md`));
        case "git-history":
            // Deciding field: `owner.ref` as a slug — `git log -- specs/<ref>.md` must have
            // output. A closed spec's slug survives in git history even after the file is deleted.
            try {
                const result = Bun.spawnSync(
                    [
                        "git",
                        "-C",
                        root,
                        "--no-optional-locks",
                        "log",
                        "--oneline",
                        "--",
                        `specs/${owner.ref}.md`,
                    ],
                    { stdout: "pipe", stderr: "pipe" },
                );
                return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
            } catch {
                return false;
            }
    }
}

/**
 * Extract every test title from the staged `*.pw.ts` flow files. The staged set is `capture.ts`'s
 * `stage.files` list (a list, not a glob — `kex2d-harness.md` Verifier integrity). Deciding field:
 * the title string, extracted from each `test("…")` / `test.fail("…")` call by this function's own
 * source regex — the roster's identity key, not `file:line`. This is the *same* key `testTitle`
 * yields, reached by a different extractor: `testTitle` parses a Playwright failed-title line
 * (`[project] › file:line › title`) at read time, while this parses the flow source, so neither
 * calls the other and the two must keep agreeing on the key for the corpus arm to mean anything.
 */
function stagedTitles(root: string): Set<string> {
    const harnessDir = join(root, "kexedit", "kex2d", "harness");
    const capture = readFileSync(join(harnessDir, "capture.ts"), "utf8");
    const start = capture.indexOf("files: [");
    const end = capture.indexOf("]", start);
    if (start < 0 || end < 0) return new Set();
    const files = [...capture.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const titles = new Set<string>();
    // `test("…"` and `test.fail("…"` — both are tests in the staged set. A `test.fail` is expected
    // to fail (the boot pageerror gate pin), so it is a real test whose title the declared set may
    // name.
    const titleRe = /test(?:\.fail)?\(\s*"([^"]+)"/g;
    for (const name of files) {
        if (!name.endsWith(".pw.ts")) continue;
        const text = readFileSync(join(harnessDir, name), "utf8");
        let m: RegExpExecArray | null;
        while ((m = titleRe.exec(text))) titles.add(m[1]);
    }
    return titles;
}

/**
 * Check the declared set against the live corpus, on `blockedOnCorpusViolations`'s shape: a
 * function that takes the repo root and returns an array of violations. Two checks:
 *
 * 1. **Owner liveness** — an entry whose owner names no live roadmap item, no spec, and no
 *    git-history slug reds. Deciding field: `owner.kind` (see `ownerLive`).
 * 2. **Title matching** — a declared title matching no test in `stage.files` reds. Deciding field:
 *    the title string — the same key the roster uses, not `file:line`.
 *
 * `entries` defaults to the live `DECLARED` set; the corpus arm's tests pass fixture entries to
 * exercise the violation paths without mutating the committed set.
 */
export function declaredCorpusViolations(
    root: string,
    entries: readonly DeclaredEntry[] = DECLARED,
): DeclaredViolation[] {
    const violations: DeclaredViolation[] = [];
    const titles = stagedTitles(root);
    for (const entry of entries) {
        if (!ownerLive(entry.owner, root))
            violations.push({
                title: entry.title,
                reason: `owner ${entry.owner.kind}:${entry.owner.ref} names nothing live`,
            });
        if (!titles.has(entry.title))
            violations.push({
                title: entry.title,
                reason: "declared title matches no test in stage.files",
            });
    }
    return violations;
}
