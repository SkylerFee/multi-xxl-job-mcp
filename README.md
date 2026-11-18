# multi-xxl-job-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18.15](https://img.shields.io/badge/node-%3E%3D18.15-green.svg)](https://nodejs.org/)

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
| `list_instances` | 列出所有系统与环境（不含密码），调用其他工具前先查它 |
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

- **Node.js** >= 18.15（低于 18.15 缺少 `Headers.prototype.getSetCookie`，登录会「成功」但存不下 Cookie，
  之后每个请求都报「登录态失效」；详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「已知脆弱点」）
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

| 平台 | 路径 |
|------|------|
| Linux | `$XDG_CONFIG_HOME/multi-xxl-job-mcp/config.yaml`，未设置则 `~/.config/...` |
| macOS | `~/Library/Application Support/multi-xxl-job-mcp/config.yaml` |
| Windows | `%APPDATA%\multi-xxl-job-mcp\config.yaml` |

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

**凭据安全**：任何字段值支持 `${VAR}` 环境变量插值。密码建议写成 `${MY_PASSWORD}` 并在 MCP 客户端的 `env` 里设置——这样配置文件本身不含明文。变量未设置时会直接报错，不会静默用空串登录。文件权限若为组或其他可读，启动时会告警。

### 从旧版本迁移

> **不兼容变更**：旧的 `XXL_JOB_URL` / `XXL_JOB_USERNAME` / `XXL_JOB_PASSWORD` / `XXL_JOB_TIMEOUT_MS` 环境变量**已废弃且不会被读取**。

把它们改写成配置文件的一次性对应关系：

```yaml
# 原来：
#   XXL_JOB_URL=http://127.0.0.1:8080/xxl-job-admin
#   XXL_JOB_USERNAME=admin
#   XXL_JOB_PASSWORD=123456
# 现在：
systems:
  order:            # 系统名可自取
    instances:
      dev:          # 环境名可自取
        url: http://127.0.0.1:8080/xxl-job-admin
        username: admin
        password: 123456
```

改完后，MCP 客户端配置里的 `env` 不再需要这三个变量。

### MCP 客户端配置

在 MCP 客户端（如 Claude Desktop、Cursor、Qoder 等）中添加以下配置：

> **本包暂未发布到 npm**，因此请从源码构建使用。以下配置中的 `command` 指向本地可执行文件。

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
> **发布后**：本包若发布到 npm，则可改回 `npm install -g multi-xxl-job-mcp` / `npx -y multi-xxl-job-mcp@latest`。

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

# 运行
npm start

# 开发模式（自动重新编译）
npm run dev
```

### 测试

```bash
# 冒烟测试（不需要 XXL-JOB，校验工具注册）
npm run smoke

# 配置解析层单元测试（纯函数）
npm run test:config

# 目标注册表单元测试（注入假客户端）
npm run test:registry

# init 子命令单元测试
npm run test:cli

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
│   └── mock-admin.ts     # Mock 服务器
├── docs/
│   ├── ARCHITECTURE.md   # 架构与功能逻辑
│   ├── specs/            # 技术方案
│   └── adr/              # 架构决策记录
├── config.example.yaml   # 配置文件示例
├── package.json
└── tsconfig.json
```

## 技术栈

- **Runtime**: Node.js >= 18.15
- **Language**: TypeScript
- **MCP SDK**: @modelcontextprotocol/sdk
- **Schema Validation**: Zod
- **Transport**: stdio

## 许可证

[MIT](./LICENSE) © 2026
