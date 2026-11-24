import { expect, test } from "bun:test";
import { setKey, undoSetKey } from "./commands";
import { openRide, saveRide } from "./document";

const text = await Bun.file(new URL("./straight.ride.json", import.meta.url)).text();

test("set-key inserts in tick order and undo removes only the insertion", () => {
    const source = openRide(text);
    const { document, undo } = setKey(source, { span: 0, property: "normal",
        key: { tick: 25, value: -1, ease: "hold" } });
    expect(saveRide(source)).toBe(text);
    expect(document.spans[0].normal).toEqual([
        { tick: 0, value: 1, ease: "hold" }, { tick: 25, value: -1, ease: "hold" },
    ]);
    const other = setKey(document, { span: 0, property: "normal",
        key: { tick: 10, value: 2, ease: "linear" } });
    expect(other.document.spans[0].normal.map(key => key.tick)).toEqual([0, 10, 25]);
    expect(undoSetKey(other.document, undo).spans[0].normal).toEqual([
        { tick: 0, value: 1, ease: "hold" }, { tick: 10, value: 2, ease: "linear" },
    ]);
    expect(saveRide(undoSetKey(document, undo))).toBe(text);
});

test("replacement and undo address distinct end and start keys at a shared boundary", () => {
    const source = openRide(text);
    const next = openRide(text).spans[0];
    next.start = 50;
    for (const keys of [next.normal, next.lateral, next.roll, next.target, next.accel]) keys[0].tick = 50;
    source.spans[0].end = 50;
    source.spans[0].normal.push({ tick: 50, value: 3, ease: "linear" });
    source.spans.push(next);
    const before = saveRide(source);
    const edit = setKey(source, { span: 0, property: "normal", key: { tick: 50, value: 4, ease: "hold" } });
    const across = setKey(edit.document, { span: 1, property: "normal", key: { tick: 50, value: 5, ease: "hold" } });
    expect(saveRide(source)).toBe(before);
    expect(across.document.spans.map(span => span.normal.at(-1)?.value)).toEqual([4, 5]);
    const restored = undoSetKey(across.document, edit.undo);
    expect(restored.spans[0]).toEqual(source.spans[0]);
    expect(restored.spans[1]).toEqual(across.document.spans[1]);
    expect(saveRide(undoSetKey(restored, across.undo))).toBe(before);
});

test("set-key rejects a nonexistent span, a tick outside the span, and an invalid property value", () => {
    const source = openRide(text);
    const key = { tick: 25, value: -1, ease: "hold" } as const;
    expect(() => setKey(source, { span: 1, property: "normal", key })).toThrow("span");
    expect(() => setKey(source, { span: 0, property: "normal", key: { ...key, tick: 101 } })).toThrow("tick");
    expect(() => setKey(source, { span: 0, property: "accel", key })).toThrow("value");
});
