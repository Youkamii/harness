export interface DoctorCheck {
    name: string;
    passed: boolean;
    detail: string;
}
export declare function runDoctor(repoRoot: string): Promise<{
    passed: boolean;
    checks: DoctorCheck[];
}>;
