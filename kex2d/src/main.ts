import { run } from "@dylanebert/shallot";
import { ProfilePlugin } from "@dylanebert/shallot/extras";
import { mount, unmount } from "svelte";
import App from "./App.svelte";
import { CartPlugin } from "./cart";
import { select } from "./editor";
import { convertTrack, createForce, history } from "./history";
import { RenderPlugin } from "./render";
import {
    addNode,
    bakeOut,
    forcePoints,
    Handle,
    handleAt,
    lastHandle,
    sortedHandles,
    Track,
    TrackKind,
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
    (window as unknown as { __kex: unknown }).__kex = {
        track,
        nodeCount: (): number => sortedHandles(ecs).length,
        undoDepth: (): number => history.undo.length,
        tTotal: (): number => bakeOut.get(track)?.tTotal ?? 0,
        // whole-chain pose signature — the flow asserts an undo reverts geometry.
        poses: (): number[][] =>
            sortedHandles(ecs).map((eid) => [
                Handle.pos.x.get(eid),
                Handle.pos.y.get(eid),
                Handle.theta.get(eid),
            ]),
        // select the chain end so the keyboard extend/trim (controls.ts) fire.
        selectEnd: (): void => select(lastHandle(ecs)),
        // move a node in y — the "drag a node, the curve reacts" step, without pixels.
        nudge: (order: number, dy: number): void => {
            const eid = handleAt(ecs, order);
            if (eid !== null)
                Handle.pos.set(eid, Handle.pos.x.get(eid), Handle.pos.y.get(eid) + dy);
        },
        // lay a gentle airtime hill (scaled to V0) so the flow starts from a shaped
        // track rather than the flat seed.
        seedHill: (): void => {
            for (const eid of [...ecs.query([Handle])]) ecs.destroy(eid);
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
                addNode(ecs, x * s, y * s);
        },
        // ── force-authoring hooks (stage C) ──
        kind: (): number => Track.kind.get(track),
        forceCount: (): number => forcePoints(ecs).length,
        // flip geo↔force (destructive convert, one undo entry).
        convert: (): void => convertTrack(history, ecs, track),
        // author a force point at (s, g) — the "place a point on the curve" step.
        placeForce: (s: number, g: number): number => createForce(history, ecs, s, g),
        // lay an airtime bump in force mode: dip below 1g mid-track, back to 1g.
        seedForceBump: (): void => {
            if (Track.kind.get(track) === TrackKind.Geo) convertTrack(history, ecs, track);
            const len = Track.length.get(track);
            createForce(history, ecs, len * 0.2, 1);
            createForce(history, ecs, len * 0.5, 0); // airtime crest
            createForce(history, ecs, len * 0.8, 1);
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
