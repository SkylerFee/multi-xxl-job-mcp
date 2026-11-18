#!/usr/bin/env node
// 串行执行 package.json 里所有 test:* 脚本（跳过 test:client —— 它需要真实 Admin 与已生成的配置）。
//
// 存在的理由：AGENTS.md 的验证清单以前是手工列举法，新增 test:* 脚本时会漏列、漏跑。
// 这里从 package.json 读取脚本名，因此新增脚本自动被包含，不会漂移。
//
// 用法：先 npm run build（这些脚本执行的是 dist/ 产物），再 npm test。
// 退出码：任一脚本失败即终止，并以该脚本的非零退出码结束。
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根目录：scripts/ 的上一级
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// 明确排除的脚本：需要外部真实环境的联调，不参与离线全量验证
const SKIP = new Set(["test:client"]);

/** 读取 package.json 的 scripts，筛出需要串行执行的 test:* 脚本名（排除 SKIP） */
function collectTestScripts() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const all = Object.keys(pkg.scripts ?? {}).filter((name) => name.startsWith("test:"));
  const selected = all.filter((name) => !SKIP.has(name));
  console.log("[test-all] package.json 里 test:* 共 " + all.length + " 个，本次执行 " + selected.length +
    " 个：" + selected.join(", "));
  return selected;
}

/** 依次执行每个脚本；返回首个失败脚本的退出码，全部通过返回 0 */
function runAll(names) {
  for (const name of names) {
    console.log("\n[test-all] == npm run " + name);
    const result = spawnSync("npm", ["run", "--silent", name], {
      cwd: repoRoot,
      stdio: "inherit",
      // Windows 上 npm 是 npm.cmd，需要交给 shell 解析
      shell: process.platform === "win32",
    });
    if (result.error) {
      console.error("[test-all] 启动失败：npm run " + name + " -> " + result.error.message);
      return 1;
    }
    if (result.status !== 0) {
      console.error("[test-all] 失败：npm run " + name + " 退出码 " + result.status);
      return result.status ?? 1;
    }
    console.log("[test-all] 通过：" + name);
  }
  return 0;
}

const names = collectTestScripts();
if (names.length === 0) {
  console.error("[test-all] 没有找到任何 test:* 脚本，请检查 package.json");
  process.exit(1);
}
const exitCode = runAll(names);
console.log(exitCode === 0
  ? "\n[test-all] 全部通过（" + names.length + " 个脚本）"
  : "\n[test-all] 存在失败项");
process.exit(exitCode);
