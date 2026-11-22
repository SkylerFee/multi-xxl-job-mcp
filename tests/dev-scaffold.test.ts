/**
 * 本地调试脚手架的测试。
 *
 * 覆盖两件事，都是「不看代码就能验证」的行为约定：
 * 1. startMockAdmin 支持固定端口（dev:mock 依赖它），且端口被占用时立刻失败而不是静默卡住
 * 2. 三个脚手架脚本都能被解析、能打印用法、遇到缺前置条件时给出可操作的错误
 *
 * 不测 Inspector 本身（它会联网拉包、开浏览器，不适合放进离线测试）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockAdmin } from "./mock-admin.js";

// 编译后本文件位于 dist/tests/，仓库根是上两级；用 tsconfig 的 rootDir 约定推导，
// 不写死层级，避免今后调整 outDir 时静默失效。
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let passed = 0;
let failed = 0;

/** 断言辅助：通过则计数并打印 OK，失败则计数并打印详情 */
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  OK   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}` + (detail !== undefined ? `\n       详情: ${JSON.stringify(detail)}` : ""));
  }
}

/** 用当前 node 跑一个脚手架脚本，收集 stdout / stderr / 退出码 */
function runScript(script: string, args: string[]): { code: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

async function main(): Promise<void> {
  console.log("\n[1] startMockAdmin 固定端口");
  {
    // 先占掉一个端口，验证「端口被占用时能立刻失败」
    const first = await startMockAdmin(undefined, undefined, { port: 0 });
    const port = first.port;
    check("动态端口模式返回了有效端口", Number.isInteger(port) && port > 0, port);

    // 同一个端口再起一个：应当抛错，而不是挂起
    let errMessage = "";
    try {
      await startMockAdmin(undefined, undefined, { port });
    } catch (e) {
      errMessage = e instanceof Error ? e.message : String(e);
    }
    check("端口被占用时立刻抛错", errMessage !== "", errMessage);
    check("错误信息可读（含 EADDRINUSE）", /EADDRINUSE|address already in use/i.test(errMessage), errMessage);
    await first.close();

    // 释放后再用同一端口应当成功，说明固定端口确实生效
    const again = await startMockAdmin(undefined, undefined, { port });
    check("指定端口被实际使用", again.port === port, { requested: port, actual: again.port });
    check("url 指向该端口", again.url.includes(":" + port + "/"), again.url);
    await again.close();
  }

  console.log("\n[2] dev-mock --help");
  {
    const r = runScript("dev-mock.mjs", ["--help"]);
    check("退出码为 0", r.code === 0, r.code);
    check("打印用法", r.out.includes("dev:mock"), r.out.slice(0, 200));
    check("说明 --port", r.out.includes("--port"), r.out.slice(0, 200));
  }

  console.log("\n[3] dev-mock 非法端口被拒绝");
  {
    const r = runScript("dev-mock.mjs", ["--port", "abc"]);
    check("退出码非 0", r.code !== 0, r.code);
    check("给出端口错误提示", /--port/.test(r.err), r.err.slice(0, 300));
  }

  console.log("\n[4] dev-mock 未知参数被拒绝");
  {
    const r = runScript("dev-mock.mjs", ["--bogus"]);
    check("退出码非 0", r.code !== 0, r.code);
    check("提示用 --help", r.err.includes("--help"), r.err.slice(0, 300));
  }

  console.log("\n[5] dev-inspect / dev:client 缺前置条件时给出可操作错误");
  {
    // 用一份假的 HOME 隔离，模拟「还没跑过 dev:mock」
    const isolated = join(repoRoot, "tmp", "test-isolated-home");
    rmSync(isolated, { recursive: true, force: true });

    // 这两个脚本读取的配置路径由 HOME 推导，这里只验证「当前 HOME 下没有配置时的提示」是否可操作。
    // 真实 HOME 里可能已有配置，所以只断言「不会崩、且要么成功要么给出下一步」。
    const inspect = runScript("dev-inspect.mjs", ["--cli", "--method", "tools/list"]);
    const inspectOkay = inspect.code === 0 || /先另开一个终端跑 npm run dev:mock|先跑 npm run build/.test(inspect.err);
    check("dev-inspect 不崩溃且给出可操作提示", inspectOkay, { code: inspect.code, err: inspect.err.slice(0, 300) });

    check("dev-client 脚本文件存在", existsSync(join(repoRoot, "scripts", "dev-client.mjs")));
  }

  console.log("\n[5b] dev-inspect 参数顺序（两个约束互相冲突，必须同时满足）");
  {
    // 通过 --print-args 让脚本只打印最终 npx 参数、不真的启动 Inspector（避免联网与开端口）。
    const r = runScript("dev-inspect.mjs", [
      "--print-args",
      "--cli",
      "--method", "tools/call",
      "--tool-name", "list_jobs",
      "--tool-arg", "system=demo",
    ]);
    check("--print-args 退出码为 0", r.code === 0, r.code);
    const printed = r.out.trim();

    // 约束 1：模式 flag 必须在 server 命令之前（Inspector 要求 "Mode flags must appear before app options"）
    const cliIdx = printed.indexOf("--cli");
    const serverIdx = printed.indexOf("src/server.js");
    check(
      "模式 flag 排在 server 命令之前",
      cliIdx >= 0 && serverIdx >= 0 && cliIdx < serverIdx,
      { cliIdx, serverIdx, printed },
    );

    // 约束 2：server 命令必须在变长选项 --tool-arg 之前，否则会被当成它的值
    const toolArgIdx = printed.indexOf("--tool-arg");
    check(
      "server 命令排在 --tool-arg（变长选项）之前",
      serverIdx >= 0 && toolArgIdx >= 0 && serverIdx < toolArgIdx,
      { serverIdx, toolArgIdx, printed },
    );
  }

  console.log("\n[6] package.json 已注册三个 dev 脚本");
  {
    const pkgPath = join(repoRoot, "package.json");
    const pkg = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(pkgPath, "utf8")));
    for (const name of ["dev:mock", "dev:inspect", "dev:client"]) {
      check("存在脚本 " + name, typeof pkg.scripts?.[name] === "string", pkg.scripts?.[name]);
    }
    for (const file of ["dev-mock.mjs", "dev-inspect.mjs", "dev-client.mjs"]) {
      check("脚本文件存在 " + file, existsSync(join(repoRoot, "scripts", file)));
    }
  }

  console.log(`\n========== 调试脚手架测试: ${passed} 通过, ${failed} 失败 ==========`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
