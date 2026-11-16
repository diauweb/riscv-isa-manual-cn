# Repository Rules

- **Conventional Commits**: Every commit message in this repository must follow Conventional Commits (`<type>[optional scope][!]: <description>`), using one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Enforced by `.githooks/commit-msg`.
- **GitHub Actions Workflows**: Workflows under `.github/workflows/` and `templates/data-repo/.github/workflows/` must only invoke existing `package.json` scripts (`bun run <script>`) and must not embed inline `bun -e` or `node -e` scripts (enforced by `packages/pipeline/test/workflows.test.ts`).
- **Verification**: Run `bun run check` (typecheck, unit/integration tests, and E2E rehearsal) before finishing or pushing changes.
