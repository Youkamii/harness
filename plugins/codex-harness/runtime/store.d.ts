import type { Lane, RunState } from "./domain.js";
export declare class RunStore {
    readonly root: string;
    private readonly runsRoot;
    private readonly lockPath;
    constructor(root: string);
    initialize(): Promise<void>;
    create(input: {
        goal: string;
        lane: Lane;
        repoRoot: string;
        gitCommonDir: string;
        now?: Date;
    }): Promise<RunState>;
    load(runId: string): Promise<RunState>;
    currentRunId(): Promise<string | undefined>;
    update(runId: string, type: string, mutate: (state: RunState) => RunState, payload: unknown): Promise<RunState>;
    private persist;
    private verifyJournal;
    private runDir;
    private withLock;
}
