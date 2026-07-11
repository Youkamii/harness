import path from "node:path";
const taskIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const deniedCheckExecutables = new Set([
    "bash",
    "cmd",
    "codex",
    "curl",
    "del",
    "gh",
    "git",
    "powershell",
    "pwsh",
    "rm",
    "rmdir",
    "sh",
    "wget",
    "zsh",
]);
export function validatePlan(tasks) {
    if (tasks.length === 0)
        throw new Error("plan must contain at least one task");
    if (tasks.length > 64)
        throw new Error("plan exceeds the 64 task limit");
    const ids = new Set();
    for (const task of tasks) {
        if (!taskIdPattern.test(task.id))
            throw new Error(`invalid task id: ${task.id}`);
        if (ids.has(task.id))
            throw new Error(`duplicate task id: ${task.id}`);
        ids.add(task.id);
        if (task.acceptanceCriteria.length === 0) {
            throw new Error(`task ${task.id} has no acceptance criteria`);
        }
        if (task.acceptanceCriteria.length > 100) {
            throw new Error(`task ${task.id} exceeds the 100 acceptance criterion limit`);
        }
        for (const criterion of task.acceptanceCriteria) {
            const length = [...criterion].length;
            if (length === 0)
                throw new Error(`task ${task.id} has an empty acceptance criterion`);
            if (length > 200) {
                throw new Error(`task ${task.id} has an acceptance criterion longer than 200 characters`);
            }
        }
        if (task.checks.length === 0)
            throw new Error(`task ${task.id} has no verification checks`);
        for (const check of task.checks) {
            if (check.argv.length === 0)
                throw new Error(`task ${task.id} has an empty check command`);
            if (check.argv.some((argument) => argument.includes("\u0000"))) {
                throw new Error(`task ${task.id} check contains a null byte`);
            }
            const executable = path.basename(check.argv[0] ?? "").toLocaleLowerCase("en-US").replace(/\.exe$/, "");
            if (deniedCheckExecutables.has(executable)) {
                throw new Error(`task ${task.id} check uses a forbidden executable: ${executable}`);
            }
            if (check.cwd)
                assertRelativeSafePath(check.cwd, `task ${task.id} check cwd`);
        }
    }
    for (const task of tasks) {
        for (const dependency of task.dependencies) {
            if (!ids.has(dependency))
                throw new Error(`task ${task.id} has missing dependency ${dependency}`);
            if (dependency === task.id)
                throw new Error(`task ${task.id} depends on itself`);
        }
    }
    assertAcyclic(tasks);
    assertDepth(tasks);
    assertOwnedPathsDoNotOverlap(tasks);
}
function assertAcyclic(tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
        if (visiting.has(id))
            throw new Error(`task dependency cycle includes ${id}`);
        if (visited.has(id))
            return;
        visiting.add(id);
        for (const dependency of byId.get(id)?.dependencies ?? [])
            visit(dependency);
        visiting.delete(id);
        visited.add(id);
    }
    for (const task of tasks)
        visit(task.id);
}
function assertOwnedPathsDoNotOverlap(tasks) {
    const owners = new Map();
    for (const task of tasks) {
        for (const rawPath of task.ownedPaths) {
            assertRelativeSafePath(rawPath, "owned path");
            const normalized = path.normalize(rawPath).replaceAll("\\", "/");
            const key = normalized.toLocaleLowerCase("en-US");
            for (const [existing, owner] of owners) {
                if (key === existing ||
                    key.startsWith(existing.endsWith("/") ? existing : existing + "/") ||
                    existing.startsWith(key.endsWith("/") ? key : key + "/")) {
                    throw new Error(`owned path overlap between ${owner} and ${task.id}: ${rawPath}`);
                }
            }
            owners.set(key, task.id);
        }
    }
}
function assertDepth(tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const memo = new Map();
    function depth(id) {
        const cached = memo.get(id);
        if (cached !== undefined)
            return cached;
        const value = 1 + Math.max(0, ...(byId.get(id)?.dependencies.map(depth) ?? []));
        memo.set(id, value);
        return value;
    }
    for (const task of tasks) {
        if (depth(task.id) > 16)
            throw new Error("task dependency depth exceeds 16");
    }
}
function assertRelativeSafePath(value, label) {
    if (!value || value === "." || path.isAbsolute(value)) {
        throw new Error(`${label} must be a non-empty relative path: ${value}`);
    }
    const normalized = path.normalize(value).replaceAll("\\", "/");
    if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
        throw new Error(`${label} escapes repository: ${value}`);
    }
}
export function materializeTasks(tasks) {
    validatePlan(tasks);
    return tasks.map((task) => ({
        ...task,
        status: task.dependencies.length === 0 ? "ready" : "pending",
        attempts: 0,
    }));
}
export function refreshReadyTasks(tasks) {
    const complete = new Set(tasks.filter((task) => task.status === "complete").map((task) => task.id));
    return tasks.map((task) => {
        if (task.status !== "pending")
            return task;
        if (task.dependencies.every((dependency) => complete.has(dependency))) {
            return { ...task, status: "ready" };
        }
        return task;
    });
}
//# sourceMappingURL=graph.js.map