# multi-xxl-job-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)

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

| 工具 | 功能 |
|------|------|
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

- **Node.js** >= 18
- **XXL-JOB Admin** >= 2.3.0


## 配置

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `XXL_JOB_URL` | ✅ | 调度中心地址，如 `http://127.0.0.1:8080/xxl-job-admin` |
| `XXL_JOB_USERNAME` | ✅ | 登录用户名 |
| `XXL_JOB_PASSWORD` | ✅ | 登录密码 |
| `XXL_JOB_TIMEOUT_MS` | ❌ | HTTP 超时（毫秒），默认 15000 |

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
      "command": "multi-xxl-job-mcp",
      "env": {
        "XXL_JOB_URL": "http://127.0.0.1:8080/xxl-job-admin",
        "XXL_JOB_USERNAME": "admin",
        "XXL_JOB_PASSWORD": "<你的调度中心密码>"
      }
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
      "args": ["/绝对路径/multi-xxl-job-mcp/dist/src/server.js"],
      "env": {
        "XXL_JOB_URL": "http://127.0.0.1:8080/xxl-job-admin",
        "XXL_JOB_USERNAME": "admin",
        "XXL_JOB_PASSWORD": "<你的调度中心密码>"
      }
    }
  }
}
```

> **提示**：Windows 下路径需使用正斜杠或双反斜杠，例如 `C:/tools/multi-xxl-job-mcp/dist/src/server.js`。
> **发布后**：本包若发布到 npm，则可改回 `npm install -g multi-xxl-job-mcp` / `npx -y multi-xxl-job-mcp@latest`。

## 使用示例

配置完成后，你可以用自然语言让 AI 助手操作 XXL-JOB：

```
查询当前有哪些定时任务
```

```
新增一个任务：执行器组=demo-server，描述=数据同步，Cron=0 0 2 * * ? *，Handler=syncJobHandler
```

```
停止任务 id=5 的调度
```

```
查看任务 id=3 最近 10 条执行日志
```

```
预演 Cron 表达式 0 0/30 * * * ? 的未来触发时间
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

# 全链路集成测试（自带 Mock Admin，不需要真实实例）
npm run test:integration

# 只读联调（需真实 XXL-JOB + XXL_JOB_* 环境变量）
npm run test:client
```

## 项目结构

```
multi-xxl-job-mcp/
├── src/
│   ├── server.ts      # MCP 服务入口，注册所有工具
│   ├── client.ts      # XXL-JOB Admin HTTP 客户端
│   ├── config.ts      # 环境变量配置加载
│   └── models.ts      # 数据结构与校验逻辑
├── tests/
│   ├── smoke.ts       # 冒烟测试
│   ├── integration.ts # 集成测试
│   ├── test-client.ts # 客户端测试
│   └── mock-admin.ts  # Mock 服务器
├── package.json
├── tsconfig.json
└── .env.example       # 环境变量示例
```

## 技术栈

- **Runtime**: Node.js >= 18
- **Language**: TypeScript
- **MCP SDK**: @modelcontextprotocol/sdk
- **Schema Validation**: Zod
- **Transport**: stdio

## 许可证

[MIT](./LICENSE) © 2026
