# Changelog

本项目的重要变更记录在此。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-24

首个正式版本。此前有 `0.1.0-beta.1` 与 `0.1.0-beta.2` 两个预览版。

### 核心能力

- **多系统 × 多环境**：配置为 `systems.<system>` → `instances.<env>` 两层结构，
  每个目标独立持有登录态，跨系统/跨环境操作无需重启进程。
- **13 个 MCP 工具**：执行器组查询、任务增删改查、启停、手动触发、调度预演、
  执行日志分页与正文增量拉取。
- **显式寻址**：除 `list_instances` 外每个工具都必须传 `system` + `env`。
  删除等误操作不可恢复，显式寻址避免「忘记切换环境」。
- **会话管理**：自动登录、Cookie 维护、失效后自动重登一次（只一次，避免密码错时死循环）。
- **读取-合并-写回**：`update_job` 先取全量配置再覆盖显式传入的字段，
  避免 Admin 的整体覆盖语义抹掉 `JobHandler` 等字段。

### 安装与配置

- `init` 子命令交互式生成配置文件，支持在同一次会话里**连续添加多个环境/系统**，
  结束时一次性写入（中途 Ctrl-D 不会留下写了一半的配置）。
- `add` 子命令在已有配置上追加环境或系统，只改目标节点，其余内容原样保留。
- `help` 子命令列出全部命令、配置文件路径与退出码约定。
- 配置文件路径三平台统一为 `$XDG_CONFIG_HOME/multi-xxl-job-mcp/config.yaml`
  （未设置时为 `~/.config/...`）。
- 字段值支持 `${VAR}` 环境变量插值，变量缺失时直接报错而非用空串登录。

### 安全

- **工具输出与日志不含凭据**：`list_instances` 只返回寻址信息，不返回用户名与密码；
  URL 里内嵌的 `user:pass@` 会被剥离并以 `urlCredentialsEmbedded` 提示纠正。
- 同一脱敏逻辑覆盖三个渠道：工具输出、启动日志、请求失败的错误信息。
- 配置文件权限过宽（非 600）时启动告警，`init` 生成的文件固定为 600。

### 发布工程

- npm 发布走 **Trusted Publishing (OIDC)**，仓库不存任何 npm token。
  发布由 GitHub Release 触发，构建与发布两个 job 分离：
  构建侧无 OIDC 权限（依赖被投毒也发不出去），发布侧不 checkout 仓库（身份被滥用也无代码执行面）。
- 产物按**白名单**校验，新增文件必须显式批准。
- 发布带上 SLSA provenance 签名。

### 开发体验

- `dev:mock` / `dev:inspect` / `dev:client` 三个脚手架：没有真实调度中心时也能完整调试，
  配置隔离在 `tmp/dev-home/`，不碰用户的 `~/.config`。
- 工具 schema 拒绝 `type` 为数组的写法（部分客户端会拒收整个工具），需要多类型时用 `anyOf`。
  该约束由 `npm run smoke` 自动守卫。
- 握手版本号在运行时从 `package.json` 读取，不会与发布版本脱节。

### 已知限制

- 仅支持 `stdio` 传输。
- Node.js 要求 `>= 26`，不承诺向下兼容更低版本。
- 日志正文需依赖调度中心转手从执行器获取，因此 `get_job_log_content`
  必须原样回传 `executorAddress` 与 `triggerTime`。

## [0.1.0-beta.2] - 2026-11-24

### 修复

- 握手版本号改为运行时从 `package.json` 读取。此前硬编码为 `0.0.1`，
  导致发布 `0.1.0-beta.1` 后客户端看到的版本仍是旧值。

## [0.1.0-beta.1] - 2026-11-24

首个预览版，发布到 npm 供早期验证。

[0.1.0]: https://github.com/SkylerFee/multi-xxl-job-mcp/compare/v0.1.0-beta.2...v0.1.0
[0.1.0-beta.2]: https://github.com/SkylerFee/multi-xxl-job-mcp/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/SkylerFee/multi-xxl-job-mcp/releases/tag/v0.1.0-beta.1
