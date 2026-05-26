const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173"
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
