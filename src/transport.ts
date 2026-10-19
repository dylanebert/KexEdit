import type { World } from "@dylanebert/shallot";
import { readRide, RideHeader, Transport, type RideEntity } from "./trajectory/ride";
import { scrub } from "./trajectory/transport";

export interface TransportSnapshot {
    playhead: number; length: number; headerRate: number; playing: boolean; rate: number;
    loop: boolean; endReason: string; endTick: number; refusal?: RideEntity["refusal"]; held: boolean;
}
type Listener = (snapshot: TransportSnapshot | null) => void;
export const TransportObservers = { create: () => new Set<() => void>() };
export const TRANSPORT_CONTEXT = Symbol("KexEdit transport");

/** One editor's UI bridge. Disposal releases its World; no app shares state or subscriptions. */
export function createTransport() {
    let world: World | undefined;
    let snapshot: TransportSnapshot | null = null;
    const listeners = new Set<Listener>();
    const publish = () => {
        const eid = world && [...world.query([RideHeader, Transport])][0];
        if (world && eid !== undefined) {
            const ride = readRide(world, eid);
            snapshot = { ...ride.transport, length: ride.header.length, headerRate: ride.header.rate,
                endReason: ride.header.endReason, endTick: ride.header.endTick, refusal: ride.refusal,
                held: ride.header.endReason !== "complete" && ride.transport.playhead > ride.header.endTick };
        } else snapshot = null;
        for (const listener of listeners) listener(snapshot);
    };
    const write = (action: (world: World, eid: number) => void) => {
        const eid = world && [...world.query([RideHeader, Transport])][0];
        if (world && eid !== undefined) { action(world, eid); publish(); }
    };
    return {
        bind(next: World) {
            if (world) throw new Error("transport is already bound");
            world = next;
            const observers = next.resource(TransportObservers);
            observers.add(publish);
            next.onDispose(() => {
                observers.delete(publish);
                world = undefined;
                publish();
            });
            publish();
        },
        subscribe(listener: Listener) { listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener); }; },
        snapshot: () => snapshot,
        togglePlaying() { write((w, eid) => w.storage(Transport).playing.set(eid, snapshot?.playing ? 0 : 1)); },
        setPlaying(playing: boolean) { write((w, eid) => w.storage(Transport).playing.set(eid, +playing)); },
        setRate(rate: number) {
            if (!Number.isFinite(rate) || rate < 0) throw new Error("transport rate: expected finite >= 0");
            write((w, eid) => w.storage(Transport).rate.set(eid, rate));
        },
        scrub(playhead: number) { write((w, eid) => w.storage(Transport).playhead.set(eid, scrub(playhead, readRide(w, eid).header))); },
    };
}
export type EditorTransport = ReturnType<typeof createTransport>;
