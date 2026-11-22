#!/usr/bin/env node
/**
 * 本地调试：对 Mock 目标跑只读联调（tests/test-client.ts 的便捷入口）。
 *
 * 与 npm run test:client 的区别只在 HOME：这里默认用 tmp/dev-home，
 * 也就是 dev:mock 写的那份配置，因此不用手动 export HOME。
 *
 * 用法：
 *   npm run dev:client                       # demo/dev
 *   npm run dev:client -- demo prod          # 指定 system env
 *   npm run dev:client -- --real-home        # 用真实配置（等价 npm run test:client）
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const debugHome = join(repoRoot, "tmp", "dev-home");
const clientEntry = join(repoRoot, "dist", "tests", "test-client.js");

/** 解析参数：--real-home 由本脚本消费，其余（system / env）透传给 test-client */
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

function main() {
  const { passthrough, realHome } = parseArgs(process.argv.slice(2));

  if (!existsSync(clientEntry)) {
    console.error("[dev:client] 找不到 " + clientEntry + "，先跑 npm run build");
    process.exitCode = 1;
    return;
  }

  const env = { ...process.env };
  if (!realHome) {
    const configPath = join(debugHome, ".config", "multi-xxl-job-mcp", "config.yaml");
    if (!existsSync(configPath)) {
      console.error("[dev:client] 缺少调试配置: " + configPath);
      console.error("[dev:client] 先另开终端跑 npm run dev:mock");
      process.exitCode = 1;
      return;
    }
    env.HOME = debugHome;
    delete env.XDG_CONFIG_HOME;
  }

  console.error("[dev:client] 配置来源: " + (realHome ? "真实 HOME" : "tmp/dev-home"));
  // 默认目标与 dev:mock 生成的配置一致
  const args = passthrough.length > 0 ? passthrough : ["demo", "dev"];

  const child = spawn(process.execPath, [clientEntry, ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  child.on("error", (e) => {
    console.error("[dev:client] 启动失败: " + e.message);
    process.exitCode = 1;
  });
}

main();
