export { AppModifier, type AppModifierOptions, type Verifier, type VerifyInput, type VerifyResult } from "./modifier.ts";
export { createDockerVerifier, locateDocker, verifyCommand } from "./verify.ts";
export { launchWatchdog, WATCHDOG_SOURCE, type RestartPlan } from "./watchdog.ts";
