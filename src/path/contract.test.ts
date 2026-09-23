import { check } from "@dylanebert/shallot/harness/check";
import * as d from "typegpu/data";
import { helix } from "./helix.fixture";
import {
    AUX_LANES,
    auxIndex,
    auxSlot,
    PATH_VERSION,
    type PathHeader,
    POSE_BYTES,
    POSE_FLOATS,
    POSE_LANES,
    packAux,
    Pose,
    readPath,
} from "./path";

check(
    "the pose stride is the schema size",
    { claim: "the path pose stride drifts from its typegpu schema" },
    () => {
        if (POSE_BYTES !== d.sizeOf(Pose)) throw new Error(`POSE_BYTES ${POSE_BYTES} != schema`);
        const bytes = (floats: number) => floats * Float32Array.BYTES_PER_ELEMENT;
        const layout = {
            position: d.memoryLayoutOf(Pose, (p) => p.position).offset,
            w: d.memoryLayoutOf(Pose, (p) => p.w).offset,
            rotation: d.memoryLayoutOf(Pose, (p) => p.rotation).offset,
        };
        for (const key of ["position", "w", "rotation"] as const) {
            if (bytes(POSE_LANES[key]) !== layout[key]) {
                throw new Error(`pose lane ${key} disagrees with memoryLayoutOf`);
            }
        }
    },
);

const header = (overrides: Partial<PathHeader> = {}): PathHeader => ({
    ...helix.header,
    ...overrides,
});

function refuses(label: string, field: string, run: () => unknown): void {
    let message: string | null = null;
    try {
        run();
    } catch (error) {
        message = (error as Error).message;
    }
    if (message === null) throw new Error(`${label}: readPath accepted it`);
    if (!message.includes(field)) throw new Error(`${label}: refusal "${message}" omits ${field}`);
}

check(
    "readPath refuses a wrong version and malformed streams",
    { claim: "readPath admits a path of the wrong version or shape" },
    () => {
        readPath(helix);
        refuses("version", "version", () =>
            readPath({ ...helix, header: header({ version: PATH_VERSION + 1 }) }),
        );
        refuses("pose length", "poses", () =>
            readPath({ ...helix, poses: helix.poses.subarray(POSE_FLOATS) }),
        );
        const skewed = helix.poses.slice();
        skewed[POSE_LANES.rotation + 3] *= 1.01;
        refuses("non-unit", "rotation", () => readPath({ ...helix, poses: skewed }));
        const names = ["speed"];
        const aux = packAux(names, Array.from({ length: helix.header.count }, () => [1]));
        refuses("aux length", "aux", () =>
            readPath({ ...helix, header: header({ aux: names }), aux: aux?.subarray(AUX_LANES) }),
        );
    },
);

check(
    "aux slots round-trip through name, row and lane",
    { claim: "the path aux map loses a slot between name, row and lane" },
    () => {
        const count = helix.header.count;
        for (const slots of [1, 4, 5]) {
            const names = Array.from({ length: slots }, (_, i) => `slot${i}`);
            const value = (pose: number, slot: number) => pose * 16 + slot + 1;
            const rows = Array.from({ length: count }, (_, pose) =>
                names.map((_, slot) => value(pose, slot)),
            );
            const aux = packAux(names, rows);
            if (aux === undefined) throw new Error(`${slots} slots packed no stream`);
            const h = header({ aux: names });
            const path = readPath({ ...helix, header: h, aux });
            if (aux.length !== count * Math.ceil(slots / 4) * 4) {
                throw new Error(`${slots} slots packed ${aux.length} floats`);
            }
            names.forEach((name, slot) => {
                const { row, lane } = auxSlot(h, name);
                if (row !== Math.floor(slot / 4) || lane !== slot % 4) {
                    throw new Error(`${name} resolved to row ${row} lane ${lane}`);
                }
                for (const pose of [0, 1, count - 1]) {
                    const got = path.aux?.[auxIndex(h, pose, name)];
                    if (got !== value(pose, slot)) {
                        throw new Error(`${slots} slots: pose ${pose} ${name} read ${got}`);
                    }
                }
            });
        }
    },
);

check(
    "an empty aux map yields no aux stream",
    { claim: "an empty path aux map still allocates an aux stream" },
    () => {
        const rows = [[], []];
        const aux = packAux([], rows);
        if (aux !== undefined) throw new Error(`empty map packed ${aux.length} floats`);
        if (helix.aux !== undefined) throw new Error("helix fixture carries an aux stream");
        refuses("stray aux", "aux", () =>
            readPath({ ...helix, aux: new Float32Array(helix.header.count * 4) }),
        );
    },
);

check(
    "a stream that is not a Float32Array is refused by name",
    { claim: "a path whose streams are not Float32Array reaches a consumer sized by byteLength" },
    () => {
        const floats = Array.from(helix.poses);
        refuses("Float64Array poses", "poses", () =>
            readPath({ ...helix, poses: new Float64Array(floats) as unknown as Float32Array }),
        );
        refuses("array poses", "poses", () => readPath({ ...helix, poses: floats as unknown as Float32Array }));
        const names = ["velocity"];
        const rows = Array.from({ length: helix.header.count }, () => [1]);
        const aux = Array.from(packAux(names, rows) ?? []);
        refuses("array aux", "aux", () =>
            readPath({ ...helix, header: header({ aux: names }), aux: aux as unknown as Float32Array }),
        );
    },
);

check(
    "the shader's struct layouts come from the typegpu schemas",
    { claim: "the resolved path shader's Pose field order or uniform size departs from its typegpu schema" },
    async () => {
        const { PATH_SHADER, PathUniform, UNIFORM_FLOATS } = await import("./shader");
        const body = /struct\s+Pose\s*\{([^}]*)\}/.exec(PATH_SHADER)?.[1];
        if (!body) throw new Error("resolved shader has no Pose struct");
        const fields = body.split(",").map((f) => f.split(":")[0].trim()).filter(Boolean);
        const byOffset = (["position", "w", "rotation"] as const)
            .map((name) => ({ name, offset: d.memoryLayoutOf(Pose, (p) => p[name]).offset }))
            .sort((a, b) => a.offset - b.offset)
            .map((f) => f.name);
        if (fields.join() !== byOffset.join()) throw new Error(`Pose fields ${fields} != schema ${byOffset}`);
        if (UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT !== d.sizeOf(PathUniform)) {
            throw new Error(`UNIFORM_FLOATS ${UNIFORM_FLOATS} != schema ${d.sizeOf(PathUniform)} bytes`);
        }
        if (!/struct\s+PathUniform\s*\{/.test(PATH_SHADER)) throw new Error("resolved shader has no PathUniform struct");
    },
);
