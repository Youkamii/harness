export interface RepoContext {
    root: string;
    gitCommonDir: string;
    stateRoot: string;
}
export declare function discoverRepo(cwd: string): Promise<RepoContext>;
export declare function workspaceFingerprint(repoRoot: string): Promise<string>;
export declare function assertWithin(root: string, candidate: string): void;
