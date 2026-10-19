import { MaterialPlugin, materialType } from "@dylanebert/shallot/standard/rendering";
import * as d from "typegpu/data";
import * as std from "typegpu/std";

const GridParameters = d.struct({ color: d.vec3f });

/** A metre grid on the editor's ground plane; derivatives fade subpixel lines at the horizon. */
export const GroundGrid = materialType({
    name: "KexEditGroundGrid",
    parameters: GridParameters,
    defaults: { color: d.vec3f(0.045) },
    fragment: ctx => {
        "use gpu";
        const p = ctx.world.xz;
        const footprint = std.max(std.fwidth(p), d.vec2f(0.0001));
        const edge = std.div(std.abs(std.sub(std.fract(std.add(p, 0.5)), 0.5)), footprint);
        const line = 1 - std.min(std.min(edge.x, edge.y), 1);
        const fade = 1 - std.smoothstep(0.2, 1, std.max(footprint.x, footprint.y));
        return d.vec4f(ctx.parameters.color, line * fade);
    },
});
export const GridPlugin = MaterialPlugin(GroundGrid);
