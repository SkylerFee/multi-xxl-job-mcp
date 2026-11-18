# 技术方案：多系统 × 多环境配置

| 项 | 内容 |
|---|---|
| Issue | [#11](https://github.com/SkylerFee/multi-xxl-job-mcp/issues/11) |
| 拆票 | #12 配置解析层 · #13 目标注册表 · #14 查询类工具 · #15 写操作类工具 · #16 init 子命令 · #17 文档同步 |
| 状态 | 设计已定稿，实现未开始 |
| 兼容性 | 不兼容旧环境变量，按新项目开发 |

```
#12 ──┬──> #13 ──┬──> #14 ──┐
      │         └──> #15 ──┼──> #17
      └──> #16 ────────────┘
```

---

## Problem Statement

当前的 MCP server 只能连一个 XXL-JOB 调度中心：进程启动时读取固定环境变量 `XXL_JOB_URL` / `XXL_JOB_USERNAME` / `XXL_JOB_PASSWORD`，13 个工具全部作用于同一个目标。

但实际使用中存在**两个独立维度**：多个业务系统（order / payment / ...）× 多套环境（dev / staging / prod）。使用者无法在一次 MCP 会话里跨系统、跨环境查看和操作任务，只能反复改配置、重启进程。

## Solution

引入「系统 × 环境」的两层配置：一个 YAML 配置文件描述所有系统及其各环境的连接信息，进程启动时一次加载。13 个工具统一增加 `system` 与 `env` 两个必填参数，显式指定本次操作的目标。新增 `list_instances` 工具，按系统分组列出所有可用目标（不含密码），供调用方发现。

配置文件中每个系统可带一个 `alias`（如「订单系统」），仅用于展示和方便记忆，**不参与寻址**。

## User Stories

1. 作为使用 AI 助手管理定时任务的开发者，我想要在一次会话里查询多个业务系统的任务列表，以便不用反复切换 MCP 客户端配置。
2. 作为运维人员，我想要在同一次会话里对比 order 系统在 dev 和 prod 的任务配置，以便确认上线前配置一致。
3. 作为开发者，我想要在配置文件里为每个系统写一个中文别名，以便一眼认出「order」就是订单系统。
4. 作为开发者，我想要在不知道有哪些目标可用时先调用一个列举工具，以便知道该传什么 `system` / `env`。
5. 作为调用方，我想要在传错 `env` 时看到该维度下的可用值列表，以便立即纠正而不是猜。
6. 作为运维人员，我想要 `remove_job` 这类破坏性操作必须显式写明目标，以便避免在错误环境删掉任务。
7. 作为多系统维护者，我想要不同系统使用各自的登录凭据与会话，以便一个系统的登录失效不影响另一个。
8. 作为跨平台用户，我想要配置放在各平台的标准位置，以便不需要记住平台相关的路径差异。
9. 作为安全负责人，我想要密码可以留在环境变量里而不是写进配置文件，以便配置文件即使泄露也不暴露凭据。
10. 作为安全负责人，我想要配置文件权限不当（如 644）时启动就告警或拒绝，以便及时发现风险。
11. 作为首次使用者，我想要一个初始化命令交互式生成配置，以便不用手写 YAML 也能开工。
12. 作为首次使用者，我想要初始化命令在提问时给出默认值，以便一路回车即可完成。
13. 作为配置维护者，我想要配置格式支持注释，以便标注每个系统归属和注意事项。
14. 作为配置维护者，我想要配置文件既可用 YAML 也可用 JSON，以便按习惯选择。
15. 作为排查问题的开发者，我想要启动日志打印实际读取的配置文件绝对路径，以便确认到底读了哪个文件。
16. 作为排查问题的开发者，我想要 `list_instances` 标出哪些系统使用了环境变量插值，以便定位「密码为什么没生效」。
17. 作为配置维护者，我想要结构错误（缺字段、变量未设置）在启动时就报错并拒绝启动，以便问题立即暴露。
18. 作为使用者，我想要某个系统的密码写错时不影响其他系统使用，以便单点故障不扩散。
19. 作为使用者，我想要某个系统登录 401 时只影响该系统，以便继续操作其他系统。
20. 作为配置维护者，我想要系统名与环境名限制为字母数字下划线连字符，以便避免 YAML 键名与调用参数的歧义。
21. 作为跨系统使用者，我想要两个系统可以配置相同的别名而不报错，以便别名只承担提示作用。
22. 作为使用者，我想要 `list_instances` 返回结果不含任何密码，以便安全地展示给 AI。
23. 作为新项目使用者，我想要旧的环境变量不再被静默接受，以便不会误以为配置生效。
24. 作为维护者，我想要建任务的集成测试在两个 mock 目标上验证隔离性，以便确认多目标确实是隔离的。
25. 作为维护者，我想要冒烟测试断言 13 个工具全部注册（含此前遗漏的 `remove_job`），以便新增工具不会被漏测。

## Implementation Decisions

### 概念模型

新增四个领域词，写入 `GLOSSARY.md`：

- **系统（system）**：一个业务系统，对应一组 XXL-JOB 部署的归属
- **环境（env）**：某系统下的一套调度中心连接
- **目标（target）**：由 `system` + `env` 唯一确定的一个调度中心连接
- **别名（alias）**：系统的可读名称，仅用于展示，**不参与寻址**

关键边界：别名不是标识符。它出现在 `list_instances` 输出中，工具调用必须使用真实键名。

### 配置结构

两层嵌套，无 `default` 字段（所有调用强制显式）：

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

- `url` / `username` / `password` 必填；`timeoutMs` 可选，默认 15000
- 所有字符串值支持 `${VAR}` 插值；变量未设置时**报错**，不静默传空串
- `system` 与 `env` 键名均限制 `^[a-zA-Z0-9_-]+$`
- `alias` 不受该限制，且**不校验唯一性**（重名仅显示上不区分）

### 模块划分

- **`config.ts`（重写）**：解析 YAML/JSON、字段插值、两层结构与必填校验、权限检查。暴露 `loadConfig(filePath)` 纯函数与 `resolveConfigPath(platform, env)` 纯函数
- **`registry.ts`（新增）**：`TargetRegistry`，把 `(system, env)` 映射为懒创建的 `XxlJobClient`；同一目标复用同一 client，从而复用其登录态
- **`client.ts`（零改动）**：现有 `cookies` / `loggedIn` / `loggingIn` 均为实例字段，多个 client 天然隔离
- **`server.ts`**：`buildServer(registry)` 替换 `buildServer(client)`；13 个工具增加两个必填参数；新增 `list_instances`
- **`cli.ts`（新增）**：`init` 子命令，交互式生成配置

`registry.ts` 是本次唯一新增的接缝，职责单一：工具层只调用 `registry.get(system, env)`，不接触任何配置解析逻辑。

### 工具接口

所有工具（12 现有 + 1 新增）统一使用两个必填参数：

```json
{ "system": "order", "env": "prod", "jobId": 3 }
```

错误信息必须列出该维度可用值，例如：`未知环境 'prd'（系统 order 下可用：dev, prod）`。

`list_instances` 返回按系统分组的结构，每项含 `url` / `username` / `usesEnvVars`，**不含密码**。

### 配置路径

按平台原生惯例自动判定，不给用户暴露路径概念（用 `init` 生成即可）：

- Linux：`$XDG_CONFIG_HOME/multi-xxl-job-mcp/config.yaml`，未设则 `~/.config/...`
- macOS：`~/Library/Application Support/multi-xxl-job-mcp/config.yaml`
- Windows：`%APPDATA%\multi-xxl-job-mcp\config.yaml`

启动日志打印实际读取的绝对路径。

### 校验时机

| 阶段 | 校验内容 | 失败行为 |
|---|---|---|
| 启动 | 文件可读、语法、结构、必填字段、`${VAR}` 可解析、文件权限 | 拒绝启动，报具体错误 |
| 首次使用某目标 | 登录凭据是否有效 | 该次调用报错，不波及其他目标 |

结构错误立即暴露；凭据错误延迟到使用时，避免一个系统配错导致全部不可用。

### 依赖

新增 `yaml@2.9.1`（ISC 许可，自带类型定义，零运行时依赖，686KB）。YAML 解析器天然支持 JSON，因此兼容 `.json` 零额外成本。

### 不做兼容

按新项目开发，不保留 `XXL_JOB_URL` / `XXL_JOB_USERNAME` / `XXL_JOB_PASSWORD` / `XXL_JOB_TIMEOUT_MS`。检测到这些变量时不静默接受，直接报「缺少配置文件」类错误。

## Testing Decisions

### 好的测试标准

只测外部行为，不测实现细节：输入配置文件或工具参数，断言输出与错误信息。不针对私有方法写测试。

### 四个测试接缝（3 个复用现有，1 个新增）

1. **`buildServer(registry)`** —— 复用现有注入点。测试传入 fake registry，无需真实配置或网络
2. **`loadConfig(filePath)`** —— 纯函数，传临时文件路径，断言返回结构或抛出的错误
3. **`resolveConfigPath(platform, env)`** —— 纯函数，传平台字符串，断言路径，无需改动 `process.platform`
4. **`startMockAdmin()`** —— 复用现有 Mock（已在随机端口），起两个即为两个目标

### 测试清单

| 层 | 用例 | 先例 |
|---|---|---|
| 单元 | YAML 与 JSON 双格式解析 | 无先例，新增 `tests/config.test.ts` |
| 单元 | `${VAR}` 已设置/未设置两种路径 | 同上 |
| 单元 | 缺 url / 缺 password / 空 systems 结构错误 | 同上 |
| 单元 | 三平台路径判定 | 同上 |
| 集成 | order-dev 建任务后，payment-prod 查不到（目标隔离） | `tests/integration.ts` |
| 集成 | 未知 system / 未知 env 的错误含可用值 | `tests/integration.ts` |
| 集成 | `list_instances` 不含密码字段 | `tests/integration.ts` |
| 冒烟 | 13 个工具全部注册（补齐 `remove_job`） | `tests/smoke.ts` |

### 现有测试的改动

`tests/smoke.ts` 与 `tests/integration.ts` 需从 `buildServer(client)` 迁移到 `buildServer(registry)`；断言数从 11 增至 13。

## Out of Scope

- `docs/ARCHITECTURE.md` 记录的 5 个已知脆弱点（Node 版本、HTML 响应二次读取、handleCode 502 映射、remove_job 测试、死代码）
- `package.json` 的 `engines.node` 声明修正（实际需 >= 18.15）
- 配置的 export / import 子命令
- `config validate` 子命令
- 旧环境变量的兼容或自动迁移
- 跨机器同步配置文件的机制

## Further Notes

**破坏性影响**：13 个工具的签名全部改变，属于不兼容变更。项目为 0.0.1 且未发布到 npm，无外部用户受影响。README、`.env.example`、`docs/ARCHITECTURE.md` 需同步更新。

**实现顺序建议**：先做配置层（可在无 server 情况下单测），再做 `registry.ts`，最后改 13 个工具签名。前两步不触碰工具层，可独立验证。

**风险点**：13 个工具逐个改签名是重复性劳动，容易漏改导致某个工具仍读旧逻辑。建议改完后以「13 个工具全部出现在冒烟清单里」作为完成判据。
