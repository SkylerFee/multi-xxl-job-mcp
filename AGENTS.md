# AGENTS.md

本文件是本仓库的 agent 协作约定。用户级偏好见 `~/.dsh/AGENTS.md`，此处只记录仓库特有的事实。

## 项目速览

`multi-xxl-job-mcp` —— 通过 MCP 协议（stdio 传输）让 AI 助手管理 XXL-JOB 调度中心的 MCP Server。fork 自 `shaguocgl/mcp-xxl-job`，现独立维护。

- 语言/运行时：TypeScript + Node.js >= 18（ESM，`module: NodeNext`）
- 关键依赖：`@modelcontextprotocol/sdk`、`zod`
- 源码：`src/server.ts`（工具注册）、`src/client.ts`（Admin HTTP 客户端 + 登录 Cookie）、
  `src/config.ts`（环境变量）、`src/models.ts`（数据结构与校验）
- 测试：`tests/smoke.ts`（InMemoryTransport 校验工具注册）、
  `tests/integration.ts`（自带 Mock Admin，全链路 23 项断言）、
  `tests/test-client.ts`（只读联调，需真实 Admin）、`tests/mock-admin.ts`（Mock 服务器实现）

## 常用命令

```bash
npm install            # 依赖
npm run build          # tsc -> dist/
npm run smoke          # 冒烟测试，无需 XXL-JOB
npm run test:integration  # 全链路集成测试，自带 Mock Admin，无需真实实例
npm run test:client       # 只读联调，需真实 Admin + XXL_JOB_* 环境变量
```

> **沙箱注意**：本机 npm 全局缓存在 `~/.npm`，在 workspace-write 沙箱下不可写，直接 `npm install`
> 会报 `EPERM ... _cacache`。改用工作区内缓存：
> `npm install --cache ./tmp/npm-cache --no-audit --no-fund`。

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
