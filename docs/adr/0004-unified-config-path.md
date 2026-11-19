# 配置文件路径三个平台统一用 ~/.config，不按平台原生惯例

早期实现按各平台惯例分三套路径：Linux 用 XDG 的 `~/.config`、macOS 用 `~/Library/Application Support`、Windows 用 `%APPDATA%`。现已改为三平台统一 `$XDG_CONFIG_HOME/multi-xxl-job-mcp/config.yaml`（未设置则为 `~/.config/...`）。

**为什么改**：分三套路径的代价在写文档和排查问题时都会显现。

- 文档要维护一张三行表，用户跨平台时要重新记一遍位置
- 在 Mac 上遇到问题，无法照着 Linux 同事给的路径去找
- 团队混用系统时，配置位置没有共同参照

`~/Library/Application Support` 是 Apple 给 **GUI 应用**的惯例，不是给命令行工具的。同类工具几乎没有遵守它：`gh`、`opencode`、`redis-mcp`（一个同样做多连接配置的 MCP server）都用 `~/.config`。本项目的形态更接近这些工具。

**代价**：macOS 上不符合 Apple 官方惯例。SIP 与沙盒化的 GUI 应用确实该用 Application Support，但本工具是 stdio 子进程，不属于那一类。

**仍然尊重 `XDG_CONFIG_HOME`**：想放到自定义位置（如同步盘）的人可以设这个变量，不必依赖平台判断。

**迁移**：旧路径不静默失效。启动时若新路径无配置且旧路径有，错误信息会打印旧文件位置与可直接执行的 `mv` 命令——升级不该变成「配置突然读不到」的哑谜。
