# riscv-isa-manual-cn

[English](README.md) | 简体中文

官方 [RISC-V 指令集手册](https://github.com/riscv/riscv-isa-manual) 的中英双语阅读器、全文检索与版本差异对比工具，支持自动同步上游提交与 AI 翻译。

- **`riscv-isa-manual-cn`** *(本仓库)*：命令行工具与静态网页阅读器。
- **`riscv-isa-manual-cn-data`** *(数据仓库)*：译文文件、术语表、版本清单与 GitHub Pages 站点部署。

## 快速体验（离线演示）

环境依赖：[Bun](https://bun.sh/) 和 `git`：

```bash
bun run setup
bun run dev --upstream fixture --provider mock
```

以上命令会自动生成 `.env`、启用 Git 钩子、使用内置离线示例数据与模拟翻译器（无需 API Key），并在 `http://localhost:5173` 启动阅读器。

## 校对与编辑译文

1. 在 `.env` 中配置数据仓库（设置 `DATA_REPO=<owner>/riscv-isa-manual-cn-data`，或指向本地目录 `DATA_DIR=../riscv-isa-manual-cn-data`）。
2. 启动支持热更新的本地阅读器：
   ```bash
   bun run dev
   ```
3. 编辑 `units/<prefix>/<unit_id>.toml`（校对 `zh` 后将 `status` 改为 `"approved"`）或 `GLOSSARY.md`，保存后页面会自动刷新。
4. 在数据仓库提交或发起 Pull Request 前执行校验：
   ```bash
   bun run validate
   ```

## 同步上游与 AI 翻译

1. 在 `.env` 中填入大模型 API Key 与 `DATA_REPO`（默认使用 `AI_PROVIDER=openai` 和 `gpt-6-luna`，可通过 `OPENAI_BASE_URL` 接入任意 OpenAI 兼容接口；本地命令行也支持 `deepseek`、`google`、`anthropic`）：
   ```dotenv
   OPENAI_API_KEY=...
   # OPENAI_BASE_URL=https://api.example.com/v1
   DATA_REPO=<owner>/riscv-isa-manual-cn-data
   ```
2. 同步上游提交并执行翻译：
   ```bash
   bun run sync                   # 完整同步并翻译
   bun run sync --max-batches 2   # 限制批次用于小规模测试
   bun run sync --max-minutes 15  # 运行 15 分钟后自动保存检查点并退出
   ```
3. 使用 `bun run dev` 本地检查效果后，如需推送数据仓库提交：
   ```bash
   bun run publish:data --yes
   ```

## 常用命令

| 命令 | 说明 |
|---|---|
| `bun run setup` | 安装依赖、按需创建 `.env`、启用 Git 钩子并初始化工作区 |
| `bun run dev` | 启动基于 `DATA_DIR` 的热更新开发阅读器 |
| `bun run sync` | 拉取上游更新、更新版本清单并翻译缺失单元 |
| `bun run validate` | 校验 `GLOSSARY.md`、版本清单与全部译文 TOML |
| `bun run build` | 构建用于 GitHub Pages 的静态站点至 `packages/viewer/dist` |
| `bun run preview` | 本地预览已构建的静态站点 |
| `bun run publish:data --yes` | 将数据仓库已提交的更改推送至 `origin` |
| `bun run check` | 运行类型检查、全部测试及离线端到端演练 |
| `bun run config` | 查看当前生效配置及其来源（自动隐藏密钥） |

## 在 GitHub 上部署（CI 与 Pages）

1. **初始化并推送数据仓库**（公开仓库 `<owner>/riscv-isa-manual-cn-data`）：
   ```bash
   bun run workspace --baseline-date 2025-05-08
   cd .work/data
   git remote add origin git@github.com:<owner>/riscv-isa-manual-cn-data.git
   git push -u origin main
   ```
2. **开启 GitHub Pages**：在 `<owner>/riscv-isa-manual-cn-data` 进入 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。
3. **配置 Actions Secrets**：在 `<owner>/riscv-isa-manual-cn` 的 **Settings → Secrets and variables → Actions** 中添加：
   - `DATA_REPO_TOKEN`：仅授权给 `<owner>/riscv-isa-manual-cn-data` 的 Fine-grained PAT，权限选择 **Contents: Read and write** 与 **Actions: Read and write**。
   - `OPENAI_API_KEY`：OpenAI 或 OpenAI 兼容接口的 API Key。
   - `OPENAI_BASE_URL` *（可选）*：自定义接口地址（若无需保密，也可设为 Repository Variable）。
   - `LANGSMITH_API_KEY` *（可选）*：开启 LangSmith 追踪时需要。
   - `DOTENV` *（可选）*：多行 `.env` 覆盖配置。
4. **可选 Repository Variables**（在 `<owner>/riscv-isa-manual-cn` 的 **Settings → Secrets and variables → Actions → Variables** 中配置；`<owner>/riscv-isa-manual-cn-data` 无需任何密钥或变量）：
   - 模型与接口：`AI_MODEL`、`OPENAI_BASE_URL` / `AI_BASE_URL`、`AI_CONCURRENCY`、`AI_REASONING_EFFORT`、`AI_MAX_INPUT_TOKENS`、`AI_MAX_OUTPUT_TOKENS`
   - 同步控制：`SYNC_MAX_MINUTES`（默认 `45`）、`SYNC_MAX_BATCHES`、`BASELINE_DATE`、`DATA_REPO`（默认 `<owner>/riscv-isa-manual-cn-data`）、`VERBOSE`
   - LangSmith 追踪：`LANGSMITH_TRACING`、`LANGSMITH_ENDPOINT`、`LANGSMITH_AGENT_ID`
5. 进入 **Actions → Sync Upstream & Translate → Run workflow**（建议先将 `max_batches` 设为 `1` 试跑一次），验证自动同步与 Pages 部署流程。

## 参与贡献与许可协议

- 执行 `bun install` 时会自动启用 `.githooks/`（`commit-msg` 强制检查 [约定式提交](https://www.conventionalcommits.org/zh-hans/)，`pre-push` 在推送前运行 `bun run check`）。
- 本仓库代码采用 [GNU Affero General Public License v3.0](LICENSE)（`AGPL-3.0-or-later`）开源。
- 数据仓库 `riscv-isa-manual-cn-data` 中的译文与改编内容基于 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 发布，版权归属包含对 RISC-V International 的署名。
