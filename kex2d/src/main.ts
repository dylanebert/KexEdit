import { run } from "@dylanebert/shallot";
import { ProfilePlugin } from "@dylanebert/shallot/extras";
import { mount, unmount } from "svelte";
import App from "./App.svelte";
import { cartArc, cartState, CartPlugin } from "./cart";
import { editor, select } from "./editor";
import { appendSection, convertSection, createForce, history, removeSection } from "./history";
import { RenderPlugin } from "./render";
import {
    addNode,
    bakeOut,
    Handle,
    handleAt,
    lastHandle,
    SectionKind,
    sectionForces,
    sectionHandles,
    sections,
    Track,
    TrackPlugin,
    V0,
} from "./track";

const { state: ecs, dispose } = await run({
    plugins: [ProfilePlugin, TrackPlugin, CartPlugin, RenderPlugin],
    defaults: false,
});

// DEV-only harness inspection hook: the capture flow's geo-authoring assertions read
// node/undo/track state through this and drive the real UI (extend, drag, undo).
// Never ships — kex2d is a `defaults:false` prototype with no production build path.
// See harness/shot.pw.ts.
if (import.meta.env.DEV) {
    let track = -1;
    for (const eid of ecs.query([Track])) {
        track = eid;
        break;
    }
    // the first (only, in the foundation) section — the surface the flow authors.
    const sec = (): number => sections(ecs)[0]?.id ?? 0;
    (window as unknown as { __kex: unknown }).__kex = {
        track,
        nodeCount: (): number => sectionHandles(ecs, sec()).length,
        undoDepth: (): number => history.undo.length,
        tTotal: (): number => bakeOut.get(track)?.tTotal ?? 0,
        // the authored initial speed — the flow drives the real v0 popover and asserts it.
        v0: (): number => Track.v0.get(track),
        // section-local pose signature — the flow asserts an undo reverts geometry.
        poses: (): number[][] =>
            sectionHandles(ecs, sec()).map((eid) => [
                Handle.pos.x.get(eid),
                Handle.pos.y.get(eid),
                Handle.theta.get(eid),
            ]),
        // select the chain end so the keyboard extend/trim (controls.ts) fire.
        selectEnd: (): void => select(lastHandle(ecs, sec())),
        // move a node in y — the "drag a node, the curve reacts" step, without pixels.
        // node 0 is the pinned entry anchor, so it's never nudged.
        nudge: (order: number, dy: number): void => {
            if (order === 0) return;
            const eid = handleAt(ecs, sec(), order);
            if (eid !== null)
                Handle.pos.set(eid, Handle.pos.x.get(eid), Handle.pos.y.get(eid) + dy);
        },
        // lay a gentle airtime hill (scaled to V0) so the flow starts from a shaped
        // track rather than the flat seed. node 0 stays at the local origin.
        seedHill: (): void => {
            const id = sec();
            for (const eid of sectionHandles(ecs, id)) ecs.destroy(eid);
            const s = (V0 / 22) ** 2;
            for (const [x, y] of [
                [0, 0],
                [20, 0],
                [38, 7],
                [56, 11],
                [74, 7],
                [92, 0],
                [112, 0],
            ])
                addNode(ecs, id, x * s, y * s);
        },
        // ── force-authoring hooks (stage C) ──
        kind: (): number => sections(ecs)[0]?.kind ?? SectionKind.Geo,
        forceCount: (): number => sectionForces(ecs, sec()).length,
        // the authored points, sorted by s — the flow asserts a dblclick create
        // resolves its g ON the profile (not at the cursor's y).
        forces: (): { s: number; g: number }[] =>
            sectionForces(ecs, sec()).map((p) => ({ s: p.s, g: p.g })),
        // flip geo↔force on the section (destructive convert, one undo entry).
        convert: (): void => convertSection(history, ecs, sec()),
        // author a force point at (s, g) — the "place a point on the curve" step.
        placeForce: (s: number, g: number): number => createForce(history, ecs, sec(), s, g),
        // lay an airtime bump in force mode: dip below 1g mid-track, back to 1g.
        seedForceBump: (): void => {
            const id = sec();
            if ((sections(ecs)[0]?.kind ?? SectionKind.Geo) === SectionKind.Geo)
                convertSection(history, ecs, id);
            const len = sections(ecs)[0]?.length ?? 0;
            createForce(history, ecs, id, len * 0.2, 1);
            createForce(history, ecs, id, len * 0.5, 0); // airtime crest
            createForce(history, ecs, id, len * 0.8, 1);
        },
        // ── multi-section hooks — the ops addressed by chain position ──
        sectionCount: (): number => sections(ecs).length,
        sectionKinds: (): number[] => sections(ecs).map((x) => x.kind),
        // ── section-editor reads — the capture flow drives the real clip/flyout/trim/
        // context-menu affordances and asserts the resulting state here. ──
        sectionIds: (): number[] => sections(ecs).map((x) => x.id),
        sectionLengths: (): number[] => sections(ecs).map((x) => x.length),
        sectionForceCounts: (): number[] =>
            sections(ecs).map((x) => sectionForces(ecs, x.id).length),
        selectedSection: (): number | null => editor.section,
        // the parked/parking playhead's arclength on the bake — the flow parks via a
        // real ruler scrub, drags a keyframe, and asserts this held under the re-time.
        cartArc: (): number | null => cartArc(track),
        parked: (): boolean => cartState.get(track)?.held ?? false,
        append: (kind: number): number => appendSection(history, ecs, kind as SectionKind),
        deleteAt: (i: number): boolean => {
            const s = sections(ecs)[i];
            return s ? removeSection(history, ecs, s.id) : false;
        },
        convertAt: (i: number): void => {
            const s = sections(ecs)[i];
            if (s) convertSection(history, ecs, s.id);
        },
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
