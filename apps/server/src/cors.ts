const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:12000",
  "http://localhost:12000"
];

export function buildAllowedOrigins(extraOriginsText = ""): Set<string> {
  const extraOrigins = extraOriginsText
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]);
}

export function isAllowedCorsOrigin(origin: string | undefined, allowedOrigins: Set<string>): boolean {
  if (!origin) return true;
  return allowedOrigins.has(origin);
}
