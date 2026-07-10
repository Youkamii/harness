interface IsolationProbe {
    codexExecutable: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
}
export declare function assertSandboxNetworkIsolation(options: IsolationProbe): Promise<void>;
export {};
