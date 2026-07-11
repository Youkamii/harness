export interface RepoContext {
    root: string;
    gitCommonDir: string;
    stateRoot: string;
}
export declare function discoverRepo(cwd: string): Promise<RepoContext>;
export declare function workspaceFingerprint(repoRoot: string): Promise<string>;
/** Resolve an existing candidate and reject symlink or junction escapes from root. */
export declare function realpathWithin(root: string, candidate: string): Promise<string>;
export declare function assertWithin(root: string, candidate: string): void;
