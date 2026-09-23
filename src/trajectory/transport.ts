// Transport and train placement stay on the authored tick axis. The scheduler supplies the virtual
// delta; no function here reads elapsed or derives time from geometry.

import type { RideHeaderValue, TransportValue } from "./ride";
import { tickAt, type Trajectory } from "./trajectory";
import type { Quat, Vec3 } from "../path/path";

export type TransportHeader = Pick<RideHeaderValue, "length" | "rate">;

export interface TrainPose {
    tick: number;
    position: Vec3;
    rotation: Quat;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Advance one transport from a scheduler virtual delta, returning a new value. */
export function advance(transport: TransportValue, header: TransportHeader, dt: number): TransportValue {
    if (!(Number.isFinite(dt) && dt >= 0)) throw new Error(`transport dt: expected finite >= 0, got ${dt}`);
    if (!(Number.isFinite(header.length) && header.length >= 0)) {
        throw new Error(`transport length: expected finite >= 0, got ${header.length}`);
    }
    if (!(Number.isFinite(header.rate) && header.rate > 0)) {
        throw new Error(`transport header rate: expected finite > 0, got ${header.rate}`);
    }
    if (!(Number.isFinite(transport.playhead) && Number.isFinite(transport.rate) && transport.rate >= 0)) {
        throw new Error(`transport: expected finite playhead and non-negative rate`);
    }

    const next = { ...transport };
    if (!transport.playing) return next;

    const raw = transport.playhead + dt * transport.rate * header.rate;
    if (header.length > 0) {
        next.playhead = ((raw % header.length) + header.length) % header.length;
        return next;
    }
    next.playhead = 0;
    next.playing = false;
    return next;
}

/** Set a transport playhead directly on the authored tick axis, clamped to the authored length. */
export function scrub(playhead: number, header: Pick<RideHeaderValue, "length">): number {
    const { length } = header;
    if (!Number.isFinite(playhead)) {
        throw new Error(`transport scrub: expected finite playhead, got ${playhead}`);
    }
    if (!(Number.isFinite(length) && length >= 0)) {
        throw new Error(`transport length: expected finite >= 0, got ${length}`);
    }
    return clamp(playhead, 0, length);
}

/** Read the discrete pose named by a playhead plus a train's authored tick offset. */
export function placeAt(trajectory: Trajectory, playhead: number, offset: number): TrainPose {
    if (!Number.isFinite(playhead) || !Number.isFinite(offset)) {
        throw new Error(`train placement: playhead and offset must be finite`);
    }
    if (trajectory.header.count < 1) throw new Error("train placement: trajectory is empty");
    const requested = Math.floor(playhead) + Math.floor(offset);
    const tick = clamp(requested, 0, trajectory.header.count - 1);
    const { position, rotation } = tickAt(trajectory, tick);
    return { tick, position, rotation };
}
