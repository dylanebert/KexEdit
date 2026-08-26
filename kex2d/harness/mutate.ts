// kex2d's S1 mutation gate — the committed instrument that makes the gate exhaustive
// rather than sampled. One (production strip-branch mutation, capture arm) pair per named
// behavior: snap, deselect, modifier-extend, overlap refusal, nudge, plus S5's own addition
// (F1: body-drag-carries-keyframes — a genuinely NEW production branch in the same shared
// drag handler, not an S1 substrate behavior; F2's clamp DELETION carries no new branch to
// pair, and its own arms (`force.pw.ts`, `section.pw.ts`) already record a manually witnessed
// red-first mutation in their own docblocks, verified by this stage's executor). For each pair,
// the gate
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
// (S5 note: adding "body-drag-carries-keyframes" widens the roster past S1's original five —
// see the header comment above for why that one item and no other from F1/F2 belongs here.)
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
}

// The enumerated source of truth — INDEPENDENT of `PAIRS` below. This is what makes a behavior
// deleted from `PAIRS` a red of the gate itself rather than silent: a roster entry with no pair
// (checked at startup) and a pair naming no roster member are both refused, so `PAIRS` can
// neither drop a name nor drift onto one the roster doesn't recognize without the gate itself
// going red. Sourced from S1's own Validation bullet (`kex2d-event-substrate.md`), which names
// these five and no others as the substrate's shared-path behaviors. "body-drag-carries-
// keyframes" (S5, F1) extends the roster: `bandMove`'s body branch is a new production strip
// branch in the same file this gate mutates, sourced from S5's own Validation bullet.
// "segment-resize-snap" and "strip-resize-snap" (S6, F4) extend it again: `applyLen` and
// `bandMove` each grew a NEW call into the shared `snapAxis` resolver (grid quantum + landmark
// snap for the extent trim and the strip move/resize, mirroring the keyframe drag's own call)
// — two distinct production lines in the same file, each its own pair, sourced from S6's own
// Validation bullet.
const BEHAVIORS = [
    "snap",
    "deselect",
    "modifier-extend",
    "overlap refusal",
    "nudge",
    "body-drag-carries-keyframes",
    "segment-resize-snap",
    "strip-resize-snap",
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
                old: "    const capped = Math.max(0, cap - OVERLAP_CAP_EPS); // hold STRICTLY short of the room\n    const dsWrite = dir > 0 ? Math.min(ds, capped) : Math.max(ds, -capped);",
                new: "    const dsWrite = ds; // MUTATED: Δd cap disabled — the raw delta lands unbounded",
            },
        ],
    },
    {
        name: "nudge",
        flow: "strip keyframe arrow-nudge",
        mutations: [
            {
                old: "                const members = stripKeyframes(ecs, editor.strip).filter((k) =>\n                    editor.stripKfs.ids.has(k.id),\n                );",
                new: "                const members: ReturnType<typeof stripKeyframes> = []; // MUTATED: nudge branch disabled",
            },
        ],
    },
    {
        name: "body-drag-carries-keyframes",
        flow: "strip body drag carries its keyframes",
        mutations: [
            {
                old: "        const dd = ns - origStart;\n        for (const k of kfs) setStripKeyframe(ecs, k.id, k.s + dd, k.v);",
                new: "        // MUTATED: body-drag keyframe carry deleted (F1)",
            },
        ],
    },
    {
        name: "segment-resize-snap",
        flow: "segment and strip resize snap to grid increments (F4)",
        mutations: [
            {
                old: "    const r = snapAxis(active, rawPx, rawU, targets, GRID, (px) => pxToU(cv, px), null);",
                new: "    const r = { value: rawU, guide: null }; // MUTATED: segment resize snap call removed (F4)",
            },
        ],
    },
    {
        name: "strip-resize-snap",
        flow: "segment and strip resize snap to grid increments (F4)",
        mutations: [
            {
                old: "    const r = snapAxis(\n        active,\n        uToPx(clamped, candidateU),\n        candidateU,\n        targets,\n        GRID,\n        (p) => pxToU(clamped, p),\n        null,\n    );",
                new: "    const r = { value: candidateU, guide: null }; // MUTATED: strip resize snap call removed (F4)",
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

function runCapture(flow: string): { exitCode: number; stdout: string } {
    const env = { ...process.env, KEX_WORKERS: "1" };
    const result = spawnSync("bun", ["run", "capture", "--", "-g", flow], {
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
            const result = runCapture(p.flow);
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
