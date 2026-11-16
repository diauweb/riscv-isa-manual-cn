# riscv-isa-manual-cn

English | [简体中文](README.zh-CN.md)

Bilingual (English / Simplified Chinese) reader, full-text search, and version-diff viewer for the official [RISC-V Instruction Set Manual](https://github.com/riscv/riscv-isa-manual), with automated upstream sync and AI translation.

- **`riscv-isa-manual-cn`** *(this repository)*: CLI pipeline and static web viewer.
- **`riscv-isa-manual-cn-data`** *(companion data repository)*: translation files, terminology glossary, manifests, and GitHub Pages site.

## Quick Start (Offline Demo)

Requires [Bun](https://bun.sh/) and `git`:

```bash
bun run setup
bun run dev --upstream fixture --provider mock
```

This creates `.env`, enables git hooks, builds a tiny offline demo dataset with zero API keys, and opens the viewer at `http://localhost:5173`.

## Reviewing & Editing Translations

1. Point `.env` to your data repository (either `DATA_REPO=<owner>/riscv-isa-manual-cn-data` or a local checkout `DATA_DIR=../riscv-isa-manual-cn-data`).
2. Start the live-reload viewer:
   ```bash
   bun run dev
   ```
3. Edit `units/<prefix>/<unit_id>.toml` (change `status = "approved"` after reviewing `zh`) or `GLOSSARY.md`. The viewer reloads automatically on save.
4. Validate before committing or opening a pull request on the data repository:
   ```bash
   bun run validate
   ```

## Syncing Upstream & Translating

1. Add your LLM API key and `DATA_REPO` to `.env` (defaults to `AI_PROVIDER=openai` and `gpt-6-luna`, with optional `OPENAI_BASE_URL` for any OpenAI-compatible gateway; the CLI also supports `deepseek`, `google`, and `anthropic`):
   ```dotenv
   OPENAI_API_KEY=...
   # OPENAI_BASE_URL=https://api.example.com/v1
   DATA_REPO=<owner>/riscv-isa-manual-cn-data
   ```
2. Sync upstream commits and run translation:
   ```bash
   bun run sync                   # full run
   bun run sync --max-batches 2   # bounded smoke run
   bun run sync --max-minutes 15  # checkpoint after 15 minutes
   ```
3. Inspect locally with `bun run dev`, then push committed data changes if desired:
   ```bash
   bun run publish:data --yes
   ```

## Commands

| Command | Description |
|---|---|
| `bun run setup` | Install dependencies, create `.env` if missing, enable git hooks, prepare workspace |
| `bun run dev` | Start the viewer dev server with live reload over `DATA_DIR` |
| `bun run sync` | Fetch upstream changes, update manifests, and translate missing units |
| `bun run validate` | Validate `GLOSSARY.md`, manifests, and all TOML translation units |
| `bun run build` | Build the production static site into `packages/viewer/dist` |
| `bun run preview` | Preview the built static site locally |
| `bun run publish:data --yes` | Push committed data-repo changes to `origin` |
| `bun run check` | Run typecheck, unit/integration tests, and an offline end-to-end check |
| `bun run config` | Print resolved settings and where each value came from (secrets redacted) |

## Deploying on GitHub (CI & Pages)

1. **Create & bootstrap the data repository** (`<owner>/riscv-isa-manual-cn-data`, public):
   ```bash
   bun run workspace --baseline-date 2025-05-08
   cd .work/data
   git remote add origin git@github.com:<owner>/riscv-isa-manual-cn-data.git
   git push -u origin main
   ```
2. **Enable GitHub Pages** on `<owner>/riscv-isa-manual-cn-data`: open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. **Add Actions secrets** on `<owner>/riscv-isa-manual-cn` (**Settings → Secrets and variables → Actions**):
   - `DATA_REPO_TOKEN`: fine-grained PAT scoped to `<owner>/riscv-isa-manual-cn-data` with **Contents: Read and write** and **Actions: Read and write**.
   - `OPENAI_API_KEY`: API key for OpenAI or an OpenAI-compatible endpoint.
   - `OPENAI_BASE_URL` *(optional)*: custom base URL if your gateway URL is private (can also be a variable).
   - `LANGSMITH_API_KEY` *(optional)*: if LangSmith tracing is enabled.
   - `DOTENV` *(optional)*: multi-line `.env` overrides.
4. **Optional repository variables** on `<owner>/riscv-isa-manual-cn` (**Settings → Secrets and variables → Actions → Variables**; `<owner>/riscv-isa-manual-cn-data` needs no secrets or variables):
   - Model & gateway: `AI_MODEL`, `OPENAI_BASE_URL` / `AI_BASE_URL`, `AI_CONCURRENCY`, `AI_REASONING_EFFORT`, `AI_MAX_INPUT_TOKENS`, `AI_MAX_OUTPUT_TOKENS`
   - Sync: `SYNC_MAX_MINUTES` (defaults to `45`), `SYNC_MAX_BATCHES`, `BASELINE_DATE`, `DATA_REPO` (defaults to `<owner>/riscv-isa-manual-cn-data`), `VERBOSE`
   - LangSmith: `LANGSMITH_TRACING`, `LANGSMITH_ENDPOINT`, `LANGSMITH_AGENT_ID`
5. Trigger **Actions → Sync Upstream & Translate → Run workflow** (try `max_batches: 1` first) to test the full sync-and-deploy flow.

## Contributing & License

- Git hooks in `.githooks/` are enabled automatically on `bun install` (`commit-msg` enforces [Conventional Commits](https://www.conventionalcommits.org/); `pre-push` runs `bun run check`).
- Code in this repository is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-or-later`).
- Translation data and adapted manual content in `riscv-isa-manual-cn-data` are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) with attribution to RISC-V International.
