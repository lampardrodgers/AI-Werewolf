import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AI_CONFIG } from "@langrensha/shared";
import { AIConfigRepository, ConfigValidationError, validateAndNormalizeAIConfig } from "../src/configStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("AI config store", () => {
  it("rejects malformed structures, duplicate ids, bad references, URLs, and numeric ranges", () => {
    expect(() => validateAndNormalizeAIConfig({})).toThrow(ConfigValidationError);

    const duplicateProvider = structuredClone(DEFAULT_AI_CONFIG);
    duplicateProvider.providers.push({ ...duplicateProvider.providers[0] });
    expect(() => validateAndNormalizeAIConfig(duplicateProvider)).toThrow("provider id 重复");

    const missingModel = structuredClone(DEFAULT_AI_CONFIG);
    missingModel.personas[0].defaultModel = "missing-model";
    expect(() => validateAndNormalizeAIConfig(missingModel)).toThrow("指向不存在的模型");

    const invalidUrl = structuredClone(DEFAULT_AI_CONFIG);
    invalidUrl.providers[0].baseUrl = "file:///tmp/secret";
    expect(() => validateAndNormalizeAIConfig(invalidUrl)).toThrow("只允许 http、https 或 mock");

    const invalidRateLimit = structuredClone(DEFAULT_AI_CONFIG);
    invalidRateLimit.providers[0].rateLimit.rpm = Number.NaN;
    expect(() => validateAndNormalizeAIConfig(invalidRateLimit)).toThrow("rateLimit.rpm");
  });

  it("serializes atomic writes and recovers a corrupted primary from last-known-good", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langrensha-config-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "ai-config.json");
    const repository = new AIConfigRepository(configPath);
    const first = structuredClone(DEFAULT_AI_CONFIG);
    first.providers[0].name = "First";
    const second = structuredClone(DEFAULT_AI_CONFIG);
    second.providers[0].name = "Second";

    await Promise.all([repository.save(first), repository.save(second)]);
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).providers[0].name).toBe("Second");
    expect(JSON.parse(await fs.readFile(repository.backupPath, "utf8")).providers[0].name).toBe("Second");
    expect((await fs.readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);

    await fs.writeFile(configPath, "{truncated", "utf8");
    const recovered = await repository.load();
    expect(recovered.providers[0].name).toBe("Second");
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).providers[0].name).toBe("Second");
  });

  it("creates a last-known-good backup when loading an existing valid config", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langrensha-config-existing-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "ai-config.json");
    await fs.writeFile(configPath, `${JSON.stringify(DEFAULT_AI_CONFIG, null, 2)}\n`, "utf8");
    const repository = new AIConfigRepository(configPath);

    const loaded = await repository.load();

    expect(loaded).toEqual(DEFAULT_AI_CONFIG);
    expect(JSON.parse(await fs.readFile(repository.backupPath, "utf8"))).toEqual(DEFAULT_AI_CONFIG);
  });
});
