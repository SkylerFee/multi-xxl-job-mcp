/**
 * 已验证脆弱点的回归测试。
 *
 * 覆盖 docs/ARCHITECTURE.md 「已知脆弱点」中的三条：
 *   A. HTML 响应被读取两次 -> TypeError: Body is unusable
 *   B. handleCode=502（执行超时）被误显示为「未完成」
 *   D. trigger_job 里的 code 检查是死代码
 *
 * A 与 D 通过直接调用 XxlJobClient 验证；B 通过 list_job_logs 工具的输出验证。
 */

import http from "node:http";
import { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { XxlJobClient, XxlJobApiError } from "../src/client.js";
import { XxlJobConfig } from "../src/config.js";
import { TargetRegistry } from "../src/registry.js";
import { buildServer } from "../src/server.js";

let passed = 0;
let failed = 0;

/** 断言辅助：记录通过/失败并输出可读结果 */
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log("  OK   " + name);
  } else {
    failed++;
    console.error("  FAIL " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
  }
}

/** 启动一个可编程的假 Admin，handler 决定每个请求的响应 */
async function startFakeAdmin(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/xxl-job-admin`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function main(): Promise<void> {
  // ----------------------------------------------------------------
  // A: 非登录页的 HTML 响应（如网关 502 页）不应抛 Body is unusable
  // ----------------------------------------------------------------
  console.log("[A] HTML 响应只读取一次");
  const htmlAdmin = await startFakeAdmin((req, res) => {
    if (req.url?.includes("/login")) {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "XXL_JOB_LOGIN_IDENTITY=t; Path=/" });
      res.end(JSON.stringify({ code: 200, msg: null, content: null }));
      return;
    }
    // 模拟网关错误页：text/html，且内容不含 login 字样
    res.writeHead(502, { "Content-Type": "text/html;charset=UTF-8" });
    res.end("<html><body><h1>502 Bad Gateway</h1></body></html>");
  });
  try {
    const cfgA: XxlJobConfig = { baseUrl: htmlAdmin.url, username: "a", password: "b", timeoutMs: 5000 };
    const c = new XxlJobClient(cfgA);
    await c.login();
    let err: unknown;
    try {
      await c.listJobGroups(1, 10);
    } catch (e) {
      err = e;
    }
    const msg = err instanceof Error ? err.message : String(err);
    check("不抛 Body is unusable", !/Body is unusable/.test(msg), msg);
    check("抛的是 XxlJobApiError", err instanceof XxlJobApiError, err instanceof Error ? err.name : typeof err);
    check("错误信息可读且含非 JSON 提示", /非 JSON 内容/.test(msg), msg);
    check("错误片段包含网关页面内容", /502 Bad Gateway/.test(msg), msg);
  } finally {
    await htmlAdmin.close();
  }

  // ----------------------------------------------------------------
  // A2: 登录页 HTML 仍应被识别为未登录并触发重登
  // ----------------------------------------------------------------
  console.log("[A2] 登录页 HTML 仍被识别为未登录");
  let loginCalls = 0;
  const loginPageAdmin = await startFakeAdmin((req, res) => {
    if (req.url?.includes("/login")) {
      loginCalls++;
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "XXL_JOB_LOGIN_IDENTITY=t; Path=/" });
      res.end(JSON.stringify({ code: 200, msg: null, content: null }));
      return;
    }
    const cookie = req.headers.cookie ?? "";
    if (!cookie.includes("XXL_JOB_LOGIN_IDENTITY=t")) {
      // 未登录：返回登录页 HTML（不含 302）
      res.writeHead(200, { "Content-Type": "text/html;charset=UTF-8" });
      res.end('<html><body><form action="/login">请登录</form></body></html>');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ recordsFiltered: 1, data: [{ id: 1 }] }));
  });
  try {
    const cfgA2: XxlJobConfig = { baseUrl: loginPageAdmin.url, username: "a", password: "b", timeoutMs: 5000 };
    const c = new XxlJobClient(cfgA2);
    const result = await c.listJobGroups(1, 10);
    check("登录页 HTML 触发重登后成功", result.data.length === 1, result.data);
    check("确实重新登录过一次以上", loginCalls >= 1, loginCalls);
  } finally {
    await loginPageAdmin.close();
  }

  // ----------------------------------------------------------------
  // B + D: 用 MCP 工具层验证状态码映射与 trigger
  // ----------------------------------------------------------------
  console.log("[B/D] 状态码映射");
  const adminB = await startFakeAdmin((req, res) => {
    if (req.url?.includes("/login")) {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "XXL_JOB_LOGIN_IDENTITY=t; Path=/" });
      res.end(JSON.stringify({ code: 200, msg: null, content: null }));
      return;
    }
    if (req.url?.includes("/joblog/pageList")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        recordsFiltered: 6,
        data: [
          { id: 1, triggerCode: 1, handleCode: 1 },
          { id: 2, triggerCode: 1, handleCode: 200 },
          { id: 3, triggerCode: 1, handleCode: 502 },
          { id: 4, triggerCode: 1, handleCode: 500 },
          { id: 5, triggerCode: 1, handleCode: 0 },
          { id: 6, triggerCode: 1, handleCode: 2 },
        ],
      }));
      return;
    }
    if (req.url?.includes("/jobinfo/trigger")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 200, msg: null, content: null }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 200, msg: null, content: null }));
  });
  try {
    const registry = new TargetRegistry(
      { systems: { s: { instances: { dev: { url: adminB.url, username: "u", password: "p", timeoutMs: 5000 } } } } },
      { logger: () => {} },
    );
    const server = buildServer(registry);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const mcp = new Client({ name: "t", version: "1" });
    await mcp.connect(ct);

    const res = await mcp.callTool({ name: "list_job_logs", arguments: { system: "s", env: "dev", page: 1, pageSize: 10 } });
    const text = (res.content as { type: string; text: string }[]).map((x) => x.text).join("\n");
    const parsed = JSON.parse(text.slice(text.indexOf("{"))) as { logs: { handleCode: number; handleResult: string }[] };
    const byCode = new Map(parsed.logs.map((l) => [l.handleCode, l.handleResult]));
    check("handleCode=1 -> 执行成功", byCode.get(1) === "执行成功", byCode.get(1));
    check("handleCode=200 -> 执行成功", byCode.get(200) === "执行成功", byCode.get(200));
    check("handleCode=502 -> 执行超时（不再误报未完成）", byCode.get(502) === "执行超时", byCode.get(502));
    check("handleCode=500 -> 执行失败", byCode.get(500) === "执行失败", byCode.get(500));
    check("handleCode=0 -> 执行失败", byCode.get(0) === "执行失败", byCode.get(0));
    check("handleCode=2 -> 执行失败", byCode.get(2) === "执行失败", byCode.get(2));

    const trig = await mcp.callTool({ name: "trigger_job", arguments: { system: "s", env: "dev", jobId: 1 } });
    check("trigger_job 仍正常工作（死代码删除后）", trig.isError !== true, trig.content);

    await mcp.close();
    await server.close();
  } finally {
    await adminB.close();
  }

  console.log("");
  console.log("========== 脆弱点回归测试: " + passed + " 通过, " + failed + " 失败 ==========");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});