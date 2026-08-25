// kex2d's S1 mutation gate — the committed instrument that makes the gate exhaustive
// rather than sampled. One (production strip-branch mutation, capture arm) pair per named
// behavior: snap, deselect, modifier-extend, overlap refusal, nudge, keyframe-visibility. For each pair, the gate
// derives a mutated Timeline.svelte from a FRESH snapshot written at run start into a run-unique
// directory, runs ONLY that pair's capture flow (`bun run capture -- -g "<flow title>"`), records
// the verdict, and restores the snapshot in a `finally`. At the end it asserts the tracked tree
// is byte-identical to HEAD.
//
// A named behavior carrying no pairing is a RED OF THE GATE ITSELF — that refusal is what makes
// the gate exhaustive rather than sampled, and it is the property no sample arm can have. The
// roster of named behaviors (`BEHAVIORS`, below) is declared INDEPENDENTLY of `PAIRS` — a
// behavior deleted from `PAIRS` alone reads as absence from inside that same table, which is
// exactly the silent shape this instrument exists to close, so the startup check reads BOTH
// against the roster: every roster name has a pair, and every pair names a roster member.
//
// The arm of each pair is a capture flow (a `.pw.ts` test), and its red-first witness comes
// from deleting the HANDLER's strip branch — never from mutating a shared helper, and never a
// compile/type red. `bun test` reaches no harness file, so this gate is wired as a package
// script (`bun run mutate`) rather than a `bun test` entry point.
//
// Usage: bun run mutate
//
// Hazards this gate handles:
//  - The snapshot is held OUTSIDE the tree (a run-unique /tmp directory), so no intermediate
//    state can be lost.
//  - A dirty `src/Timeline.svelte` at run start REFUSES the run — an uncommitted edit the gate
//    would clobber is never silently overwritten.
//  - The snapshot is always a FRESH copy written at run start into a run-unique directory, and
//    that directory is removed when the run ends — a stale cache from an earlier session can
//    never overwrite a later edit.
//  - The tracked file is restored in a `finally`, so a crash mid-mutation never leaves the tree
//    dirty.
//  - The final assertion checks byte-identity against the snapshot AND `git status` — the
//    prototype's own law, kept.
//  - `KEX_WORKERS=1` (capture is display-gated and runs one-at-a-time).
//  - `geo.pw.ts:61` is a `test.fail()` pin — Playwright prints its per-test line with the ✘
//    mark on a GREEN run. This gate filters to one flow per mutation (`-g "<title>"`), so the
//    pin is never collected; but the tally (tally.ts) must exclude it when scraping ✘ lines.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const harnessDir = import.meta.dir;
const projectDir = join(harnessDir, "..");
const tgt = join(projectDir, "src/Timeline.svelte");

interface Pair {
    name: string;
    flow: string; // the -g pattern (flow title) for `bun run capture`
    mutations: { old: string; new: string }[]; // string replacements in Timeline.svelte
    repeatEach?: number; // --repeat-each=N for intermittent-failure arms (default 1)
}

// The enumerated source of truth — INDEPENDENT of `PAIRS` below. This is what makes a behavior
// deleted from `PAIRS` a red of the gate itself rather than silent: a roster entry with no pair
// (checked at startup) and a pair naming no roster member are both refused, so `PAIRS` can
// neither drop a name nor drift onto one the roster doesn't recognize without the gate itself
// going red. Sourced from S1's own Validation bullet (`kex2d-event-substrate.md`), which names
// five shared-path behaviors; the sixth ("keyframe-visibility") is the $derived-staleness
// defect this gate's roster was extended to cover — a capture flow that creates a strip
// keyframe and immediately reads its pixel position can do so before a RAF frame advances
// `void tick`, so the `stripKfPts` $derived is stale and the keyframe is absent from the probe.
const BEHAVIORS = [
    "snap",
    "deselect",
    "modifier-extend",
    "overlap refusal",
    "nudge",
    "keyframe-visibility",
] as const;

const PAIRS: Pair[] = [
    {
        name: "snap",
        flow: "strip keyframe snap landing",
        mutations: [
            {
                old: "            : stripKfSTargets({ exclude: dragKfMemberSet, sameStrip: dragKfStrip, playhead: true, trackEnd: true });",
                new: "            : []; // MUTATED: strip s-axis snap targets killed",
            },
            {
                old: '        const targets = kind === "force" ? gTargets(dragKfMemberSet) : vTargets(dragKfMemberSet);',
                new: '        const targets = kind === "force" ? gTargets(dragKfMemberSet) : []; // MUTATED: strip v-axis snap targets killed',
            },
        ],
    },
    {
        name: "deselect",
        flow: "strip keyframe deselect on empty chart click",
        mutations: [
            {
                old: "            selectStripKf(null); // also clear the strip-keyframe sub-selection (S1: the broken",
                new: "            // MUTATED: marqueeUp strip-keyframe deselect branch deleted",
            },
        ],
    },
    {
        name: "modifier-extend",
        flow: "strip keyframe multi-member drag",
        mutations: [
            {
                old: "        const members = set.size > 1 ? stripKfPts.filter((sp) => set.has(sp.id)) : [k];",
                new: "        const members = [k]; // MUTATED: multi-member drag set collapsed to the clicked one",
            },
        ],
    },
    {
        name: "overlap refusal",
        flow: "strip keyframe overlap refusal",
        mutations: [
            {
                old: '    const landed = dragKfMembers.every(\n        (m) => !keyframeTaken(ecs, kind, kind === "force" ? m.section : owner, clamp(m.s0 + ds, m.lo, m.len), m.id),\n    );',
                new: "    const landed = true; // MUTATED: overlap refusal disabled",
            },
        ],
    },
    {
        name: "nudge",
        flow: "strip keyframe arrow-nudge",
        mutations: [
            {
                old: "                const members = stripKfPts.filter((k) => editor.stripKfs.ids.has(k.id));",
                new: "                const members = stripKfPts.filter(() => false); // MUTATED: nudge branch disabled",
            },
        ],
    },
    {
        name: "keyframe-visibility",
        flow: "one selection model — the S4 transition table",
        repeatEach: 40,
        mutations: [
            {
                old: `                const out: { id: number; x: number; y: number }[] = [];
                for (const s of bandStrips) {
                    for (const k of stripKeyframes(ecs, s.id)) {
                        const d = toGlobal(spans, s.section, k.s);
                        const u = d === null ? s.startU : uOfLen(d);
                        out.push({
                            id: k.id,
                            x: rect.left + uPx(u),
                            y: rect.top + vOf(k.v),
                        });
                    }
                }
                return out;`,
                new: `                return stripKfPts.map((k) => ({ // MUTATED: stripKfPx reads stale $derived
                    id: k.id,
                    x: rect.left + uPx(k.u),
                    y: rect.top + vOf(k.v),
                }));`,
            },
        ],
    },
];

function applyMutations(pristine: string, mutations: { old: string; new: string }[]): string {
    let text = pristine;
    for (const m of mutations) {
        const count = text.split(m.old).length - 1;
        if (count !== 1) {
            throw new Error(
                `mutation anchor not unique (found ${count}): ${m.old.slice(0, 60)}...`,
            );
        }
        text = text.replace(m.old, m.new);
    }
    return text;
}

function runCapture(flow: string, repeatEach?: number): { exitCode: number; stdout: string } {
    const env = { ...process.env, KEX_WORKERS: "1" };
    const args = ["run", "capture", "--", "-g", flow];
    if (repeatEach && repeatEach > 1) args.push("--repeat-each", String(repeatEach));
    const result = spawnSync("bun", args, {
        cwd: projectDir,
        env,
        encoding: "utf8",
        timeout: 900_000,
    });
    return {
        exitCode: result.status ?? 1,
        stdout: (result.stdout ?? "") + (result.stderr ?? ""),
    };
}

// ── startup: refuse a behavior with no pairing, and a pairing naming no behavior ───────────────
// Both directions read against BEHAVIORS, never against PAIRS itself — a behavior silently
// DELETED from PAIRS must still be caught, which checking PAIRS alone can never do (its own
// absence and its own silence read the same from inside the table that dropped it).
for (const name of BEHAVIORS) {
    const p = PAIRS.find((p) => p.name === name);
    if (!p?.flow || p.flow.length === 0) {
        console.error(
            `RED OF THE GATE: behavior "${name}" has no paired arm — a named behavior carrying no pairing is a red of the gate itself.`,
        );
        process.exit(1);
    }
}
for (const p of PAIRS) {
    if (!(BEHAVIORS as readonly string[]).includes(p.name)) {
        console.error(
            `RED OF THE GATE: pair "${p.name}" names no member of the enumerated roster (BEHAVIORS) — a pair naming no behavior is a red of the gate itself.`,
        );
        process.exit(1);
    }
}

// ── startup: refuse to run over a dirty target ────────────────────────────────────────────────
// A dirty `src/Timeline.svelte` is an uncommitted edit the gate would clobber when it writes the
// mutated copy and restores from the snapshot — a destructive write no gate can see. Refuse to
// run rather than silently overwrite it.
const targetDirt = spawnSync("git", ["status", "--porcelain", "src/Timeline.svelte"], {
    cwd: projectDir,
    encoding: "utf8",
}).stdout.trim();
if (targetDirt !== "") {
    console.error(
        `REFUSED: src/Timeline.svelte is dirty (${JSON.stringify(targetDirt)}) — an uncommitted edit the gate would clobber. Commit or revert it before running the mutation gate.`,
    );
    process.exit(1);
}

// ── snapshot: a FRESH copy per run, in a run-unique directory ─────────────────────────────────
// Never reuse an earlier run's snapshot — a stale cache from a prior session silently overwrote
// an uncommitted edit in this round. Always write a FRESH snapshot of the current file at run
// start into a run-unique directory, and remove that directory when the run ends (a `finally`, so
// a crash still cleans it up).
const runDir = mkdtempSync(join(tmpdir(), "kex2d-s1r3-"));
const pristinePath = join(runDir, "Timeline.pristine.svelte");
writeFileSync(pristinePath, readFileSync(tgt, "utf8"), "utf8");
const pristine = readFileSync(pristinePath, "utf8");

// ── per-pair mutation ───────────────────────────────────────────────────────────
interface Verdict {
    name: string;
    flow: string;
    exitCode: number;
    red: boolean;
}

function runGate(): number {
    const verdicts: Verdict[] = [];

    for (const p of PAIRS) {
        let exitCode = 0;
        try {
            const mutated = applyMutations(pristine, p.mutations);
            writeFileSync(tgt, mutated, "utf8");
            const result = runCapture(p.flow, p.repeatEach);
            exitCode = result.exitCode;
        } finally {
            writeFileSync(tgt, pristine, "utf8");
        }
        const red = exitCode !== 0;
        verdicts.push({ name: p.name, flow: p.flow, exitCode, red });
        console.log(
            `MUTATED ${p.name}: exit=${exitCode} ${red ? "RED (coupled)" : "GREEN — NOT COUPLED"}`,
        );
    }

    // ── restore + assert byte-identical ─────────────────────────────────────────────
    writeFileSync(tgt, pristine, "utf8");

    const cmpOk = spawnSync("cmp", ["-s", tgt, pristinePath]).status === 0;
    const dirt = spawnSync("git", ["status", "--porcelain", "src/Timeline.svelte"], {
        cwd: projectDir,
        encoding: "utf8",
    }).stdout.trim();

    console.log("\n=== mutation gate summary ===");
    for (const v of verdicts) {
        console.log(
            `${v.name.padEnd(20)} exit=${v.exitCode} ${v.red ? "RED (coupled)" : "GREEN — NOT COUPLED"}`,
        );
    }
    console.log(
        `\nrestored byte-identical: ${cmpOk}; git dirt on Timeline.svelte: ${JSON.stringify(dirt)}`,
    );

    const allRed = verdicts.every((v) => v.red);
    if (!allRed) {
        const notRed = verdicts.filter((v) => !v.red).map((v) => v.name);
        console.error(
            `\nGATE FAILED: ${notRed.join(", ")} did not red — the arm is not coupled to the production branch.`,
        );
        return 1;
    }
    if (!cmpOk || dirt !== "") {
        console.error(
            "\nGATE FAILED: tracked tree is not byte-identical to HEAD after restoration.",
        );
        return 1;
    }

    console.log(
        `\nGATE PASSED: all ${verdicts.length} pairs red (coupled), tree restored byte-identical.`,
    );
    return 0;
}

let code: number;
try {
    code = runGate();
} finally {
    rmSync(runDir, { recursive: true, force: true });
}
process.exit(code);
