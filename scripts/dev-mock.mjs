#!/usr/bin/env node
/**
 * 本地调试：起一个 Mock XXL-JOB Admin，供 MCP Inspector / test:client 连。
 *
 * 与集成测试里的用法不同，这里用**固定端口**并**自动写一份临时配置**，
 * 目的是让「起 Mock → 起 Inspector」两步就能直接连上，中间不用手抄地址。
 *
 * 用法：
 *   npm run build && npm run dev:mock
 *   npm run dev:mock -- --port 18080
 *   npm run dev:mock -- --no-config      # 只起服务，不写配置文件
 *
 * 输出：
 *   - Mock 地址：http://127.0.0.1:<port>/xxl-job-admin
 *   - 配置路径：<配置根>/multi-xxl-job-mcp/config.yaml（内容指向该 Mock）
 *
 * 注意：配置文件默认写在**仓库内的 tmp/dev-home/**，不碰你真实的 ~/.config。
 * 后续连 Inspector 时用 dev:inspect 会自动带上同一个 HOME。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// 调试用的隔离 HOME，与仓库共享，已被 .gitignore 覆盖（tmp/）
const debugHome = join(repoRoot, "tmp", "dev-home");

const DEFAULT_PORT = 18080;
const MOCK_USER = "admin";
const MOCK_PASS = "mock-pass";

/** 解析命令行参数：--port <n> / --no-config / --help */
function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, writeConfig: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--no-config") {
      opts.writeConfig = false;
    } else if (arg === "--port") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error("--port 需要 1-65535 之间的整数，收到: " + raw);
      }
      opts.port = parsed;
    } else if (arg.startsWith("--port=")) {
      const parsed = Number(arg.slice("--port=".length));
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error("--port 需要 1-65535 之间的整数，收到: " + arg);
      }
      opts.port = parsed;
    } else {
      throw new Error("未知参数: " + arg + "（用 --help 看用法）");
    }
  }
  return opts;
}

/**
 * 渲染调试用配置：两个环境都指向同一个 Mock。
 *
 * 刻意给两个 env，是因为本项目最核心的机制是「同目标复用、跨目标隔离」，
 * 单环境配置看不出这条主线的行为。
 */
function renderConfig(mockUrl) {
  return [
    "# 由 npm run dev:mock 自动生成，仅供本地调试，不要提交。",
    "# 两个环境指向同一个 Mock，便于验证跨目标隔离（会话互不影响）。",
    "systems:",
    "  demo:",
    "    alias: 本地调试",
    "    instances:",
    "      dev:",
    "        url: " + mockUrl,
    "        username: " + MOCK_USER,
    "        password: " + MOCK_PASS,
    "      prod:",
    "        url: " + mockUrl,
    "        username: " + MOCK_USER,
    "        password: " + MOCK_PASS,
  ].join("\n") + "\n";
}

/** 把调试配置写到隔离 HOME 下，返回配置路径 */
function writeDebugConfig(mockUrl) {
  const configPath = join(debugHome, ".config", "multi-xxl-job-mcp", "config.yaml");
  mkdirSync(dirname(configPath), { recursive: true });
  // mode 600：配置文件含明文密码，启动时会校验权限，644 会告警
  writeFileSync(configPath, renderConfig(mockUrl), { mode: 0o600 });
  return configPath;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("用法: npm run dev:mock -- [--port <端口>] [--no-config]");
    console.log("  --port <端口>   Mock Admin 监听端口，默认 " + DEFAULT_PORT);
    console.log("  --no-config     只起 Mock，不写调试配置文件");
    return;
  }

  // 动态 import：只有真要起 Mock 时才加载 dist 产物，--help 不必先 build
  const { startMockAdmin } = await import("../dist/tests/mock-admin.js");

  let admin;
  try {
    admin = await startMockAdmin(MOCK_USER, MOCK_PASS, { port: opts.port });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dev:mock] 启动失败: " + msg);
    if (msg.includes("EADDRINUSE")) {
      console.error("[dev:mock] 端口 " + opts.port + " 已被占用，换一个：npm run dev:mock -- --port 18081");
    } else {
      console.error("[dev:mock] 若提示找不到 dist/tests/mock-admin.js，先跑 npm run build");
    }
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("[dev:mock] Mock XXL-JOB Admin 已启动");
  console.log("  地址: " + admin.url);
  console.log("  账号: " + MOCK_USER + " / " + MOCK_PASS);

  if (opts.writeConfig) {
    try {
      const configPath = writeDebugConfig(admin.url);
      console.log("  配置: " + configPath);
      console.log("        （HOME 已隔离到 tmp/dev-home，不影响真实配置）");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[dev:mock] 写调试配置失败: " + msg);
      process.exitCode = 1;
    }
  }

  // 下一步提示：把可复制的命令直接打出来，省掉一次查文档
  console.log("");
  console.log("下一步：");
  console.log("  图形界面  npm run dev:inspect");
  console.log("  命令行    npm run dev:inspect -- --cli --method tools/list");
  console.log("  只读联调  npm run dev:client");
  console.log("");
  console.log("按 Ctrl-C 停止。");

  // 优雅退出：先关 HTTP server，再让进程自然结束
  const shutdown = async () => {
    console.log("");
    console.log("[dev:mock] 正在关闭 Mock Admin…");
    await admin.close();
    console.log("[dev:mock] 已关闭");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[dev:mock] 未预期的错误: " + (e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exitCode = 1;
});
