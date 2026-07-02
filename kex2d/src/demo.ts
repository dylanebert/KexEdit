import type { State } from "@dylanebert/shallot";
import { addPin, bandConfig } from "./constraints";
import { addNode, Handle, Track } from "./track";

/** the stage-4 solver demo (also the wiring tests' scenario): a dip whose
 *  bottom pulls 4.8 g — breaking the comfort band's high side — plus a force
 *  pin on the crest after it. `valley` pins the crest at 0 g (a floaty pop);
 *  `losing` pins it at −5 g against band lo = −1 — the pin-at-the-band-floor
 *  worked example (the pin loses loudly, residual ≈ 4 g). returns the track
 *  eid. */
export function seedSolveDemo(ecs: State, variant: "valley" | "losing" = "valley"): number {
    let trackEid = -1;
    for (const eid of ecs.query([Track])) {
        trackEid = eid;
        break;
    }
    if (trackEid < 0) throw new Error("seedSolveDemo: no track");

    const old: number[] = [];
    for (const eid of ecs.query([Handle])) old.push(eid);
    for (const eid of old) ecs.destroy(eid);

    // flat start, −20 m dip, crest exit — feasible everywhere at V0=10
    // (y ≤ 4, v ≥ 4.6), bottom F ≈ 4.3 g, crest ≈ −0.6 g at σ ≈ 84 m.
    addNode(ecs, -60, 0);
    addNode(ecs, -20, -20);
    addNode(ecs, 12, -20);
    addNode(ecs, 40, -4);
    addNode(ecs, 72, 4);

    bandConfig.set(trackEid, { lo: -1, hi: 4 });
    addPin(ecs, trackEid, 84, variant === "losing" ? -5 : 0);
    return trackEid;
}
