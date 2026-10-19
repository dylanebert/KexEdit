import { shallot } from "@dylanebert/shallot/bun";
import { plugin } from "bun";
import { afterEach, setDefaultTimeout } from "bun:test";
import { TIMEOUT } from "@dylanebert/shallot/testing";

plugin(shallot({ root: import.meta.dir }));
setDefaultTimeout(TIMEOUT.cheap);

const unexpected: string[] = [];
for (const level of ["warn", "error"] as const) {
    const original = console[level];
    console[level] = (...args) => { unexpected.push(`${level}: ${args.map(String).join(" ")}`); original(...args); };
}
afterEach(() => {
    const messages = unexpected.splice(0);
    if (messages.length) throw new Error(`Unexpected console output:\n${messages.join("\n")}`);
});
