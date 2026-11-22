#!/usr/bin/env node
/**
 * 本地调试：用官方 MCP Inspector 连本项目的 server。
 *
 * 默认起 Web UI；带 --cli / --tui 时透传给 Inspector。
 * 与 npm start 的区别：Inspector 会完成 initialize 握手，并列出所有工具的
 * schema、支持逐个点选调用，是调参数校验与结果整形最快的路径。
 *
 * 用法：
 *   npm run dev:inspect                       # Web UI（自动开浏览器）
 *   npm run dev:inspect -- --cli --method tools/list
 *   npm run dev:inspect -- --cli --method tools/call --tool-name list_instances
 *   npm run dev:inspect -- --tui
 *
 * 默认用 tmp/dev-home 作为 HOME（由 dev:mock 生成配置），
 * 这样 Mock 与 Inspector 看到的是同一份配置，互不干扰真实环境。
 * 如需连真实调度中心，用 --real-home 让它读你的 ~/.config。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const debugHome = join(repoRoot, "tmp", "dev-home");
const serverEntry = join(repoRoot, "dist", "src", "server.js");

/** 解析本脚本自己的参数；其余原样透传给 Inspector */
function parseArgs(argv) {
  const passthrough = [];
  let realHome = false;
  for (const arg of argv) {
    if (arg === "--real-home") {
      realHome = true;
    } else {
      passthrough.push(arg);
    }
  }
  return { passthrough, realHome };
}

async function main() {
  const { passthrough, realHome } = parseArgs(process.argv.slice(2));

  if (!existsSync(serverEntry)) {
    console.error("[dev:inspect] 找不到 " + serverEntry);
    console.error("[dev:inspect] 先跑 npm run build");
    process.exitCode = 1;
    return;
  }

  const configPath = join(debugHome, ".config", "multi-xxl-job-mcp", "config.yaml");
  if (!realHome && !existsSync(configPath)) {
    console.error("[dev:inspect] 缺少调试配置: " + configPath);
    console.error("[dev:inspect] 先另开一个终端跑 npm run dev:mock（它会写这份配置）");
    console.error("[dev:inspect] 或改用真实配置: npm run dev:inspect -- --real-home");
    process.exitCode = 1;
    return;
  }

  const env = { ...process.env };
  if (!realHome) {
    // 只改 HOME：配置路径由 resolveConfigPath 走 $XDG_CONFIG_HOME 或 ~/.config，
    // 这里保证 ~/.config 落到隔离目录。
    env.HOME = debugHome;
    // 清掉可能存在的 XDG_CONFIG_HOME，否则它会盖过 HOME
    delete env.XDG_CONFIG_HOME;
  }
  // npx 的包缓存在沙箱下不可写，指向仓库内缓存
  env.npm_config_cache = join(repoRoot, "tmp", "npm-cache");
  // Inspector 默认把密钥写进文件（无 OS keychain 时是明文）。调试场景没有需要长期保存的
  // 密钥，改用内存存储，既避免明文落盘，也免掉每次启动的一串警告。用户显式设置时不覆盖。
  env.MCP_INSPECTOR_SECRET_STORE = env.MCP_INSPECTOR_SECRET_STORE ?? "memory";

  // Inspector 的位置参数才是「被测 server 的启动命令」，必须放在最后；
  // 用户只需传 Inspector 的开关，server 入口由这里补齐。
  const inspectorArgs = ["--yes", "@modelcontextprotocol/inspector", ...passthrough, process.execPath, serverEntry];

  console.error("[dev:inspect] 配置来源: " + (realHome ? "真实 HOME" : "tmp/dev-home"));
  console.error("[dev:inspect] 启动: npx " + inspectorArgs.slice(1).join(" "));

  const child = spawn(
    "npx",
    inspectorArgs,
    {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  // 把 Inspector 的退出码透传出来，便于在脚本/CI 里判断
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error("[dev:inspect] Inspector 被信号终止: " + signal);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });

  child.on("error", (e) => {
    console.error("[dev:inspect] 启动 Inspector 失败: " + e.message);
    console.error("[dev:inspect] 确认网络可用（npx 需要拉取 @modelcontextprotocol/inspector）");
    process.exitCode = 1;
  });
}

main().catch((e) => {
  console.error("[dev:inspect] 未预期的错误: " + (e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exitCode = 1;
});
