# multi-xxl-job-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 26](https://img.shields.io/badge/node-%3E%3D26-green.svg)](https://nodejs.org/)

MCP Server for [XXL-JOB](https://github.com/xuxueli/xxl-job) Admin — 通过 MCP 协议让 AI 助手直接管理 XXL-JOB 定时任务。

**GitHub Repository：[multi-xxl-job-mcp](https://github.com/SkylerFee/multi-xxl-job-mcp)**

> 本项目 fork 自 [shaguocgl/mcp-xxl-job](https://github.com/shaguocgl/mcp-xxl-job)，
> 在上游基础上更名为 `multi-xxl-job-mcp` 并独立维护。上游的 npm 包与 Glama 收录均与本项目无关。

## 功能特性

- **执行器组管理** — 查询执行器组列表及在线机器地址
- **任务全生命周期** — 查询、新增、修改、删除、启动、停止定时任务
- **手动触发执行** — 支持覆盖运行参数、指定执行器地址
- **调度预演** — 根据 Cron 表达式预演未来触发时间
- **执行日志** — 分页查询调度记录，增量拉取日志正文
- **安全设计** — 自动登录、Cookie 会话维护、失效自动重登
- **防字段丢失** — 修改任务采用「读取-合并-写回」策略

## 提供的 MCP 工具

除 `list_instances` 外，**每个工具都必须传 `system` 与 `env` 指定目标**——这是刻意设计：定时任务上的误操作（尤其删除）不可恢复，显式寻址保证不会「忘记切换环境」。

| 工具 | 功能 |
|------|------|
| `list_instances` | 列出所有系统与环境（**不含任何账号密码**），调用其他工具前先查它 |
| `list_job_groups` | 分页查询执行器组列表 |
| `list_jobs` | 分页查询任务列表（支持按执行器组、状态、描述等过滤） |
| `get_job` | 查询单个任务完整配置 |
| `add_job` | 新增任务（支持 CRON / FIX_RATE / NONE 调度类型） |
| `update_job` | 修改任务配置（未传入字段保持原值） |
| `remove_job` | 删除任务 |
| `start_job` | 启动任务调度 |
| `stop_job` | 停止任务调度 |
| `trigger_job` | 手动触发一次执行 |
| `preview_next_trigger_times` | 预演未来触发时间 |
| `list_job_logs` | 分页查询执行日志 |
| `get_job_log_content` | 增量拉取日志正文 |

## 环境要求

- **Node.js** >= 26（版本基准见 `.node-version`，与 CI 保持一致）
  > 不承诺向下兼容更低的 Node 版本。历史上曾需要 >= 18.15（低于该版本缺少
  > `Headers.prototype.getSetCookie`，登录会「成功」但存不下 Cookie），现在整体以当前开发版本为基线。
- **XXL-JOB Admin** >= 2.3.0


## 配置

### 核心概念

配置是**两层结构**：业务系统（system）→ 环境（env）。

| 概念 | 含义 |
|------|------|
| **系统** | 一个业务系统，如 `order`、`payment`；即工具调用的 `system` 参数 |
| **环境** | 某系统下的一套调度中心连接，如 `dev`、`prod`；即 `env` 参数 |
| **目标** | `system` + `env` 唯一确定的一个 XXL-JOB 调度中心 |
| **别名** | 系统的可读名称（如「订单系统」），**仅用于展示，不参与寻址** |

一个 `system` 可以有任意多套 `env`，每套指向独立的调度中心，会话与登录态彼此隔离。

### 生成配置文件

```bash
multi-xxl-job-mcp init
```

交互式生成到手头无需记忆的路径（各平台自动判定）：

**三个平台使用同一路径**：

```
$XDG_CONFIG_HOME/multi-xxl-job-mcp/config.yaml
```

未设置 `XDG_CONFIG_HOME` 时即 `~/.config/multi-xxl-job-mcp/config.yaml`（Windows 下 `~` 为 `%USERPROFILE%`）。

不按平台分三套路径是刻意的：macOS 的 `Application Support` 是 GUI 应用惯例，命令行工具普遍不用它（`gh`、`opencode`、`redis-mcp` 都是 `~/.config`）。统一之后文档只写一条路径，跨平台排查时也能照着别人的路径去找。


服务启动时会打印实际读取的绝对路径。完整示例见 [config.example.yaml](./config.example.yaml)。

### 配置文件格式

YAML 为主，也兼容 JSON（同一解析器）。最小示例：

```yaml
systems:
  order:
    alias: 订单系统
    instances:
      dev:
        url: http://127.0.0.1:8080/xxl-job-admin
        username: admin
        password: 123456
      prod:
        url: https://order-xxl.example.com/xxl-job-admin
        username: ${ORDER_PROD_USER}
        password: ${ORDER_PROD_PASS}
        timeoutMs: 30000
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | ✅ | 调度中心地址，结尾斜杠会被去掉 |
| `username` | ✅ | 登录用户名 |
| `password` | ✅ | 登录密码 |
| `timeoutMs` | ❌ | HTTP 超时（毫秒），默认 15000 |
| `alias` | ❌ | 系统别名，仅展示；不校验唯一性 |

**命名规则**：`system` 与 `env` 键名只能包含字母、数字、下划线和连字符。

**凭据安全**：工具输出与日志里**不会出现账号密码**——`list_instances` 只返回寻址信息，
若 url 里内嵌了 `user:pass@`，展示时会自动剥离（并以 `urlCredentialsEmbedded: true` 提示你纠正该写法）。

任何字段值支持 `${VAR}` 环境变量插值。密码建议写成 `${MY_PASSWORD}` 并在 MCP 客户端的 `env` 里设置——这样配置文件本身不含明文。变量未设置时会直接报错，不会静默用空串登录。文件权限若为组或其他可读，启动时会告警。

### MCP 客户端配置

在 MCP 客户端（如 Claude Desktop、Cursor、Qoder 等）中添加以下配置：

安装方式二选一。

**方式一：npm 安装（推荐）**

```bash
# 正式版
npm install -g @skylerfee/multi-xxl-job-mcp

# 预览版（beta 通道）
npm install -g @skylerfee/multi-xxl-job-mcp@beta

# 或直接运行，不安装
npx -y @skylerfee/multi-xxl-job-mcp@latest
```

**方式二：从源码构建**（需要改代码或调试时）

```bash
git clone https://github.com/SkylerFee/multi-xxl-job-mcp.git
cd multi-xxl-job-mcp
npm install && npm run build && npm link
```

下面的客户端配置以源码方式为例；若用 npm 安装，`command` 直接写 `multi-xxl-job-mcp` 即可。

**方式一：全局 link（推荐）**

克隆并构建，然后用 `npm link` 把命令注册到全局：

```bash
git clone https://github.com/SkylerFee/multi-xxl-job-mcp.git
cd multi-xxl-job-mcp
npm install
npm run build
npm link          # 之后任意位置可直接执行 multi-xxl-job-mcp
```

> **升级**：拉取代码后重新构建即可，无需重新 link：
> ```bash
> git pull && npm install && npm run build
> ```

配置：

```json
{
  "mcpServers": {
    "xxl-job": {
      "command": "multi-xxl-job-mcp"
      // 无需 env：连接信息全部来自配置文件
      // 若配置文件里用了 ${VAR} 插值，在此处设置对应变量，例如：
      // "env": { "ORDER_PROD_USER": "admin", "ORDER_PROD_PASS": "<密码>" }
    }
  }
}
```

**方式二：直接指向构建产物（无需 link）**

如果不想污染全局命令，直接把 `command` 写成 `node` + 指向构建产物的绝对路径：

```json
{
  "mcpServers": {
    "xxl-job": {
      "command": "node",
      "args": ["/绝对路径/multi-xxl-job-mcp/dist/src/server.js"]
      // 连接信息来自配置文件，无需 env
    }
  }
}
```

> **提示**：Windows 下路径需使用正斜杠或双反斜杠，例如 `C:/tools/multi-xxl-job-mcp/dist/src/server.js`。
> **发布流程**：见 [docs/RELEASING.md](docs/RELEASING.md)。采用 npm Trusted Publishing（OIDC），
> 仓库里不存任何 npm token。

## 使用示例

配置完成后，你可以用自然语言让 AI 助手操作 XXL-JOB。由于每个工具都需要目标，最好在提问时带上系统和环境：

```
列出所有可用的系统和环境
```

```
查询 order 系统 dev 环境有哪些定时任务
```

```
对比 order 系统在 dev 和 prod 的任务配置差异
```

```
新增一个任务：order 系统 dev 环境，执行器组=demo-server，描述=数据同步，Cron=0 0 2 * * ? *，Handler=syncJobHandler
```

```
停止 order 系统 dev 环境中 id=5 的任务调度
```

```
查看 order 系统 prod 环境里 id=3 的任务最近 10 条执行日志
```

```
预演 Cron 表达式 0 0/30 * * * ? 在 prod 环境的未来触发时间
```

## 开发

```bash
# 克隆项目
git clone https://github.com/SkylerFee/multi-xxl-job-mcp.git
cd multi-xxl-job-mcp

# 安装依赖
npm install

# 编译
npm run build

# 代码检查（ESLint，规则见 eslint.config.js；仅本地执行，CI 不跑）
npm run lint

# 运行
npm start

# 开发模式（自动重新编译）
npm run dev
```

### 本地调试（Mock + Inspector）

三个脚手架脚本，覆盖「没有真实调度中心」时的全部调试需求。**都要求先 `npm run build`**。

```bash
# 1. 起一个 Mock XXL-JOB Admin（固定端口 18080，并发一份隔离的调试配置）
npm run dev:mock
npm run dev:mock -- --port 18081      # 换端口（18080 被占用时）
npm run dev:mock -- --no-config       # 只起服务，不写配置文件
```

`dev:mock` 做两件事：

- 在 `127.0.0.1:18080` 起 Mock Admin（账号 `admin` / `mock-pass`）
- 往 `tmp/dev-home/.config/multi-xxl-job-mcp/config.yaml` 写一份配置，含 `demo/dev` 与 `demo/prod`
  **两个环境指向同一个 Mock**——这样能验证「同目标复用、跨目标隔离」这条主线；单环境看不出。

> 配置文件写在 `tmp/dev-home/`（已被 `.gitignore` 覆盖），**不会碰你真实的 `~/.config`**。

```bash
# 2. 用官方 MCP Inspector 调试（另开一个终端）
npm run dev:inspect                                        # Web UI，自动开浏览器
npm run dev:inspect -- --tui                               # 终端交互界面
npm run dev:inspect -- --cli --method tools/list           # 列出全部工具与 schema
npm run dev:inspect -- --cli --method tools/call --tool-name list_instances
npm run dev:inspect -- --cli --method tools/call --tool-name list_jobs \
  --tool-arg system=demo --tool-arg env=dev --tool-arg page=1 --tool-arg pageSize=5

# 3. 对 Mock 跑只读联调（等价 test:client，但不用手动设 HOME）
npm run dev:client                    # demo/dev
npm run dev:client -- demo prod       # 指定 system env
```

`dev:inspect` 会自动把参数摆成 Inspector 要求的顺序，你只写自己的开关即可：

- **模式 flag**（`--cli` / `--tui` / `--web`）排在最前 —— Inspector 的硬性要求
- **server 启动命令**排在变长选项之前 —— `--tool-arg` 这类选项会一直吞掉后续 token，
  server 命令若在其后将报 `Invalid parameter format: /path/to/node`

排查参数问题时用 `--print-args` 只打印最终命令、不启动 Inspector：

```bash
npm run dev:inspect -- --print-args --cli --method tools/call --tool-name list_jobs --tool-arg system=demo
```

`dev:inspect` 与 `dev:client` 默认读 `tmp/dev-home` 的配置，与 `dev:mock` 保持一致。
要连真实调度中心时加 `--real-home`，它们就会读你 `~/.config` 里的配置：

```bash
npm run dev:inspect -- --real-home
npm run dev:client -- --real-home
```

**为什么 Inspector 不进 devDependencies**：它是调试便利工具，`npx` 按需拉取即可。
装进依赖会让 `node_modules` 多出一大坨、拉长 `npm ci`，而它对运行和测试都没有必要。
脚本里已把 `npm_config_cache` 指到 `tmp/npm-cache`，沙箱下也能正常拉包。

> **schema 可移植性自检**：`npm run smoke` 会扫描所有工具的 inputSchema，拒绝 `type: ["number","string"]`
> 这类数组写法。它合法但不可移植——把 tool schema 映射到单一 `type` 方言的客户端（如 Gemini
> function declarations 用的 OpenAPI 子集）可能拒收整个工具或静默丢约束。需要多类型时用 `anyOf`。
>
> **断点调试**：`node --inspect-brk dist/src/server.js`，然后 Chrome 打开 `chrome://inspect` attach。
> 改代码时另开一个终端跑 `npm run dev`（`tsc --watch`）。
> ⚠️ stdio 模式下 **stdout 是 JSON-RPC 协议通道**，调试输出只能走 `console.error`，否则会污染协议流。

### 测试

```bash
# 一次跑完所有离线测试（自动遍历 package.json 里的 test:* 脚本，跳过需真实 Admin 的 test:client）
npm test

# 也可以单独跑：
# 冒烟测试（不需要 XXL-JOB，校验工具注册）
npm run smoke

# 配置解析层单元测试（纯函数）
npm run test:config

# 目标注册表单元测试（注入假客户端）
npm run test:registry

# init 子命令单元测试
npm run test:cli

# 本地调试脚手架的测试（固定端口、参数校验）
npm run test:dev

# 全链路集成测试（两个 Mock 目标，验证目标隔离）
npm run test:integration

# 只读联调（需已生成配置文件 + 可达的真实调度中心）
npm run test:client                                  # 默认 order/dev
node dist/tests/test-client.js payment prod           # 指定系统与环境
```

## 项目结构

```
multi-xxl-job-mcp/
├── src/
│   ├── server.ts      # MCP 服务入口，注册所有工具
│   ├── registry.ts    # 目标注册表：(system, env) -> 带登录态的客户端
│   ├── cli.ts         # init 子命令
│   ├── client.ts      # XXL-JOB Admin HTTP 客户端
│   ├── config.ts      # 配置文件解析、插值、校验、平台路径
│   └── models.ts      # 数据结构与校验逻辑
├── tests/
│   ├── config.test.ts    # 配置解析层单元测试
│   ├── registry.test.ts  # 目标注册表单元测试
│   ├── cli.test.ts       # init 子命令单元测试
│   ├── smoke.ts          # 冒烟测试（工具注册 + 双参数校验）
│   ├── integration.ts    # 集成测试（两个 Mock 目标）
│   ├── test-client.ts    # 真实环境只读联调
│   ├── regression.test.ts   # 已修复脆弱点的回归测试
│   ├── dev-scaffold.test.ts # 本地调试脚手架的测试
│   └── mock-admin.ts     # Mock 服务器
├── docs/
│   ├── ARCHITECTURE.md   # 架构与功能逻辑
│   ├── specs/            # 技术方案
│   └── adr/              # 架构决策记录
├── scripts/
│   ├── test-all.mjs      # 串行跑尽 package.json 里所有 test:* 脚本
│   ├── dev-mock.mjs      # 本地调试：起 Mock Admin + 写隔离配置
│   ├── dev-inspect.mjs   # 本地调试：官方 MCP Inspector 的便捷入口
│   └── dev-client.mjs    # 本地调试：对 Mock 跑只读联调
├── eslint.config.js      # ESLint flat config
├── config.example.yaml   # 配置文件示例
├── package.json
└── tsconfig.json
```

## 技术栈

- **Runtime**: Node.js >= 26（见 `.node-version`）
- **Language**: TypeScript
- **MCP SDK**: @modelcontextprotocol/sdk
- **Schema Validation**: Zod
- **Transport**: stdio

## 许可证

[MIT](./LICENSE) © 2026