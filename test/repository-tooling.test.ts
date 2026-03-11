import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

describe("repository tooling", () => {
  it("ships eslint and prettier scripts with repository config files", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      lint: expect.any(String),
      "lint:fix": expect.any(String),
      format: expect.any(String),
      "format:check": expect.any(String),
    });

    expect(packageJson.devDependencies).toMatchObject({
      eslint: expect.any(String),
      prettier: expect.any(String),
      "@eslint/js": expect.any(String),
      "typescript-eslint": expect.any(String),
    });

    await expect(
      readFile(resolve(repoRoot, "eslint.config.mjs"), "utf8"),
    ).resolves.toContain("typescript-eslint");
    await expect(
      readFile(resolve(repoRoot, ".prettierrc.json"), "utf8"),
    ).resolves.toContain("{");
    await expect(
      readFile(resolve(repoRoot, ".prettierignore"), "utf8"),
    ).resolves.toContain("dist");
  });
});
