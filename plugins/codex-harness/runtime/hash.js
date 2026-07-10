import { createHash } from "node:crypto";
export function canonicalJson(value) {
    return JSON.stringify(sortValue(value));
}
function sortValue(value) {
    if (Array.isArray(value))
        return value.map(sortValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, sortValue(child)]));
    }
    return value;
}
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function hashObject(value) {
    return sha256(canonicalJson(value));
}
//# sourceMappingURL=hash.js.map