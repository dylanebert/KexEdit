import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check } from "@dylanebert/shallot/harness/check";

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
        for (const token of ["axisX: [0.9, 0.12, 0.1, 1]", "axisZ: [0.12, 0.32, 0.95, 1]", "hasYAxis: false"]) {
            if (!source.includes(token)) throw new Error(`grid axis contract lost: ${token}`);
        }
        const scene = readFileSync(resolve(ROOT, "public/scenes/scaffold.scene"), "utf8");
        if (/<a[^>]*part\b|id=\"cube\"/.test(scene)) {
            throw new Error("the scaffold scene must not retain a placeholder cube");
        }
    },
);
