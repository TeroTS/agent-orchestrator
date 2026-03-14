import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

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
      typecheck: expect.any(String),
      "test:coverage": expect.any(String),
    });

    expect(packageJson.devDependencies).toMatchObject({
      eslint: expect.any(String),
      prettier: expect.any(String),
      "@eslint/js": expect.any(String),
      "typescript-eslint": expect.any(String),
      "@vitest/coverage-v8": expect.any(String),
    });

    await expect(
      readFile(resolve(repoRoot, "eslint.config.mjs"), "utf8"),
    ).resolves.toContain("typescript-eslint");
    await expect(
      readFile(resolve(repoRoot, ".prettierrc.json"), "utf8"),
    ).resolves.toContain("{");
    await expect(
      readFile(resolve(repoRoot, ".prettierignore"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("coverage"));
    await expect(
      readFile(resolve(repoRoot, ".gitignore"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("coverage"));
    await expect(
      readFile(resolve(repoRoot, "vitest.config.ts"), "utf8"),
    ).resolves.toContain("coverage");
    await expect(
      readFile(resolve(repoRoot, "scripts/setup"), "utf8"),
    ).resolves.toContain("npm ci");
    await expect(
      readFile(resolve(repoRoot, "scripts/verify"), "utf8"),
    ).resolves.toContain("npm run format:check");
    await expect(
      readFile(resolve(repoRoot, "scripts/verify"), "utf8"),
    ).resolves.toContain("npm run typecheck");
    await expect(
      readFile(resolve(repoRoot, ".nvmrc"), "utf8"),
    ).resolves.toMatch(/^24\.\d+\.\d+\s*$/);
    await expect(
      readFile(resolve(repoRoot, ".github/workflows/make-all.yml"), "utf8"),
    ).resolves.toContain("actions/checkout@v5");
    await expect(
      readFile(resolve(repoRoot, ".github/workflows/make-all.yml"), "utf8"),
    ).resolves.toContain("actions/setup-node@v5");
    await expect(
      readFile(resolve(repoRoot, "AGENTS.md"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("./scripts/setup"));
    await expect(
      readFile(resolve(repoRoot, "AGENTS.md"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("./scripts/verify"));
    await expect(
      readFile(resolve(repoRoot, ".github/pull_request_template.md"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("`./scripts/verify`"));
    await expect(
      readFile(resolve(repoRoot, ".github/pull_request_template.md"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("Linear Issue:"));
    await expect(
      readFile(
        resolve(repoRoot, ".github/workflows/github-review.yml"),
        "utf8",
      ),
    ).resolves.toEqual(expect.stringContaining("workflow_run"));
    await expect(
      readFile(
        resolve(repoRoot, ".github/workflows/github-review.yml"),
        "utf8",
      ),
    ).resolves.toEqual(expect.stringContaining('workflows: ["make-all"]'));
    await expect(
      readFile(
        resolve(repoRoot, ".github/workflows/github-review.yml"),
        "utf8",
      ),
    ).resolves.toEqual(expect.stringContaining("pull_request"));
    await expect(
      readFile(
        resolve(repoRoot, ".github/workflows/pr-description-lint.yml"),
        "utf8",
      ),
    ).resolves.toEqual(expect.stringContaining("Linear Issue:"));
    await expect(
      readFile(resolve(repoRoot, ".codex/skills/push/SKILL.md"), "utf8"),
    ).resolves.toEqual(expect.not.stringContaining("scripts/publish-pr.mjs"));
    await expect(
      readFile(resolve(repoRoot, ".codex/skills/push/SKILL.md"), "utf8"),
    ).resolves.toEqual(
      expect.stringContaining(
        'gh pr list --repo "$repo" --head "$branch" --state open',
      ),
    );
    await expect(
      readFile(resolve(repoRoot, ".codex/skills/push/SKILL.md"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("git status --porcelain"));
    await expect(
      readFile(resolve(repoRoot, ".codex/skills/push/SKILL.md"), "utf8"),
    ).resolves.toEqual(
      expect.stringContaining(
        "gh repo view --json nameWithOwner -q .nameWithOwner",
      ),
    );
    await expect(
      readFile(resolve(repoRoot, ".codex/skills/push/SKILL.md"), "utf8"),
    ).resolves.toEqual(
      expect.stringContaining(
        'gh pr create --repo "$repo" --base main --head "$branch"',
      ),
    );
    await expect(
      readFile(resolve(repoRoot, ".codex/skills/push/SKILL.md"), "utf8"),
    ).resolves.toEqual(
      expect.stringContaining('gh pr view --repo "$repo" --json url -q .url'),
    );
    await expect(
      readFile(resolve(repoRoot, ".codex/skills/push/SKILL.md"), "utf8"),
    ).resolves.toEqual(
      expect.stringContaining("Do not run bare `gh pr create`"),
    );
    await expect(
      readFile(resolve(repoRoot, ".npmrc"), "utf8"),
    ).resolves.toMatch(/^registry=https:\/\/registry\.npmjs\.org\/\s*$/m);
    await expect(
      readFile(resolve(repoRoot, "package-lock.json"), "utf8"),
    ).resolves.not.toContain("mavenproxy.aktia.biz");
  });
});
