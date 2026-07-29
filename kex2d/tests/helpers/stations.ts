// the arclength-aligned comparison metrics for two bakes of the same section — shared by the
// fast document-seam pins (`forcegeo.test.ts`) and the corpus-wide oracles (`forcegeo.oracle.ts`).
// the two bakes have DIFFERENT edge counts and edge lengths, so the comparison is aligned on
// ABSOLUTE ARCLENGTH FROM THE SECTION ENTRY — the timeline's own station axis. Each curve's
// per-edge force is a value at its LEFT sample's arclength, the convention `bake.forces` computes
// it under (`fN[i]` from `theta[i]`, `theta[i+1]`, `ds[i]`); attributing it to the edge midpoint
// instead shifts each curve by its own half-edge, and the two half-edges differ, so a force
// gradient reads a bias of |dF/ds|·|ds_t − ds_c|/2 that belongs to neither curve. The drift is the
// max over BOTH curves' stations of the gap to the other curve linearly interpolated there;
// evaluating at only one curve's stations would step over exactly the extremes the other one
// carries.

export interface Stations {
    s: number[];
    g: number[];
}

/** per-edge force as values at the edge's LEFT sample arclength, measured from the section
 *  entry — `bake.forces`'s own attribution. */
export function stations(fN: ArrayLike<number>, ds: ArrayLike<number>, edges: number): Stations {
    const s: number[] = [];
    const g: number[] = [];
    let at = 0;
    for (let k = 0; k < edges; k++) {
        s.push(at);
        g.push(fN[k]);
        at += ds[k];
    }
    return { s, g };
}

/** per-sample position as values at the sample's own arclength from the section entry — the
 *  geometric budget's half of the same station axis. */
export function posStations(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    ds: ArrayLike<number>,
    edges: number,
): { s: number[]; x: number[]; y: number[]; total: number } {
    const s: number[] = [];
    const px: number[] = [];
    const py: number[] = [];
    let at = 0;
    for (let i = 0; i <= edges; i++) {
        s.push(at);
        px.push(x[i]);
        py.push(y[i]);
        if (i < edges) at += ds[i];
    }
    return { s, x: px, y: py, total: at };
}

/** linear interpolation of `st` at arclength `at`, held flat beyond either end. */
function at(st: Stations, s: number): number {
    if (st.s.length === 0) return Number.NaN;
    if (s <= st.s[0]) return st.g[0];
    const last = st.s.length - 1;
    if (s >= st.s[last]) return st.g[last];
    let i = 0;
    while (i + 1 <= last && st.s[i + 1] < s) i++;
    const u = (s - st.s[i]) / (st.s[i + 1] - st.s[i]);
    return st.g[i] + u * (st.g[i + 1] - st.g[i]);
}

/** the arclength-aligned max force gap between two bakes of the same section. symmetric: every
 *  station of either curve is scored against the other. */
export function drift(a: Stations, b: Stations): number {
    let worst = 0;
    for (let i = 0; i < a.s.length; i++) worst = Math.max(worst, Math.abs(a.g[i] - at(b, a.s[i])));
    for (let i = 0; i < b.s.length; i++) worst = Math.max(worst, Math.abs(b.g[i] - at(a, b.s[i])));
    return worst;
}

export type Positions = ReturnType<typeof posStations>;

/** the arclength-aligned max positional gap between two bakes of the same section, the same
 *  symmetric union-of-stations reading `drift` takes on force. */
export function posDrift(a: Positions, b: Positions): number {
    const near = (p: Positions, s: number): [number, number] => {
        const last = p.s.length - 1;
        if (s <= p.s[0]) return [p.x[0], p.y[0]];
        if (s >= p.s[last]) return [p.x[last], p.y[last]];
        let i = 0;
        while (i + 1 <= last && p.s[i + 1] < s) i++;
        const u = (s - p.s[i]) / (p.s[i + 1] - p.s[i]);
        return [p.x[i] + u * (p.x[i + 1] - p.x[i]), p.y[i] + u * (p.y[i + 1] - p.y[i])];
    };
    let worst = 0;
    for (const [p, q] of [
        [a, b],
        [b, a],
    ] as const) {
        for (let i = 0; i < p.s.length; i++) {
            const [x, y] = near(q, p.s[i]);
            worst = Math.max(worst, Math.hypot(p.x[i] - x, p.y[i] - y));
        }
    }
    return worst;
}

/** symmetric nearest-point distance (discrete Hausdorff over the two sample sets). */
export function hausdorff(
    a: { x: ArrayLike<number>; y: ArrayLike<number>; n: number },
    b: { x: ArrayLike<number>; y: ArrayLike<number>; n: number },
): number {
    const oneWay = (p: typeof a, q: typeof b): number => {
        let worst = 0;
        for (let i = 0; i < p.n; i++) {
            let near = Number.POSITIVE_INFINITY;
            for (let j = 0; j < q.n; j++) {
                const d = Math.hypot(p.x[i] - q.x[j], p.y[i] - q.y[j]);
                if (d < near) near = d;
            }
            if (near > worst) worst = near;
        }
        return worst;
    };
    return Math.max(oneWay(a, b), oneWay(b, a));
}
