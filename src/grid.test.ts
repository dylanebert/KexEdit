import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { srgbToLinear } from "@dylanebert/shallot";
import { check } from "@dylanebert/shallot/harness/check";
import { GRID_BYTES, GRID_MATERIAL_CONTRACT } from "./grid";

const ROOT = resolve(import.meta.dir, "..");

check(
    "the viewport grid remains a GPU draw-group material",
    { claim: "the KexEdit grid loses its GPU seam or depth-aware shader", budget: 250 },
    () => {
        const source = readFileSync(resolve(ROOT, "src/grid.ts"), "utf8");
        const required = [
            "group: \"draw\"",
            "after: [ColorSystem]",
            "before: [GlazeSystem]",
            "view.framebuffer",
            "depthStencilAttachment",
            "@builtin(frag_depth)",
            "fwidth(coord)",
            "smoothstep(20.0, 80.0, dist)",
            "GRID_MATERIAL_CONTRACT",
            "axisXColor",
            "axisZColor",
            "atomicAdd(&gridProbe",
            "pass.draw(6)",
        ];
        for (const token of required) {
            if (!source.includes(token)) throw new Error(`grid seam lost: ${token}`);
        }
        if (/lineSegments|LineSegment|cpuLines/i.test(source)) {
            throw new Error("grid must not be assembled from CPU line segments");
        }
        if (source.includes("axisYColor") || source.includes("axisY")) {
            throw new Error("XZ ground grid must not invent a visible Y axis");
        }
        if (!source.includes("hasYAxis: false")) throw new Error("grid axis contract lost: hasYAxis: false");
        const scene = readFileSync(resolve(ROOT, "public/scenes/scaffold.scene"), "utf8");
        if (/<a[^>]*part\b|id=\"cube\"/.test(scene)) {
            throw new Error("the scaffold scene must not retain a placeholder cube");
        }
    },
);

check(
    "the grid material contract carries its sRGB bytes decoded to linear",
    { claim: "the grid hands sRGB byte fractions to the linear scene target", budget: 250 },
    () => {
        for (const name of ["neutral", "axisX", "axisZ"] as const) {
            const rgb = GRID_BYTES[name];
            const want = [16, 8, 0].map((shift) => srgbToLinear(((rgb >> shift) & 0xff) / 255));
            const got = GRID_MATERIAL_CONTRACT[name];
            if (got.length !== 4 || got[3] !== 1 || want.some((w, i) => got[i] !== w)) {
                throw new Error(`grid ${name}: ${JSON.stringify(got)} is not srgbToLinear of ${JSON.stringify(want)}`);
            }
        }
    },
);
