import { State } from "@dylanebert/shallot";
import { loadDocument } from "../src/doc";
import { forceProfile, resolveStep, type ForcePoint } from "../src/profile";
import {
    bakeOut,
    BakeSystem,
    sectionForces,
    sectionInfo,
    sectionSpans,
    sectionWindows,
    sections,
    samples,
    SectionKind,
    Track,
    trackEntity,
} from "../src/track";

const FIXTURE_DIR = new URL("./fixtures/force/", import.meta.url);
export const FORCE_GOLDEN_PATH = new URL("./fixtures/force-golden.json", import.meta.url);

type V2Point = { id: number; s: number; g: number; ease: number };
type V2Section = { id: number; kind: number; length: number; points: V2Point[] };
type V2Document = { track: { ds: number }; sections: V2Section[] };

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

/** Capture only public, live evaluator products. This function intentionally works at both
 * e27294a (the mint reference) and the ownership tree (the differential subject). */
export async function captureForceFixture(path: string): Promise<Record<string, unknown>> {
    const text = await Bun.file(path).text();
    const v2 = JSON.parse(text) as V2Document;
    const state = new State();
    state.addSystem(BakeSystem);
    loadDocument(state, text);
    state.step(0);

    const eid = trackEntity(state);
    if (eid === null) throw new Error(`${path}: no track`);
    const count = Track.count.get(eid);
    const edgeCount = Math.max(0, count - 1);
    const sample = samples.get(eid);
    const baked = bakeOut.get(eid);
    if (!sample || !baked) throw new Error(`${path}: no bake`);

    const rows = sections(state);
    const spans = sectionSpans(state, eid);
    const windows = sectionWindows(state);
    const stations = rows.flatMap((row) => {
        if (row.kind !== SectionKind.Force) return [];
        const offset = spans.find((span) => span.id === row.id)?.offset ?? 0;
        return sectionForces(state, row.id).map((point) => {
            const distance = offset + point.s;
            return {
                section: row.id,
                id: point.id,
                local: point.s,
                distance,
                playback: timeAt(distance, baked.ds, baked.t, edgeCount),
            };
        });
    });

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
        sectionInfo: rows.map((row) => ({ id: row.id, ...sectionInfo.get(row.id) })),
        windows: windows.map((window) => ({
            id: window.id,
            offset: window.offset,
            edges: window.edges,
            len: window.len,
            ds: values(window.ds, window.edges),
        })),
        spans,
        forceStations: stations.map(({ playback: _, ...station }) => station),
        playbackStations: stations.map(({ section, id, playback }) => ({ section, id, playback })),
        pureProfiles: v2.sections
            .filter((section) => section.kind === SectionKind.Force)
            .map((section) => ({
                id: section.id,
                dense: values(
                    forceProfile(
                        section.points as ForcePoint[],
                        resolveStep(section.length, v2.track.ds),
                    ),
                    resolveStep(section.length, v2.track.ds).edges,
                ),
            })),
    };
}

export async function mintForceGolden(): Promise<Record<string, unknown>> {
    const glob = new Bun.Glob("*.kex");
    const golden: Record<string, unknown> = {};
    for await (const name of glob.scan({ cwd: FIXTURE_DIR.pathname }))
        golden[name] = await captureForceFixture(new URL(name, FIXTURE_DIR).pathname);
    return golden;
}

if (import.meta.main) {
    const golden = await mintForceGolden();
    await Bun.write(FORCE_GOLDEN_PATH, `${JSON.stringify(golden, null, 4)}\n`);
    console.log(`minted force-golden.json (${Object.keys(golden).length} cases)`);
}
