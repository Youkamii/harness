export declare function redactSecrets(value: string): string;
export declare function boundedRemoteText(value: string, maxLength?: number): string;
export declare function sanitizedEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function containsLikelySecret(value: string): boolean;
