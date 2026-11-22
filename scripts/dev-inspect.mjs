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

/**
 * Inspector 的模式 flag。它必须在**最前**（Inspector 自己的要求：
 * "Mode flags must appear before app options"），否则会被当成 server 命令的一部分。
 */
const MODE_FLAGS = new Set(["--web", "--cli", "--tui"]);

/**
 * 解析本脚本自己的参数，并把 Inspector 的参数拆成三段。
 *
 * 为什么不能简单地「原样透传给 Inspector」：两个约束互相冲突，需要分开摆放。
 *   1. 模式 flag（--cli / --tui / --web）必须排在所有其他参数**之前**；
 *   2. server 启动命令（位置参数）必须排在**变长选项之前**——--tool-arg / --prompt-args /
 *      --metadata 这类选项会一直吞掉后续 token，server 命令若在其后，会被当成某个
 *      --tool-arg 的值，Inspector 报 “Invalid parameter format: /path/to/node”。
 *
 * 最终顺序：modeFlags → server 命令 → 其余选项。
 *
 * @returns {{ modeFlags: string[], rest: string[], realHome: boolean }} 三段参数与本脚本开关
 */
function parseArgs(argv) {
  const modeFlags = [];
  const rest = [];
  let realHome = false;
  let printArgs = false;
  for (const arg of argv) {
    if (arg === "--real-home") {
      realHome = true;
    } else if (arg === "--print-args") {
      printArgs = true;
    } else if (MODE_FLAGS.has(arg)) {
      modeFlags.push(arg);
    } else {
      rest.push(arg);
    }
  }
  return { modeFlags, rest, realHome, printArgs };
}

async function main() {
  const { modeFlags, rest, realHome, printArgs } = parseArgs(process.argv.slice(2));

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

  // 顺序：模式 flag 最前（Inspector 要求）→ server 命令（避免被变长选项吞掉）→ 其余选项
  const inspectorArgs = [
    "--yes",
    "@modelcontextprotocol/inspector",
    ...modeFlags,
    process.execPath,
    serverEntry,
    ...rest,
  ];

  // --print-args：只打印最终参数，不真正启动 Inspector。
  // 用于排查参数顺序问题，以及让测试能在不联网、不开端口的前提下断言顺序。
  if (printArgs) {
    console.log(inspectorArgs.join(" "));
    return;
  }

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
