# AGENTS.md

本文件是本仓库的 agent 协作约定。用户级偏好见 `~/.dsh/AGENTS.md`，此处只记录仓库特有的事实。

## 项目速览

`multi-xxl-job-mcp` —— 通过 MCP 协议（stdio 传输）让 AI 助手管理 XXL-JOB 调度中心的 MCP Server。fork 自 `shaguocgl/mcp-xxl-job`，现独立维护。

- 语言/运行时：TypeScript + Node.js >= 18（ESM，`module: NodeNext`）
- 关键依赖：`@modelcontextprotocol/sdk`、`zod`
- 源码：`src/server.ts`（13 个工具注册）、`src/registry.ts`（`(system,env)` → 客户端）、
  `src/cli.ts`（init 子命令）、`src/client.ts`（Admin HTTP 客户端 + 登录 Cookie）、
  `src/config.ts`（配置解析/插值/校验/平台路径）、`src/models.ts`（数据结构与校验）
- 测试：4 个离线测试文件共 161 项断言 —— `config.test.ts`(31)、`registry.test.ts`(53)、
  `cli.test.ts`(36)、`integration.ts`(41)；另有 `smoke.ts`(13 工具) 与
  `test-client.ts`(需真实 Admin)、`mock-admin.ts`(Mock 服务器实现)

## 常用命令

```bash
npm install             # 依赖
npm run build           # tsc -> dist/
npm run smoke           # 13 个工具注册 + 双参数校验
npm run test:config     # 配置解析层（纯函数）
npm run test:registry   # 目标注册表（注入假客户端）
npm run test:cli        # init 子命令
npm run test:integration # 全链路，两个 Mock 目标，验证隔离
npm run test:client      # 只读联调，需已生成配置 + 可达的真实 Admin
```

> **沙箱注意**：本机 npm 全局缓存在 `~/.npm`，在 workspace-write 沙箱下不可写，直接 `npm install`
> 会报 `EPERM ... _cacache`。改用工作区内缓存：
> `npm install --cache ./tmp/npm-cache --no-audit --no-fund`。

## 开发流程（强制）

**任何修改都必须走完整流程，禁止直接向 `master` 提交。** `master` 是发布线，只接受经过评审的合并。

### 五步流程

1. **建分支** —— 从最新 `master` 切出，命名遵循下表
2. **开发** —— 小步提交，提交信息用 Conventional Commits
3. **验证** —— 本地跑完「验证清单」，全绿才能继续
4. **提 PR** —— 推送分支并开 PR，正文说明问题、改动、验证方式
5. **合并** —— 等 CI 全绿后合并（squash），并删除远程分支

```bash
# 1. 建分支（先同步主干）
git switch master && git pull
git switch -c fix/unify-server-identity

# 2-3. 开发并本地验证
npm run build && npm run smoke && npm run test:integration

# 4. 提 PR
git push -u origin fix/unify-server-identity
gh pr create --base master --head fix/unify-server-identity \
  --title 'fix: 简述改动' --body-file tmp/pr-body.md

# 5. 等 CI 通过后合并
gh pr checks --watch
gh pr merge <number> --squash --delete-branch
```

### 分支命名

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feat/` | 新功能 | `feat/multi-instance-support` |
| `fix/` | 缺陷修复 | `fix/node-18-getsetcookie` |
| `docs/` | 仅文档 | `docs/architecture-notes` |
| `chore/` | 依赖、配置、CI | `chore/bump-sdk` |
| `refactor/` | 不改行为的重构 | `refactor/client-request-layer` |

### 验证清单

合并前本地必须全部通过：

```bash
npm run build             # 类型检查与编译
npm run smoke             # 工具注册完整性
npm run test:integration  # 全链路，自带 Mock Admin
```

改动涉及真实 Admin 行为时，再补跑 `npm run test:client`（需 `XXL_JOB_*` 环境变量，只读）。

改动涉及 MCP 握手标识、启动日志时，额外验证实际启动（用临时 HOME 隔离，避免读你真实配置）：

```bash
export TMPHOME=$(mktemp -d)
printf '\n\n\n\npass\n' | HOME="$TMPHOME" node dist/src/server.js init >/dev/null 2>&1
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"1"}}}' \
  | HOME="$TMPHOME" node dist/src/server.js 2>/dev/null | head -c 300
rm -rf "$TMPHOME"
```

### 合并方式

- **squash merge**，一个 PR 对应主干上的一个提交
- 合并后删除远程分支；本地分支可保留至确认无误
- 依赖升级由 Dependabot 开 PR，同样走 CI

### 例外

只有以下情况可以直接在 `master` 上操作，且事后告知：

- 回滚一次已经把主干弄坏的错误合并（用 `git revert`，不要 force push）
- 仓库初始化、首次提交这类不存在评审对象的情形

**其余一律走分支 + PR。** 拿不准时按流程走——多开一个 PR 的成本远低于污染发布线。

## 改动约定

- 新增/修改 MCP 工具时，同步更新三处：`src/server.ts` 的 `registerTool`、
  `tests/smoke.ts` 的 `EXPECTED_TOOLS`、`README.md` 的工具表。
- 改任务配置走「读取-合并-写回」（`jobToForm`），避免 update 接口丢字段。
- 函数必须有说明注释，关键判定入口与结果要有日志。

## 文档地图

按你想解决的问题选入口：

| 你想知道 | 读这个 |
|---|---|
| 这东西是干什么的、怎么配、怎么装 | [README.md](README.md) |
| **架构怎么搭的、每个工具背后发生什么、哪里有坑** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 某个调度术语到底指什么 | [GLOSSARY.md](GLOSSARY.md) |
| 为什么某个地方要写得这么绕 | [docs/adr/](docs/adr/) |
| issue 记在哪、标签怎么用 | [docs/agents/](docs/agents/) |

**动手改代码之前先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「已知脆弱点」一节**，那里列的 5 条是已验证的真实缺陷，别在不知情的情况下踩上去或重复「修复」。

## 代码导航（CodeGraph）

本仓库已用 CodeGraph 建索引（`.codegraph/`，8 个文件 / 208 节点 / 492 边）。
定位代码、理解调用关系时**优先**用它，而不是 grep/read 逐层翻：

```bash
codegraph explore "XxlJobClient login session cookie"   # 一次拿到相关源码 + 调用路径 + 影响面
codegraph node <symbol>          # 单个符号的源码 + 调用者/被调用者
codegraph callers <symbol>       # 谁调用了它
codegraph impact <symbol>        # 改动会影响哪些代码
codegraph sync                   # 增量同步（改完代码后运行）
codegraph index                  # 全量重建
codegraph status                 # 索引统计
```

MCP 工具 `codegraph_explore` 等可用，但本会话启动时无默认项目，需传
`projectPath=/Users/liufei/Projects/multi-xxl-job-mcp`。

`.codegraph/` 下的数据库是本机产物，`.codegraph/.gitignore` 已忽略除自身外的全部文件——
**这个 .gitignore 文件本身应当提交**，其余不要提交。

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`SkylerFee/multi-xxl-job-mcp`), operated with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped 1:1 to the same label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
