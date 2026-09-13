// The path view's upload accounting, kept free of the engine so a unit row can drive it. `set` validates
// through `readPath` and marks both streams dirty; `flush` hands each dirty stream to the sink as one
// whole write and reports the bytes. There is no per-pose write path.

import { type Path, readPath } from "./path";

export interface PathSink {
    poses(data: Float32Array): void;
    /** `undefined` retracts the aux stream: the live path has an empty slot map. */
    aux(data: Float32Array | undefined): void;
}

export interface PathUploads {
    /** the path whose streams the last flush wrote */
    readonly path: Path | null;
    set(path: Path): void;
    flush(sink: PathSink): number;
}

export function pathUploads(): PathUploads {
    let pending: Path | null = null;
    let live: Path | null = null;
    return {
        get path() {
            return live;
        },
        set(path) {
            pending = readPath(path);
        },
        flush(sink) {
            if (!pending) return 0;
            const next = pending;
            pending = null;
            live = next;
            sink.poses(next.poses);
            sink.aux(next.aux);
            return next.poses.byteLength + (next.aux?.byteLength ?? 0);
        },
    };
}
