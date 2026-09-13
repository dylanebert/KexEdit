import { check } from "@dylanebert/shallot/harness/check";
import { helix } from "./helix.fixture";
import { AUX_LANES, auxRows, packAux, PATH_VERSION, type Path, POSE_BYTES, readPath } from "./path";
import { straight } from "./straight.fixture";
import { pathUploads } from "./upload";

function recorder() {
    const writes: { stream: "poses" | "aux"; bytes: number }[] = [];
    return {
        writes,
        bytes: () => writes.reduce((sum, w) => sum + w.bytes, 0),
        sink: {
            poses: (data: Float32Array) => writes.push({ stream: "poses", bytes: data.byteLength }),
            aux: (data: Float32Array | undefined) => {
                if (data) writes.push({ stream: "aux", bytes: data.byteLength });
            },
        },
    };
}

check(
    "path upload bytes equal the fixture streams on setPath and zero otherwise",
    { claim: "the path view uploads more or less than one whole write per invalidated stream", budget: 250 },
    () => {
        const names = ["velocity", "gForce", "heart", "section", "roll"];
        const rows = Array.from({ length: helix.header.count }, (_, i) => names.map((_, s) => i + s));
        const withAux: Path = readPath({
            header: { ...helix.header, version: PATH_VERSION, aux: names },
            poses: helix.poses,
            aux: packAux(names, rows),
        });
        const cases: [string, Path, number][] = [
            ["helix", helix, helix.header.count * POSE_BYTES],
            ["straight", straight, straight.header.count * POSE_BYTES],
            [
                "helix+aux",
                withAux,
                withAux.header.count * POSE_BYTES +
                    withAux.header.count * auxRows(names.length) * AUX_LANES * Float32Array.BYTES_PER_ELEMENT,
            ],
        ];
        const uploads = pathUploads();
        const idle = recorder();
        if (uploads.flush(idle.sink) !== 0 || idle.bytes() !== 0) throw new Error("upload before any setPath");
        for (const [name, path, expected] of cases) {
            if (expected <= 0) throw new Error(`${name}: empty fixture proves nothing`);
            uploads.set(path);
            const frame = recorder();
            const reported = uploads.flush(frame.sink);
            if (frame.bytes() !== expected || reported !== expected) {
                throw new Error(`${name}: uploaded ${frame.bytes()} (reported ${reported}), expected ${expected}`);
            }
            const streams = frame.writes.map((w) => w.stream).join(",");
            if (streams !== (path.aux ? "poses,aux" : "poses")) throw new Error(`${name}: writes ${streams}`);
            if (uploads.path !== path) throw new Error(`${name}: live path not the one set`);
            const quiet = recorder();
            if (uploads.flush(quiet.sink) !== 0 || quiet.writes.length !== 0) {
                throw new Error(`${name}: ${quiet.bytes()} bytes on a frame with no invalidation`);
            }
        }
        const refused = { ...straight, header: { ...straight.header, version: PATH_VERSION + 1 } };
        let threw = false;
        try {
            uploads.set(refused);
        } catch {
            threw = true;
        }
        const after = recorder();
        if (!threw || uploads.flush(after.sink) !== 0) throw new Error("a malformed path reached the upload");
    },
);
