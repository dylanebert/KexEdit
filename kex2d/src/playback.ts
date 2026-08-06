/** Pure fit-lab playback assembly for the flat conversion and full-free oracle. */

import type { Scale } from "./census";
import type { FitStep } from "./fit";
import type { PolishResult, Snapshot } from "./polish";
import { type ForcePoint, forceProfile } from "./profile";
import type { RefineEvent, RefineResult } from "./refine";

export const PANEL = { w: 620, h: 340, padL: 46, padR: 14, padT: 26, padB: 34 } as const;

export function forceRange(
    frames: readonly Frame[],
    extra: readonly ArrayLike<number>[] = [],
): { lo: number; hi: number } {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    const sweep = (values: ArrayLike<number>): void => {
        for (let index = 0; index < values.length; index++) {
            const value = values[index];
            lo = Math.min(lo, value);
            hi = Math.max(hi, value);
        }
    };
    for (const values of extra) sweep(values);
    for (const frame of frames) if (frame.fN) sweep(frame.fN);
    if (!Number.isFinite(lo) || !Number.isFinite(hi))
        throw new Error("playback: no finite force values to range over");
    const pad = 0.06 * Math.max(hi - lo, 1e-3);
    return { lo: lo - pad, hi: hi + pad };
}

export function panelScale(length: number, lo: number, hi: number): Scale {
    if (!(length > 0) || !Number.isFinite(length))
        throw new Error(`playback: panel length must be > 0, got ${length}`);
    if (!(hi > lo)) throw new Error(`playback: panel g-range must ascend, got ${lo}..${hi}`);
    return {
        s: (PANEL.w - PANEL.padL - PANEL.padR) / length,
        g: (PANEL.h - PANEL.padB - PANEL.padT) / (hi - lo),
    };
}

export interface PlotPoint {
    x: number;
    y: number;
}

/** Uniform force-section sample positions, `s_j = j·ds`. */
export function uniformAbscissa(count: number, ds: number): Float64Array {
    if (!Number.isInteger(count) || count < 0)
        throw new Error(`playback: sample count must be a non-negative integer, got ${count}`);
    if (!(ds > 0) || !Number.isFinite(ds))
        throw new Error(`playback: sample ds must be > 0, got ${ds}`);
    return Float64Array.from({ length: count }, (_, index) => index * ds);
}

/** Force samples transformed into fit-lab panel coordinates at an explicit abscissa. */
export function forcePath(
    values: ArrayLike<number>,
    abscissa: ArrayLike<number>,
    scale: Scale,
    lo: number,
): PlotPoint[] {
    if (abscissa.length !== values.length)
        throw new Error(
            `playback: ${values.length} force samples against ${abscissa.length} positions`,
        );
    const out: PlotPoint[] = [];
    for (let index = 0; index < values.length; index++)
        out.push({
            x: PANEL.padL + abscissa[index] * scale.s,
            y: PANEL.h - PANEL.padB - (values[index] - lo) * scale.g,
        });
    return out;
}

export type Phase = "recover" | "fit" | "refine" | "polish";

export interface Frame {
    phase: Phase;
    label: string;
    points: readonly ForcePoint[] | null;
    fN: ArrayLike<number> | null;
    snap: Snapshot | null;
    step: FitStep | null;
    event: RefineEvent | null;
}

export interface Segment {
    phase: Phase;
    label: string;
    start: number;
    end: number;
}

function recovered(): Frame {
    return {
        phase: "recover",
        label: "dense recovered F_n",
        points: null,
        fN: null,
        snap: null,
        step: null,
        event: null,
    };
}

function solveFrames(out: PolishResult): Frame[] {
    const last = out.snapshots.length - 1;
    if (last < 0) throw new Error("playback: polish recorded no step to draw");
    return out.snapshots.map((snap, index) => ({
        phase: "polish",
        label:
            index === last
                ? `polish · oracle answer · ${out.keys} keys`
                : `polish · iter ${snap.step}`,
        points: snap.points,
        fN: snap.fN,
        snap,
        step: null,
        event: null,
    }));
}

export function eventLabel(event: RefineEvent, sigma: ArrayLike<number>): string {
    const at = event.at >= 0 ? ` @ ${sigma[event.at].toFixed(1)} m` : "";
    const state = `${event.knots.length} keys`;
    const deviation = `dev ${event.deviation.toFixed(3)} m`;
    switch (event.kind) {
        case "init":
            return `convert · open · ${state} · ${deviation}`;
        case "split":
            return `convert · split${at} · ${state} · ${deviation}`;
        case "prune":
            return `convert · prune${at} · ${state} · ${deviation}`;
        case "budget":
            return `convert · budget · no admissible site · ${deviation}`;
        case "diverged":
            return `convert · diverged · ${deviation}`;
    }
}

/** Full-free numeric-floor oracle timeline. */
export function baseline(steps: readonly FitStep[], out: PolishResult): Frame[] {
    if (steps.length === 0) throw new Error("playback: fit produced no steps");
    const frames = [recovered()];
    steps.forEach((step, index) => {
        frames.push({
            phase: "fit",
            label:
                index === 0
                    ? `fit · first piece · ${step.knots.length} keys`
                    : `fit · ${step.phase} ${index} · ${step.knots.length} keys`,
            points: step.points,
            fN: forceProfile(step.points, { edges: out.edges, ds: out.ds }),
            snap: null,
            step,
            event: null,
        });
    });
    return [...frames, ...solveFrames(out)];
}

/** Shipping flat conversion timeline: one frame per decision, with no duplicate answer. */
export function pipeline(result: RefineResult, sigma: ArrayLike<number>): Frame[] {
    const frames = [recovered()];
    for (const event of result.events)
        frames.push({
            phase: "refine",
            label: eventLabel(event, sigma),
            points: event.points,
            fN: forceProfile(event.points, { edges: result.final.edges, ds: result.final.ds }),
            snap: null,
            step: null,
            event,
        });
    const tail = frames[frames.length - 1];
    if (!tail.event || tail.event.points !== result.events[result.events.length - 1].points)
        throw new Error("playback: conversion timeline lost its final decision");
    tail.label += " · answer";
    return frames;
}

export function segments(frames: readonly Frame[], note = "full-free oracle"): Segment[] {
    const segments: Segment[] = [];
    frames.forEach((frame, index) => {
        const tail = segments[segments.length - 1];
        if (tail && tail.phase === frame.phase) tail.end = index;
        else
            segments.push({
                phase: frame.phase,
                label: frame.phase,
                start: index,
                end: index,
            });
    });
    for (const segment of segments) {
        const count = segment.end - segment.start + 1;
        if (segment.phase === "fit") segment.label = `fit · split → prune (${count})`;
        else if (segment.phase === "polish") segment.label = `polish · ${note} (${count})`;
    }
    return segments;
}
