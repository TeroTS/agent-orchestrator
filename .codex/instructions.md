# Repo-Local Codex Notes

- Use `./scripts/setup` for dependency installation.
- Use `./scripts/verify` for the full local verification path.
- Add new runtime code under the matching feature directory in `src/`.
- Add repo-level guard tests in `test/repository-*.test.ts` when changing
  shipped scripts, layout, or developer tooling.
- Do not edit generated output in `dist/` or `coverage/`.
