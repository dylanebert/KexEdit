import { check } from "@dylanebert/shallot/harness/check";
import { blockCapability, passCapability, type CapabilityWarning } from "./capability";

check(
    "capability outcomes keep hard blocks distinct from passable warnings",
    {
        claim: "capability outcomes lose the block distinction or reject future warning-only results",
        budget: 100,
    },
    () => {
        const warning: CapabilityWarning = {
            code: "future-suitability",
            message: "A future suitability heuristic may warn without blocking startup.",
        };
        const pass = passCapability([warning]);
        const block = blockCapability("WebGPU is unavailable.", [warning]);
        if (pass.status !== "pass" || pass.warnings.length !== 1 || pass.warnings[0] !== warning) {
            throw new Error("warning-bearing capability result is not passable");
        }
        if (block.status !== "block" || block.reason === "" || block.warnings.length !== 1) {
            throw new Error("hard capability failure is not explicit");
        }
    },
);
