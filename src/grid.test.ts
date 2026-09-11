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
            "atomicAdd(&gridProbe",
            "pass.draw(6)",
        ];
        for (const token of required) {
            if (!source.includes(token)) throw new Error(`grid seam lost: ${token}`);
        }
        if (/lineSegments|LineSegment|cpuLines/i.test(source)) {
            throw new Error("grid must not be assembled from CPU line segments");
        }
    },
);
