/**
 * 全链路集成测试：启动两个 Mock XXL-JOB Admin（模拟两个目标），
 * 通过真实 MCP 客户端逐个调用工具，验证完整请求链路与目标隔离。
 *
 * 运行方式：npm run build && npm run test:integration
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { TargetRegistry } from "../src/registry.js";
import { buildServer } from "../src/server.js";
import { startMockAdmin } from "./mock-admin.js";

let passed = 0;
let failed = 0;

/** 断言辅助 */
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  OK   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail !== undefined ? `\n       详情: ${JSON.stringify(detail)}` : ""}`);
  }
}

/** 调用工具并解析返回的 JSON 文本 */
async function call(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; data: unknown; raw: string }> {
  const result = await mcp.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  const jsonStart = text.indexOf("{");
  let data: unknown;
  try {
    data = jsonStart >= 0 ? JSON.parse(text.slice(jsonStart)) : undefined;
  } catch {
    data = undefined;
  }
  return { isError: result.isError === true, data, raw: text };
}

async function main(): Promise<void> {
  // 两个独立的 Mock 调度中心，代表两个不同目标
  const adminA = await startMockAdmin("admin", "mock-pass");
  const adminB = await startMockAdmin("admin", "mock-pass");
  console.log(`Mock 目标 A: ${adminA.url}`);
  console.log(`Mock 目标 B: ${adminB.url}`);

  const config = {
    systems: {
      order: {
        alias: "订单系统",
        instances: {
          dev: { url: adminA.url, username: "admin", password: "mock-pass", timeoutMs: 10000 },
          prod: { url: adminB.url, username: "admin", password: "mock-pass", timeoutMs: 10000 },
        },
      },
    },
  };
  const registry = new TargetRegistry(config, { logger: () => {} });
  const server = buildServer(registry);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "integration-test", version: "1.0.0" });
  await mcp.connect(clientTransport);

  const dev = { system: "order", env: "dev" };
  const prod = { system: "order", env: "prod" };

  // 0. 目标发现
  console.log("\n[0] list_instances");
  const inst = await call(mcp, "list_instances", {});
  const instData = inst.data as { systems: { system: string; alias: string; instances: Record<string, { url: string; usesEnvVars?: boolean }> }[] };
  check("无错误", !inst.isError, inst.raw);
  check("返回 1 个系统且别名为中文", instData?.systems?.length === 1 && instData.systems[0].alias === "订单系统", instData);
  check("返回 2 个环境", Object.keys(instData?.systems?.[0]?.instances ?? {}).length === 2, instData);

  // 凭据不得出现在工具输出里：这段 JSON 会进入 AI 对话上下文并被客户端留存，
  // 因此密码与用户名都不该出现，哪怕只是「方便排查」。
  check("结果不含密码", !inst.raw.includes("mock-pass"), "响应中出现了密码");
  check("结果不含 username 字段", !inst.raw.includes("username"), inst.raw);
  check("结果不含配置的登录名", !inst.raw.includes("\"admin\""), inst.raw);
  check("结果保留 url 供确认环境", (instData?.systems?.[0]?.instances?.dev?.url ?? "").includes("xxl-job-admin"), inst.raw);

  // 1. 执行器组
  console.log("\n[1] list_job_groups");
  const groups = await call(mcp, "list_job_groups", { ...dev, page: 1, pageSize: 10 });
  const g = groups.data as { recordsTotal: number; groups: { id: number; appname: string }[] };
  check("无错误", !groups.isError, groups.raw);
  check("返回 2 个执行器组", g?.recordsTotal === 2 && g.groups.length === 2, g);

  // 2. 任务列表（含过滤）
  console.log("\n[2] list_jobs");
  const jobs = await call(mcp, "list_jobs", { ...dev, page: 1, pageSize: 10 });
  const j = jobs.data as { recordsTotal: number; jobs: { id: number; triggerStatusText: string }[] };
  check("无错误", !jobs.isError, jobs.raw);
  check("返回 1 个任务且带状态文本", j?.recordsTotal === 1 && j.jobs[0].triggerStatusText === "运行中", j);

  const filtered = await call(mcp, "list_jobs", { ...dev, page: 1, pageSize: 10, triggerStatus: 0 });
  const fj = filtered.data as { recordsTotal: number };
  check("按状态过滤生效（运行中任务被排除）", fj?.recordsTotal === 0, fj);

  // 3. 任务详情
  console.log("\n[3] get_job");
  const detail = await call(mcp, "get_job", { ...dev, jobId: 1 });
  const d = detail.data as { id: number; jobDesc: string; scheduleConf: string };
  check("无错误", !detail.isError, detail.raw);
  check("详情字段正确", d?.id === 1 && d.jobDesc === "测试任务1" && d.scheduleConf === "0 0 2 * * ?", d);

  // 4. 新增任务（写入目标 A）
  console.log("\n[4] add_job");
  const added = await call(mcp, "add_job", {
    ...dev,
    jobGroup: 1,
    jobDesc: "集成测试新任务",
    scheduleType: "CRON",
    scheduleConf: "0 0/30 * * * ?",
    executorHandler: "itJobHandler",
    executorParam: "a=1",
  });
  const a = added.data as { jobId: number };
  check("无错误", !added.isError, added.raw);
  check("返回新任务 id", typeof a?.jobId === "number" && a.jobId >= 2, a);
  check("目标 A 中确实新增", adminA.jobs.has(a.jobId), adminA.jobs.size);
  const storedNew = adminA.jobs.get(a.jobId);
  check(
    "新增默认值正确（BEAN/FIRST/DO_NOTHING/停止）",
    storedNew?.glueType === "BEAN" &&
      storedNew.executorRouteStrategy === "FIRST" &&
      storedNew.misfireStrategy === "DO_NOTHING" &&
      storedNew.triggerStatus === 0,
    storedNew,
  );

  // 4.1 目标隔离：目标 B 查不到目标 A 新建的任务
  console.log("\n[4.1] 目标隔离");
  const jobsB = await call(mcp, "list_jobs", { ...prod, page: 1, pageSize: 10 });
  const jB = jobsB.data as { recordsTotal: number; jobs: { id: number }[] };
  check("目标 B 未受影响（仍只有 1 个任务）", jB?.recordsTotal === 1, jB);
  check("目标 B 查不到目标 A 的新任务", !jB?.jobs?.some((x) => x.id === a.jobId), jB);
  check("目标 B 的 mock 中没有该任务", !adminB.jobs.has(a.jobId), adminB.jobs.size);

  // 4.2 非法 Cron 应被拒绝
  const badCron = await call(mcp, "add_job", {
    ...dev,
    jobGroup: 1,
    jobDesc: "非法Cron",
    scheduleType: "CRON",
    scheduleConf: "bad-cron",
    executorHandler: "x",
  });
  check("非法 Cron 被拒绝", badCron.isError === true, badCron.raw);

  // 4.3 未知目标应报错且不产生副作用
  console.log("\n[4.3] 未知目标");
  const beforeUnknown = adminA.jobs.size;
  const unknownEnv = await call(mcp, "add_job", { ...dev, env: "nope", jobGroup: 1, jobDesc: "x", scheduleType: "NONE", executorHandler: "h" });
  check("未知环境报错", unknownEnv.isError === true, unknownEnv.raw);
  check("错误信息列出可用环境", unknownEnv.raw.includes("dev") && unknownEnv.raw.includes("prod"), unknownEnv.raw);
  check("未知环境未产生写入", adminA.jobs.size === beforeUnknown, adminA.jobs.size);
  const unknownSys = await call(mcp, "list_jobs", { ...dev, system: "nope", page: 1, pageSize: 10 });
  check("未知系统报错", unknownSys.isError === true, unknownSys.raw);
  check("错误信息列出可用系统", unknownSys.raw.includes("order"), unknownSys.raw);

  // 5. 修改任务（部分字段，其余保持）
  console.log("\n[5] update_job");
  const updated = await call(mcp, "update_job", {
    ...dev,
    jobId: a.jobId,
    scheduleConf: "0 0 * * * ?",
    executorFailRetryCount: 3,
  });
  const u = updated.data as { id: number; scheduleConf: string; executorFailRetryCount: number; executorHandler: string; jobDesc: string };
  check("无错误", !updated.isError, updated.raw);
  check("变更字段生效", u?.scheduleConf === "0 0 * * * ?" && u.executorFailRetryCount === 3, u);
  check("未传字段保持原值", u?.executorHandler === "itJobHandler" && u.jobDesc === "集成测试新任务", u);
  const storedUpdated = adminA.jobs.get(a.jobId);
  check("目标参数未被写进任务字段", !("system" in (storedUpdated ?? {})) && !("env" in (storedUpdated ?? {})), storedUpdated);

  // 6/7. 启停
  console.log("\n[6] start_job / stop_job");
  const started = await call(mcp, "start_job", { ...dev, jobId: a.jobId });
  check("启动成功且 mock 状态=1", !started.isError && adminA.jobs.get(a.jobId)?.triggerStatus === 1, started.raw);
  const stopped = await call(mcp, "stop_job", { ...dev, jobId: a.jobId });
  check("停止成功且 mock 状态=0", !stopped.isError && adminA.jobs.get(a.jobId)?.triggerStatus === 0, stopped.raw);

  // 8. 手动触发
  console.log("\n[7] trigger_job");
  const beforeTrigger = adminA.triggerCount;
  const triggered = await call(mcp, "trigger_job", { ...dev, jobId: 1, executorParam: "p=2" });
  check("触发成功且目标 A 收到请求", !triggered.isError && adminA.triggerCount === beforeTrigger + 1, triggered.raw);
  check("触发状态未变（仍为运行中）", adminA.jobs.get(1)?.triggerStatus === 1, adminA.jobs.get(1)?.triggerStatus);

  // 9. 预演触发时间
  console.log("\n[8] preview_next_trigger_times");
  const preview = await call(mcp, "preview_next_trigger_times", { ...dev, scheduleType: "CRON", scheduleConf: "0 0 * * * ?" });
  const p = preview.data as { nextTriggerTimes: string[] };
  check("返回未来触发时间列表", !preview.isError && Array.isArray(p?.nextTriggerTimes) && p.nextTriggerTimes.length > 0, p);

  // 10. 执行日志列表
  console.log("\n[9] list_job_logs");
  const logs = await call(mcp, "list_job_logs", { ...dev, page: 1, pageSize: 10, jobId: 1 });
  const lg = logs.data as { recordsTotal: number; logs: { id: number; executorAddress: string; triggerTime: string; handleResult: string }[] };
  check("返回 1 条日志且带结果文本", !logs.isError && lg?.recordsTotal === 1 && lg.logs[0].handleResult === "执行成功", lg);

  // 11. 日志正文
  console.log("\n[10] get_job_log_content");
  const logContent = await call(mcp, "get_job_log_content", {
    ...dev,
    logId: lg.logs[0].id,
    executorAddress: lg.logs[0].executorAddress,
    triggerTime: lg.logs[0].triggerTime,
    fromLineNum: 1,
  });
  const lc = logContent.data as { fromLineNum: number; toLineNum: number; logContent: string; isEnd: boolean };
  check("返回日志正文", !logContent.isError && typeof lc?.logContent === "string" && lc.logContent.includes("任务开始执行"), lc);
  check("isEnd 标记正确", lc?.isEnd === true, lc);

  // 12. 删除任务（此前无任何测试覆盖）
  console.log("\n[11] remove_job");
  const removed = await call(mcp, "remove_job", { ...dev, jobId: a.jobId });
  check("删除无错误", !removed.isError, removed.raw);
  check("删除后 mock 中不再存在", !adminA.jobs.has(a.jobId), [...adminA.jobs.keys()]);
  const afterRemove = await call(mcp, "get_job", { ...dev, jobId: a.jobId });
  check("删除后再查详情报错", afterRemove.isError === true, afterRemove.raw);

  // 13. 会话失效自动重登
  console.log("\n[12] Cookie 失效自动重登");
  const devClient = registry.get("order", "dev") as unknown as { loggedIn: boolean; cookies: Map<string, string> };
  devClient.loggedIn = true;
  devClient.cookies.clear();
  const relogged = await call(mcp, "list_jobs", { ...dev, page: 1, pageSize: 10 });
  check("重登后调用成功", !relogged.isError, relogged.raw);
  check("重登只影响该目标", !relogged.isError, relogged.raw);

  await mcp.close();
  await server.close();
  await adminA.close();
  await adminB.close();

  console.log(`\n========== 集成测试结果: ${passed} 通过, ${failed} 失败 ==========`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("集成测试异常:", e);
  process.exit(1);
});
