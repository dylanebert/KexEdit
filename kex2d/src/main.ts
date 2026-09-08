import { run } from "@dylanebert/shallot";
import { ProfilePlugin } from "@dylanebert/shallot/extras";
import { mount, unmount } from "svelte";
import App from "./App.svelte";
import { cartArc, cartState, CartPlugin } from "./cart";
import { applyOp, type Op } from "./commands";
import { loadDocument, saveDocument } from "./doc";
import { activeKind, selectionHook } from "./editor";
import { history, setSelectionHook } from "./history";
import { RenderPlugin } from "./render";
import { loadSnapSteps } from "./settings";
import {
    bakeOut,
    entrySpeed,
    lanesOf,
    runInfo,
    runsOf,
    samples,
    setV0,
    Track,
    TrackPlugin,
    trackEndOf,
} from "./track";
import { camera, Canvas2D, snapGuides, viewTransform } from "./view";

/** the dev boot track, as ops: a 20 m pitch rise, a force span carrying its tail past it, a
 *  velocity prescription over the head, and the end left following the longest lane. */
const BOOT_OPS: Op[] = [
    { type: "start-speed", value: 16 },
    { type: "record-add", lane: "geo", start: 0, end: 20, ease: 1, entry: 0, exit: 0.35 },
    { type: "record-add", lane: "force", start: 14, end: 54, ease: 0, entry: 1, exit: 2.5 },
    { type: "record-add", lane: "velocity", start: 4, end: 14, ease: 1, entry: 18, exit: 24 },
];

const { state: ecs, dispose } = await run({
    plugins: [ProfilePlugin, TrackPlugin, CartPlugin, RenderPlugin],
    defaults: false,
});

// wire the editor's selection snapshot into the history stack (the injected hook — history stores the
// snapshot opaquely and never imports editor). undo restores each command's pre-selection, redo its post.
setSelectionHook(selectionHook);

// pull the persisted per-user preferences (the manipulator snap quanta) into their live singleton
// before anything reads them — a stored value only ever resolves through the clamps.
loadSnapSteps();

// DEV-only harness inspection hook: the capture flow's geo-authoring assertions read
// node/undo/track state through this and drive the real UI (extend, drag, undo).
// Never ships — kex2d is a `defaults:false` prototype with no production build path.
// See harness/flow.ts (the `Kex` mirror of this hook) and the `*.pw.ts` flows beside it.
// DEV-only boot fixture: the app's own document is created empty (`createTrack`), and until a
// file surface exists there is nothing for the timeline to show. So a dev boot authors ONE mixed
// track through the command layer — the same `applyOp` vocabulary the CLI drives, so this is not
// a second authoring path — with a geo span, a force span overlapping its tail, a velocity span
// over the head, and a following end. It is the S4 mixed track, and the surface the person's
// check-in reads. Never ships: `defaults:false` prototype, DEV branch only.
if (import.meta.env.DEV) {
    for (const eid of ecs.query([Track])) {
        for (const op of BOOT_OPS) applyOp(ecs, history, op);
        void eid;
        break;
    }
    // the fixture is the document's starting state, not an edit: undo has nothing before it.
    history.undo.length = 0;
    history.redo.length = 0;
}

if (import.meta.env.DEV) {
    let track = -1;
    for (const eid of ecs.query([Track])) {
        track = eid;
        break;
    }
    (window as unknown as { __kex: unknown }).__kex = {
        track,
        undoDepth: (): number => history.undo.length,
        tTotal: (): number => bakeOut.get(track)?.tTotal ?? 0,
        // the whole viewport camera — `[zoom, ox, oy]`, view state, never authored, so it is
        // read-only. All three, not just the scale: one wheel tick writes the origin too.
        cam: (): [number, number, number] => [camera.zoom, camera.ox, camera.oy],
        // `view.ts snapGuides` — whether the incline ray is being drawn, plus the two readout
        // labels a drag publishes. Read-only, like `cam`.
        guides: (): { ray: boolean; angle: string | null; length: string | null } => ({
            ray: snapGuides.ray !== null,
            angle: snapGuides.angleLabel,
            length: snapGuides.lengthLabel,
        }),
        // the authored start speed, and the direct write the domain flow needs as SETUP (at
        // exactly `V0` metres and seconds are proportional by one constant, so the two units are
        // indistinguishable).
        v0: (): number => entrySpeed(ecs),
        setV0: (v: number): void => {
            setV0(ecs, v);
        },
        // v0's two dissipation-coefficient siblings — the refusal flow asserts a refused typed
        // commit leaves the model untouched (read-only, like `v0`).
        friction: (): number => Track.friction.get(track),
        resistance: (): number => Track.resistance.get(track),
        // the authored lanes and the resolved track end — the S2e-i store, read back whole.
        lanes: () => lanesOf(ecs),
        end: (): number => trackEndOf(ecs),
        // the derived run partition: kind and extent per run, in chain order.
        runs: (): { id: number; kind: number; start: number; length: number }[] =>
            runsOf(ecs).map((r) => ({ id: r.id, kind: r.kind, start: r.start, length: r.length })),
        // the active selection member's kind, or null when nothing is selected.
        activeKind: (): string | null => activeKind(),
        // the START diamond's screen point (canvas-local px) — sample 0, the world origin.
        startAt: (): { x: number; y: number } | null => {
            const s = samples.get(track);
            const canvas = Canvas2D.element;
            if (!s || !canvas) return null;
            const tx = viewTransform(canvas);
            return { x: tx.ox + s.posX[0] * tx.sx, y: tx.oy + s.posY[0] * tx.sy };
        },
        // the bake's own infeasibility signal — the first infeasible sample, how many samples
        // are infeasible track-wide, the derived run that OWNS the first one, and that run's
        // feasible head. A boundary sample resolves UPSTREAM, the convention `toLocal` uses.
        infeasibleSpan: (): {
            first: number;
            count: number;
            section: number | null;
            head: number;
        } => {
            const out = bakeOut.get(track);
            if (!out) return { first: -1, count: 0, section: null, head: 0 };
            const n = Track.count.get(track);
            let count = 0;
            for (let i = 0; i < n; i++) if (out.feasible[i] === 0) count++;
            const first = out.firstInfeasible;
            let section: number | null = null;
            let head = 0;
            if (first >= 0)
                for (const run of runsOf(ecs)) {
                    const info = runInfo.get(run.id);
                    if (info && first >= info.startSample && first <= info.endSample) {
                        section = run.id;
                        head = first - info.startSample;
                        break;
                    }
                }
            return { first, count, section, head };
        },
        // the parked/parking playhead's arclength on the bake.
        cartArc: (): number | null => cartArc(track),
        parked: (): boolean => cartState.get(track)?.held ?? false,
        // the document boundary (`doc.ts`) — the capture harness's own save/load round-trip
        // assert. `load` throws on a rejected document and leaves the live document untouched.
        save: (): string => saveDocument(ecs),
        load: (text: string): void => loadDocument(ecs, text),
    };
}

function onKey(e: KeyboardEvent): void {
    if (e.key === "F3") {
        e.preventDefault();
        document.body.toggleAttribute("data-shallot-debug");
    }
}
window.addEventListener("keydown", onKey);

const target = document.getElementById("app") as HTMLDivElement;
const app = mount(App, { target, props: { ecs } });

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        window.removeEventListener("keydown", onKey);
        unmount(app);
        dispose();
    });
}
