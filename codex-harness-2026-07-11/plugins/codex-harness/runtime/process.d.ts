export interface ProcessRequest {
    executable: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
}
export interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}
export declare function runProcess(request: ProcessRequest): Promise<ProcessResult>;
export declare function runChecked(request: ProcessRequest): Promise<ProcessResult>;
