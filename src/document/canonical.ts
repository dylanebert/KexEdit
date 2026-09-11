export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// One number format: the shortest round-tripping decimal JSON.stringify prints. Non-finite
// numbers have no JSON form, so they refuse rather than degrade to null.
function emitNumber(value: number): string {
    if (!Number.isFinite(value)) throw new Error(`canonical: non-finite number ${value}`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

function emitValue(value: Json): string {
    if (value === null || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") return emitNumber(value);
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(emitValue).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${emitValue(value[key])}`).join(",")}}`;
}

export function emitCanonical(value: Json): string {
    return `${emitValue(value)}\n`;
}
