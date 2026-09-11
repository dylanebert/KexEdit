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

type AstNode = {
    type?: unknown;
    name?: unknown;
    attributes?: unknown;
    children?: unknown;
};

function elementNames(source: string): string[] {
    const ast = parse(source);
    const elements = nodesWithType(ast, new Set(["Element", "InlineComponent", "RegularElement"]));
    return elements
        .map((node) => (node as { name?: unknown }).name)
        .filter((name): name is string => typeof name === "string");
}

function attributeText(node: AstNode, name: string): string | undefined {
    if (!Array.isArray(node.attributes)) return undefined;
    const attribute = node.attributes.find(
        (candidate) =>
            typeof candidate === "object" &&
            candidate !== null &&
            (candidate as { name?: unknown }).name === name,
    ) as { value?: unknown } | undefined;
    if (!attribute || !Array.isArray(attribute.value) || attribute.value.length !== 1) return undefined;
    const value = attribute.value[0] as { type?: unknown; raw?: unknown };
    return value.type === "Text" && typeof value.raw === "string" ? value.raw : undefined;
}

function descendantComponents(node: AstNode): AstNode[] {
    return nodesWithType(node, new Set(["InlineComponent"])).map((candidate) => candidate as AstNode);
}

function shellPanels(source: string): AstNode[] {
    const ast = parse(source);
    const main = nodesWithType(ast, new Set(["Element"])).find(
        (candidate) => (candidate as AstNode).name === "main",
    ) as AstNode | undefined;
    if (!main || !Array.isArray(main.children)) return [];
    return main.children.filter(
        (candidate): candidate is AstNode =>
            typeof candidate === "object" &&
            candidate !== null &&
            (candidate as AstNode).type === "InlineComponent" &&
            (candidate as AstNode).name === "Panel",
    );
}

check(
    "the compiled shell preserves four regions, one view canvas, and a quiet layout",
    {
        claim: "the shell drops a region, gives the view more than one canvas, or regresses its quiet layout",
        budget: 250,
    },
    () => {
        const app = read("src/App.svelte");
        const view = read("src/View.svelte");
        const panel = read("src/Panel.svelte");
        const css = read("src/app.css");
        for (const source of [app, view, panel, read("src/Timeline.svelte"), read("src/Status.svelte")]) {
            compile(source, { generate: "client" });
        }

        const appNames = elementNames(app);
        const viewNames = elementNames(view);
        const panels = shellPanels(app);
        const regions = panels.map((panel) => attributeText(panel, "region"));
        const expectedRegions = ["context", "timeline", "view"];
        if (
            panels.length !== expectedRegions.length ||
            regions.some((region) => region === undefined) ||
            new Set(regions).size !== expectedRegions.length ||
            [...regions].sort().join(",") !== expectedRegions.join(",")
        ) {
            throw new Error(`shell regions are not exactly context, view, timeline: ${regions.join(", ")}`);
        }
        if (appNames.filter((name) => name === "Status").length !== 1) {
            throw new Error(`shell status is not unique: ${appNames.join(", ")}`);
        }
        const viewPanel = panels.find((panel) => attributeText(panel, "region") === "view");
        const viewUses = viewPanel ? descendantComponents(viewPanel).filter((node) => node.name === "View") : [];
        if (viewUses.length !== 1) throw new Error("the view panel does not use exactly one View component");
        const canvases = viewNames.filter((name) => name === "canvas");
        if (canvases.length !== 1) throw new Error(`view owns ${canvases.length} canvases`);

        if (/<header\b|panel-title/.test(panel) || /\.panel-title\b/.test(css)) {
            throw new Error("panel headers must not consume persistent shell space");
        }
        for (const token of [
            "grid-template-columns: clamp(16rem, 18vw, 24rem) minmax(0, 1fr)",
            "grid-template-rows: minmax(0, 1fr) clamp(12rem, 18vh, 18rem) 2rem",
            "background: #1d2021",
            "background: #3c3836",
            "border-right: 1px solid #3c3836",
            "border-top: 1px solid #3c3836",
            ".shell-booting",
            "visibility: hidden",
        ]) {
            if (!css.includes(token)) throw new Error(`shell look contract lost: ${token}`);
        }
        for (const token of ["#0b0d10", "#0e151b", "#0d1116", "#202830"]) {
            if (css.includes(token)) throw new Error(`blue-black shell color remains: ${token}`);
        }
        if (!app.includes("data-shell-ready") || !app.includes("shellReady")) {
            throw new Error("shell does not expose its ready handoff");
        }
        if (!view.includes("loading: shallotDark(document.body)") || !view.includes("requestAnimationFrame")) {
            throw new Error("the existing Shallot loading screen is not handed off after the first frame");
        }
    },
);
