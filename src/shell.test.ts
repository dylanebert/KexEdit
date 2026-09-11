import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check } from "@dylanebert/shallot/harness/check";
import { compile, parse } from "svelte/compiler";

const ROOT = resolve(import.meta.dir, "..");

function read(source: string): string {
    return readFileSync(resolve(ROOT, source), "utf8");
}

function nodesWithType(value: unknown, types: Set<string>, found: unknown[] = []): unknown[] {
    if (!value || typeof value !== "object") return found;
    if (Array.isArray(value)) {
        for (const item of value) nodesWithType(item, types, found);
        return found;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string" && types.has(record.type)) found.push(record);
    for (const [key, child] of Object.entries(record)) {
        if (key !== "loc" && key !== "start" && key !== "end") nodesWithType(child, types, found);
    }
    return found;
}

function elementNames(source: string): string[] {
    const ast = parse(source);
    const elements = nodesWithType(ast, new Set(["Element", "InlineComponent", "RegularElement"]));
    return elements
        .map((node) => (node as { name?: unknown }).name)
        .filter((name): name is string => typeof name === "string");
}

check(
    "the compiled shell preserves four regions and one view canvas",
    { claim: "the shell drops a region or gives the view more than one canvas", budget: 250 },
    () => {
        const app = read("src/App.svelte");
        const view = read("src/View.svelte");
        for (const source of [app, view, read("src/Panel.svelte"), read("src/Timeline.svelte"), read("src/Status.svelte")]) {
            compile(source, { generate: "client" });
        }

        const appNames = elementNames(app);
        const viewNames = elementNames(view);
        const panelCount = appNames.filter((name) => name === "Panel").length;
        const statusCount = appNames.filter((name) => name === "Status").length;
        if (panelCount !== 3 || statusCount !== 1) {
            throw new Error(`shell regions are incomplete: ${appNames.join(", ")}`);
        }
        const canvases = viewNames.filter((name) => name === "canvas");
        if (canvases.length !== 1) throw new Error(`view owns ${canvases.length} canvases`);
    },
);
