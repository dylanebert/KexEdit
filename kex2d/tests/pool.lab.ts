// Pooled-conversion wall time (spec `kex/specs/kex2d-geoforce-perf.md`, stage 4).
//
// Question: what does the worker pool buy over the in-process `refine`, per scenario and in
// aggregate, and how promptly does an abort settle. Same conversions the golden freezes — the
// pooled rows are compared against it, so a row here is a shipping conversion, not a lookalike.
//
// Run: bun tests/pool.lab.ts

import { convert, liveWorkers } from "../src/convert";
import { narrow, refine } from "../src/refine";
import { type Scenario, scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";
import golden from "./fixtures/convert-golden.json";
import { stress } from "./helpers/stress";

const CORES = navigator.hardwareConcurrency;

function setup(scenario: Scenario) {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    return { entry, bake: evalGeo(entry, scenario.nodes, scenario.ds), ds: scenario.ds };
}

/** field-order-independent exact compare — the golden fixture's key order is its own. */
const same = (a: unknown, b: unknown): boolean => {
    const stable = (value: unknown): string =>
        JSON.stringify(value, (_, item) =>
            item && typeof item === "object" && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => (x < y ? -1 : 1)))
                : item,
        );
    return stable(a) === stable(b);
};

async function row(scenario: Scenario, checkGolden: boolean) {
    const { entry, bake, ds } = setup(scenario);

    const syncAt = performance.now();
    const plain = narrow(refine({ bake, entry, ds, playback: false }));
    const syncS = (performance.now() - syncAt) / 1000;

    const poolAt = performance.now();
    const pooled = await convert(bake, entry, ds);
    const poolS = (performance.now() - poolAt) / 1000;

    if (!same(pooled, plain))
        throw new Error(`${scenario.name}: pooled answer differs from the in-process one`);
    if (checkGolden) {
        const want = golden[scenario.name as keyof typeof golden];
        if (!same(pooled, want))
            throw new Error(`${scenario.name}: pooled answer differs from the golden`);
    }

    return {
        scenario: scenario.name,
        edges: pooled.edges,
        keys: pooled.keys,
        probes: pooled.probes,
        syncS: +syncS.toFixed(2),
        poolS: +poolS.toFixed(2),
        speedup: +(syncS / poolS).toFixed(2),
    };
}

async function cancelMs(scenario: Scenario): Promise<number> {
    const { entry, bake, ds } = setup(scenario);
    const controller = new AbortController();
    let started = 0;
    const solving = convert(bake, entry, ds, {
        signal: controller.signal,
        onProgress: () => {
            if (started === 0) started = performance.now();
        },
    });
    solving.catch(() => {});
    while (started === 0) await Bun.sleep(2);
    const at = performance.now();
    controller.abort();
    await solving.then(
        () => {
            throw new Error("abort did not reject");
        },
        () => {},
    );
    const ms = performance.now() - at;
    if (liveWorkers() !== 0) throw new Error(`${liveWorkers()} workers survived the abort`);
    return ms;
}

type Row = Awaited<ReturnType<typeof row>>;

const corpus: Row[] = [];
for (const scenario of scenarios) corpus.push(await row(scenario, true));
const beyond: Row[] = [];
for (const scenario of stress) beyond.push(await row(scenario, false));

console.log(`pool size ${Math.max(1, CORES - 1)} (hardwareConcurrency ${CORES})`);
console.table([...corpus, ...beyond]);

const totals = (rows: Row[]) => ({
    probes: rows.reduce((a, r) => a + r.probes, 0),
    syncS: +rows.reduce((a, r) => a + r.syncS, 0).toFixed(2),
    poolS: +rows.reduce((a, r) => a + r.poolS, 0).toFixed(2),
    speedup: +(
        rows.reduce((a, r) => a + r.syncS, 0) / rows.reduce((a, r) => a + r.poolS, 0)
    ).toFixed(2),
});
console.table({ corpus: totals(corpus), stress: totals(beyond) });

const cancels = [
    await cancelMs(scenarios[8]),
    await cancelMs(stress[0]),
    await cancelMs(stress[2]),
];
console.log(`cancel latency ms: ${cancels.map((ms) => ms.toFixed(1)).join(" · ")}`);
