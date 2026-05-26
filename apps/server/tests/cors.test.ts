import { describe, expect, it } from "vitest";
import { buildAllowedOrigins, isAllowedCorsOrigin } from "../src/cors";

describe("server CORS allowlist", () => {
  it("allows same-process requests and local web origins", () => {
    const allowedOrigins = buildAllowedOrigins();

    expect(isAllowedCorsOrigin(undefined, allowedOrigins)).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:5173", allowedOrigins)).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:5173", allowedOrigins)).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:4173", allowedOrigins)).toBe(true);
  });

  it("rejects arbitrary websites unless explicitly configured", () => {
    const allowedOrigins = buildAllowedOrigins("https://game.example.com");

    expect(isAllowedCorsOrigin("https://evil.example", allowedOrigins)).toBe(false);
    expect(isAllowedCorsOrigin("https://game.example.com", allowedOrigins)).toBe(true);
  });
});
