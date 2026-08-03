/**
 * 全链路集成测试：启动 Mock XXL-JOB Admin，
 * 通过真实 MCP 客户端逐个调用 11 个工具，验证完整请求链路。
 *
 * 运行方式：npm run build && npm run test:integration
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { XxlJobClient } from "../src/client.js";
import { buildServer } from "../src/server.js";
import { startMockAdmin } from "./mock-admin.js";

let passed = 0;
let failed = 0;

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
async function call(mcp: Client, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; data: unknown; raw: string }> {
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
  const admin = await startMockAdmin("admin", "mock-pass");
  console.log(`Mock Admin 已启动: ${admin.url}`);

  const client = new XxlJobClient({
    baseUrl: admin.url,
    username: "admin",
    password: "mock-pass",
    timeoutMs: 10000,
  });
  const server = buildServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "integration-test", version: "1.0.0" });
  await mcp.connect(clientTransport);

  // 1. 执行器组
  console.log("\n[1] list_job_groups");
  const groups = await call(mcp, "list_job_groups", { page: 1, pageSize: 10 });
  const g = groups.data as { recordsTotal: number; groups: { id: number; appname: string }[] };
  check("无错误", !groups.isError, groups.raw);
  check("返回 2 个执行器组", g?.recordsTotal === 2 && g.groups.length === 2, g);

  // 2. 任务列表（含过滤）
  console.log("\n[2] list_jobs");
  const jobs = await call(mcp, "list_jobs", { page: 1, pageSize: 10 });
  const j = jobs.data as { recordsTotal: number; jobs: { id: number; triggerStatusText: string }[] };
  check("无错误", !jobs.isError, jobs.raw);
  check("返回 1 个任务且带状态文本", j?.recordsTotal === 1 && j.jobs[0].triggerStatusText === "运行中", j);

  const filtered = await call(mcp, "list_jobs", { page: 1, pageSize: 10, triggerStatus: 0 });
  const fj = filtered.data as { recordsTotal: number };
  check("按状态过滤生效（运行中任务被排除）", fj?.recordsTotal === 0, fj);

  // 3. 任务详情
  console.log("\n[3] get_job");
  const detail = await call(mcp, "get_job", { jobId: 1 });
  const d = detail.data as { id: number; jobDesc: string; scheduleConf: string };
  check("无错误", !detail.isError, detail.raw);
  check("详情字段正确", d?.id === 1 && d.jobDesc === "测试任务1" && d.scheduleConf === "0 0 2 * * ?", d);

  // 4. 新增任务
  console.log("\n[4] add_job");
  const added = await call(mcp, "add_job", {
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
  check("mock 中确实新增", admin.jobs.has(a.jobId), admin.jobs.size);
  const storedNew = admin.jobs.get(a.jobId);
  check("新增默认值正确（BEAN/FIRST/DO_NOTHING/停止）",
    storedNew?.glueType === "BEAN" && storedNew.executorRouteStrategy === "FIRST" &&
    storedNew.misfireStrategy === "DO_NOTHING" && storedNew.triggerStatus === 0, storedNew);

  // 4.1 非法 Cron 应被拒绝
  const badCron = await call(mcp, "add_job", {
    jobGroup: 1,
    jobDesc: "非法Cron",
    scheduleType: "CRON",
    scheduleConf: "bad-cron",
    executorHandler: "x",
  });
  check("非法 Cron 被拒绝", badCron.isError === true, badCron.raw);

  // 5. 修改任务（部分字段，其余保持）
  console.log("\n[5] update_job");
  const updated = await call(mcp, "update_job", { jobId: a.jobId, scheduleConf: "0 0 * * * ?", executorFailRetryCount: 3 });
  const u = updated.data as { id: number; scheduleConf: string; executorFailRetryCount: number; executorHandler: string; jobDesc: string };
  check("无错误", !updated.isError, updated.raw);
  check("变更字段生效", u?.scheduleConf === "0 0 * * * ?" && u.executorFailRetryCount === 3, u);
  check("未传字段保持原值", u?.executorHandler === "itJobHandler" && u.jobDesc === "集成测试新任务", u);

  // 6/7. 启停
  console.log("\n[6] start_job / stop_job");
  const started = await call(mcp, "start_job", { jobId: a.jobId });
  check("启动成功且 mock 状态=1", !started.isError && admin.jobs.get(a.jobId)?.triggerStatus === 1, started.raw);
  const stopped = await call(mcp, "stop_job", { jobId: a.jobId });
  check("停止成功且 mock 状态=0", !stopped.isError && admin.jobs.get(a.jobId)?.triggerStatus === 0, stopped.raw);

  // 8. 手动触发
  console.log("\n[7] trigger_job");
  const before = admin.triggerCount;
  const triggered = await call(mcp, "trigger_job", { jobId: 1, executorParam: "p=2" });
  check("触发成功且 mock 收到触发请求", !triggered.isError && admin.triggerCount === before + 1, triggered.raw);

  // 9. 预演触发时间
  console.log("\n[8] preview_next_trigger_times");
  const preview = await call(mcp, "preview_next_trigger_times", { scheduleType: "CRON", scheduleConf: "0 0 * * * ?" });
  const p = preview.data as { nextTriggerTimes: string[] };
  check("返回未来触发时间列表", !preview.isError && Array.isArray(p?.nextTriggerTimes) && p.nextTriggerTimes.length > 0, p);

  // 10. 执行日志列表
  console.log("\n[9] list_job_logs");
  const logs = await call(mcp, "list_job_logs", { page: 1, pageSize: 10, jobId: 1 });
  const lg = logs.data as { recordsTotal: number; logs: { id: number; executorAddress: string; triggerTime: string; handleResult: string }[] };
  check("返回 1 条日志且带结果文本", !logs.isError && lg?.recordsTotal === 1 && lg.logs[0].handleResult === "执行成功", lg);

  // 11. 日志正文
  console.log("\n[10] get_job_log_content");
  const logContent = await call(mcp, "get_job_log_content", {
    logId: lg.logs[0].id,
    executorAddress: lg.logs[0].executorAddress,
    triggerTime: lg.logs[0].triggerTime,
    fromLineNum: 1,
  });
  const lc = logContent.data as { fromLineNum: number; toLineNum: number; logContent: string; isEnd: boolean };
  check("返回日志正文", !logContent.isError && typeof lc?.logContent === "string" && lc.logContent.includes("任务开始执行"), lc);
  check("isEnd 标记正确", lc?.isEnd === true, lc);

  // 会话失效自动重登：保留登录态但清空 Cookie，请求会收到 302 跳登录页，触发自动重登重试
  console.log("\n[11] Cookie 失效自动重登");
  (client as unknown as { loggedIn: boolean }).loggedIn = true;
  (client as unknown as { cookies: Map<string, string> }).cookies.clear();
  const relogged = await call(mcp, "list_jobs", { page: 1, pageSize: 10 });
  check("重登后调用成功", !relogged.isError, relogged.raw);

  await mcp.close();
  await server.close();
  await admin.close();

  console.log(`\n========== 集成测试结果: ${passed} 通过, ${failed} 失败 ==========`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("集成测试异常:", e);
  process.exit(1);
});
