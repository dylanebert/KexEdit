/** a recording `CanvasRenderingContext2D` double for `render.ts` tests. `bun test` runs headless
 *  (no real canvas), and even under a real one `strokeStyle`/`fillStyle` are shared mutable state
 *  written and overwritten many times a frame — reading them back off the context after a system
 *  runs only ever proves what the LAST draw call set, never what a specific earlier stroke or fill
 *  actually used. This double closes that gap by snapshotting the live style state at the instant
 *  each drawing method fires, so a test can assert what color a specific glyph's stroke drew in,
 *  not just what the context's style happens to read afterward.
 *
 *  Path-building calls (`beginPath`, `moveTo`, `lineTo`, `arc`, `rect`, `closePath`,
 *  `setLineDash`, `translate`, `rotate`, `setTransform`) are no-ops: they describe geometry, they
 *  never put ink down, so they carry no style to record. `save`/`restore` maintain a real style
 *  stack (strokeStyle/fillStyle/lineWidth/globalAlpha) so a system that brackets part of its draw
 *  in `save()`/`restore()` — `render.ts` does, for the START anchor's soft ring — replays correctly
 *  against this double instead of leaking state across the boundary.
 *
 * @example
 * const { ctx, calls } = recordingContext();
 * Object.assign(Canvas2D, { element: fakeCanvas, ctx });
 * AnchorDrawSystem.update(state);
 * expect(calls.at(-1)?.strokeStyle).toBe(hovered(COLOR_ANCHOR));
 */

/** the drawing methods the recorder captures — every call that actually puts ink on the canvas. */
export type DrawMethod = "fill" | "stroke" | "fillRect" | "strokeRect";

/** one draw call, with the style state in effect AT THE MOMENT it fired. */
export interface DrawCall {
    method: DrawMethod;
    strokeStyle: string;
    fillStyle: string;
    lineWidth: number;
    globalAlpha: number;
}

interface StyleSnapshot {
    strokeStyle: string;
    fillStyle: string;
    lineWidth: number;
    globalAlpha: number;
}

class RecordingContext {
    strokeStyle = "#000000";
    fillStyle = "#000000";
    lineWidth = 1;
    globalAlpha = 1;

    readonly calls: DrawCall[] = [];
    #stack: StyleSnapshot[] = [];

    #record(method: DrawMethod): void {
        this.calls.push({
            method,
            strokeStyle: String(this.strokeStyle),
            fillStyle: String(this.fillStyle),
            lineWidth: this.lineWidth,
            globalAlpha: this.globalAlpha,
        });
    }

    save(): void {
        this.#stack.push({
            strokeStyle: this.strokeStyle,
            fillStyle: this.fillStyle,
            lineWidth: this.lineWidth,
            globalAlpha: this.globalAlpha,
        });
    }

    restore(): void {
        const s = this.#stack.pop();
        if (!s) return;
        this.strokeStyle = s.strokeStyle;
        this.fillStyle = s.fillStyle;
        this.lineWidth = s.lineWidth;
        this.globalAlpha = s.globalAlpha;
    }

    fill(): void {
        this.#record("fill");
    }

    stroke(): void {
        this.#record("stroke");
    }

    fillRect(): void {
        this.#record("fillRect");
    }

    strokeRect(): void {
        this.#record("strokeRect");
    }

    // path-building / transform calls — geometry, not ink. no-ops.
    beginPath(): void {}
    closePath(): void {}
    moveTo(): void {}
    lineTo(): void {}
    arc(): void {}
    rect(): void {}
    setLineDash(): void {}
    translate(): void {}
    rotate(): void {}
    scale(): void {}
    setTransform(): void {}
}

/** build a fresh recording context double + its call log. one recorder per test — the log is
 *  append-only and never resets on its own. */
export function recordingContext(): { ctx: CanvasRenderingContext2D; calls: DrawCall[] } {
    const rc = new RecordingContext();
    return { ctx: rc as unknown as CanvasRenderingContext2D, calls: rc.calls };
}

/** a minimal `HTMLCanvasElement` double carrying only what `viewTransform`/`resize` read —
 *  `clientWidth`/`clientHeight` — for a system draw driven with no real DOM. */
export function fakeCanvasElement(width: number, height: number): HTMLCanvasElement {
    return { clientWidth: width, clientHeight: height } as unknown as HTMLCanvasElement;
}
