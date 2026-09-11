export type CapabilityWarning = {
    code: string;
    message: string;
};

export type CapabilityOutcome =
    | {
          status: "pass";
          warnings: CapabilityWarning[];
      }
    | {
          status: "block";
          reason: string;
          warnings: CapabilityWarning[];
      };

export function passCapability(warnings: CapabilityWarning[] = []): CapabilityOutcome {
    return { status: "pass", warnings };
}

export function blockCapability(reason: string, warnings: CapabilityWarning[] = []): CapabilityOutcome {
    return { status: "block", reason, warnings };
}

/** The only hard gate in this scaffold: the browser must expose a usable WebGPU adapter. */
export async function assessWebGpu(): Promise<CapabilityOutcome> {
    if (typeof navigator === "undefined" || !navigator.gpu) {
        return blockCapability("This browser does not provide WebGPU.");
    }
    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return blockCapability("No compatible WebGPU adapter was found.");
    } catch {
        return blockCapability("WebGPU could not start in this browser.");
    }
    // Screen size, input devices, and peripherals have no S1 thresholds. Future suitability checks can
    // add passable warnings here without changing the blocking shape.
    return passCapability();
}
