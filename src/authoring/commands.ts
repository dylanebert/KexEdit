import { isParameter, type Parameter, type RideDocument, type RideKey, validateRide } from "./document";

interface KeyLane {
    /** Zero-based span index, including when two spans have keys at the same tick. */
    span: number;
    property: Parameter;
}

export interface SetKey extends KeyLane {
    key: RideKey;
}

export interface SetKeyUndo extends KeyLane {
    tick: number;
    previous: Omit<RideKey, "tick"> | null;
}

function changeKey(source: RideDocument, { span, property }: KeyLane, tick: number, key: RideKey | null) {
    const selected = Number.isSafeInteger(span) && span >= 0 ? source.spans[span] : undefined;
    if (!selected) throw new Error("set-key span: expected an existing span index");
    if (!isParameter(property)) throw new Error("set-key property: unknown property");
    if (!Number.isSafeInteger(tick) || tick < selected.start || tick > selected.end)
        throw new Error("set-key tick: expected an integer from span start through span end");

    const keys = selected[property].filter(item => item.tick !== tick);
    if (key) keys.push(key);
    keys.sort((a, b) => a.tick - b.tick);
    const spans = source.spans.slice();
    spans[span] = { ...selected, [property]: keys };
    return validateRide({ ...source, spans });
}

/** Set one authored key without mutating the source; return the data needed to undo it. */
export function setKey(source: RideDocument, { span, property, key }: SetKey) {
    const lane = { span, property };
    const { tick } = key;
    const document = changeKey(source, lane, tick, key);
    const previous = source.spans[span][property].find(item => item.tick === tick);
    const undo: SetKeyUndo = { ...lane, tick, previous: previous ? { value: previous.value, ease: previous.ease } : null };
    return { document, undo };
}

/** Restore the addressed key (or remove the insertion), preserving unrelated edits. */
export function undoSetKey(source: RideDocument, undo: SetKeyUndo): RideDocument {
    return changeKey(source, undo, undo.tick, undo.previous && { ...undo.previous, tick: undo.tick });
}
