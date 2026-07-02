interface Canvas2DRef {
    element: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
}

export const Canvas2D: Canvas2DRef = {} as Canvas2DRef;

const VIEW_HALF_X = 280;

export interface ViewTx {
    sx: number;
    sy: number;
    ox: number;
    oy: number;
}

export function attachCanvas2D(element: HTMLCanvasElement): void {
    const ctx = element.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    Object.assign(Canvas2D, { element, ctx });
}

export function viewTransform(canvas: HTMLCanvasElement): ViewTx {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const sx = w / (2 * VIEW_HALF_X);
    return { sx, sy: -sx, ox: w / 2, oy: h / 2 };
}

export function screenToWorld(tx: ViewTx, sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - tx.ox) / tx.sx, y: (sy - tx.oy) / tx.sy };
}

export function pointerToCanvas(
    canvas: HTMLCanvasElement,
    e: MouseEvent,
): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

export function resize(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}
