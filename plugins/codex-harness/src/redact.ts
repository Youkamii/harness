const secretPatterns = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
];

const sensitiveEnvironmentNames = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /API[_-]?KEY/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_/i,
  /SSH_AUTH_SOCK/i,
  /NPM_CONFIG_.*TOKEN/i,
];

export function redactSecrets(value: string): string {
  return secretPatterns.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function boundedRemoteText(value: string, maxLength = 4_000): string {
  const sanitized = redactSecrets(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (sanitized.length <= maxLength) return sanitized;
  return sanitized.slice(0, maxLength - 18) + "\n[output truncated]";
}

export function sanitizedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) =>
        value !== undefined && !sensitiveEnvironmentNames.some((pattern) => pattern.test(name)),
    ),
  );
}

export function containsLikelySecret(value: string): boolean {
  return secretPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

