import { State } from "@dylanebert/shallot";
import { loadDocument } from "../src/doc";
import { resolveStep } from "../src/profile";
import {
    allStrips,
    bakeOut,
    BakeSystem,
    entrySpeed,
    samples,
    SectionKind,
    sections,
    sectionWindows,
    stripKeyframes,
    stripsForStep,
    Track,
    trackEntity,
} from "../src/track";

const FIXTURE_DIR = new URL("./fixtures/velocity/", import.meta.url);
export const VELOCITY_GOLDEN_PATH = new URL("./fixtures/velocity-golden.json", import.meta.url);

function values(a: ArrayLike<number>, length: number): number[] {
    return Array.from(a).slice(0, length);
}

function timeAt(
    distance: number,
    ds: ArrayLike<number>,
    t: ArrayLike<number>,
    edges: number,
): number {
    let s = 0;
    for (let i = 0; i < edges; i++) {
        const next = s + ds[i];
        if (distance <= next) {
            const u = ds[i] === 0 ? 0 : (distance - s) / ds[i];
            return t[i] + u * (t[i + 1] - t[i]);
        }
        s = next;
    }
    return t[edges];
}

/** Capture only public, live velocity evaluator products. Each call owns one fresh State so
 * module-level bake storage is consumed before the next fixture resets the entity id space. */
export async function captureVelocityFixture(path: string): Promise<Record<string, unknown>> {
    const state = new State();
    state.addSystem(BakeSystem);
    loadDocument(state, await Bun.file(path).text());
    state.step(0);

    const eid = trackEntity(state);
    if (eid === null) throw new Error(`${path}: no track`);
    const count = Track.count.get(eid);
    const edgeCount = Math.max(0, count - 1);
    const sample = samples.get(eid);
    const baked = bakeOut.get(eid);
    if (!sample || !baked) throw new Error(`${path}: no bake`);

    const strips = allStrips(state);
    const stations = strips.flatMap((strip) => [
        { kind: "start", strip: strip.id, distance: strip.start },
        ...stripKeyframes(state, strip.id).map((keyframe) => ({
            kind: "keyframe",
            strip: strip.id,
            id: keyframe.id,
            distance: keyframe.s,
        })),
        { kind: "end", strip: strip.id, distance: strip.end },
    ]);
    const windows = sectionWindows(state);

    return {
        samples: {
            count,
            posX: values(sample.posX, count),
            posY: values(sample.posY, count),
            theta: values(sample.theta, count),
        },
        bakeOut: {
            fN: values(baked.fN, edgeCount),
            ds: values(baked.ds, edgeCount),
            v: values(baked.v, count),
            t: values(baked.t, count),
            tTotal: baked.tTotal,
            feasible: values(baked.feasible, count),
            firstInfeasible: baked.firstInfeasible,
        },
        playbackStations: stations.map((station) => ({
            ...station,
            playback: timeAt(station.distance, baked.ds, baked.t, edgeCount),
        })),
        entrySpeed: entrySpeed(state),
        stripsForStep: sections(state)
            .filter((section) => section.kind === SectionKind.Force)
            .map((section) => {
                const window = windows.find((candidate) => candidate.id === section.id);
                if (!window) throw new Error(`${path}: no window for force run ${section.id}`);
                const specs = stripsForStep(
                    state,
                    window.offset,
                    resolveStep(window.len, Track.ds.get(eid)),
                );
                return {
                    section: section.id,
                    offset: window.offset,
                    specs: specs?.map((spec) => ({
                        start: spec.start,
                        end: spec.end,
                        value: spec.value,
                        values: spec.values ? Array.from(spec.values) : undefined,
                    })),
                };
            }),
    };
}

export async function mintVelocityGolden(): Promise<Record<string, unknown>> {
    const glob = new Bun.Glob("*.kex");
    const golden: Record<string, unknown> = {};
    for await (const name of glob.scan({ cwd: FIXTURE_DIR.pathname }))
        golden[name] = await captureVelocityFixture(new URL(name, FIXTURE_DIR).pathname);
    return golden;
}

if (import.meta.main) {
    const golden = await mintVelocityGolden();
    await Bun.write(VELOCITY_GOLDEN_PATH, `${JSON.stringify(golden, null, 4)}\n`);
    console.log(`minted velocity-golden.json (${Object.keys(golden).length} cases)`);
}
