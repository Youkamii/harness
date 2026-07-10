import type { RunState } from "./domain.js";
import { RunStore } from "./store.js";
export declare function integrateRun(store: RunStore, runId: string): Promise<RunState>;
export declare function assertIntegrationState(state: RunState): Promise<void>;
export declare function discardIntegration(store: RunStore, runId: string): Promise<RunState>;
