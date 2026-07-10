import type { HarnessTask, PlannedTask } from "./domain.js";
export declare function validatePlan(tasks: PlannedTask[]): void;
export declare function materializeTasks(tasks: PlannedTask[]): HarnessTask[];
export declare function refreshReadyTasks(tasks: HarnessTask[]): HarnessTask[];
