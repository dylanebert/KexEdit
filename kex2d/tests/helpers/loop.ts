/** the 0g-loop scenario — straight lead, full circle of radius R, straight
 *  exit, sampled uniformly in arclength. at `v0 = √(5gR)` the draft circle has
 *  the classic force profile: exactly 0g at the apex and 6g at the bottom
 *  (energy conservation + κ = 1/R), with 1g on the leads. the Stage-2 lab
 *  constrains this draft (apex pin + comfort band) and watches it teardrop. */

const G = 9.80665;

export interface LoopTrack {
    x: Float64Array;
    y: Float64Array;
    n: number;
    ds: number;
    /** sample index of the loop apex (top of the circle). */
    apex: number;
    /** sample index of the loop bottom entry (start of the circle). */
    bottom: number;
    /** v0 for exactly 0g at the draft apex: √(5gR). */
    v0: number;
    radius: number;
}

export function loopTrack(R: number, ds: number, lead: number, g: number = G): LoopTrack {
    const sLoop = 2 * Math.PI * R;
    const total = 2 * lead + sLoop;
    const N = Math.round(total / ds) + 1;
    const x = new Float64Array(N);
    const y = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const s = i * ds;
        if (s < lead) {
            x[i] = s - lead;
            y[i] = 0;
        } else if (s < lead + sLoop) {
            const phi = (s - lead) / R;
            x[i] = R * Math.sin(phi);
            y[i] = R * (1 - Math.cos(phi));
        } else {
            x[i] = s - lead - sLoop;
            y[i] = 0;
        }
    }
    return {
        x,
        y,
        n: N,
        ds,
        apex: Math.round((lead + Math.PI * R) / ds),
        bottom: Math.round(lead / ds),
        v0: Math.sqrt(5 * g * R),
        radius: R,
    };
}
