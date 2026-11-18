/**
 * Mock XXL-JOB Admin：按真实 Admin 的接口语义实现核心端点，
 * 用于在无真实环境时做全链路集成测试。
 *
 * 实现要点与真实 Admin 保持一致：
 * - 登录成功返回 ReturnT{code:200} 并下发 XXL_JOB_LOGIN_IDENTITY Cookie
 * - 未登录请求 302 重定向到 /toLogin
 * - 业务接口统一返回 ReturnT{code, msg, content}
 * - 分页接口返回 DataTables 风格 {recordsTotal, data}
 */

import http from "node:http";
import { AddressInfo } from "node:net";

interface MockJob {
  [key: string]: unknown;
  id: number;
  jobGroup: number;
  jobDesc: string;
  scheduleType: string;
  scheduleConf: string;
  glueType: string;
  executorHandler: string;
  executorParam: string;
  executorRouteStrategy: string;
  executorBlockStrategy: string;
  executorTimeout: number;
  executorFailRetryCount: number;
  misfireStrategy: string;
  author: string;
  alarmEmail: string;
  childJobId: string;
  triggerStatus: number;
  triggerLastTime: number;
  triggerNextTime: number;
  addTime: string;
  updateTime: string;
}

const COOKIE_NAME = "XXL_JOB_LOGIN_IDENTITY";
const VALID_USER = "admin";
const VALID_PASS = "mock-pass";

export interface MockAdminHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
  jobs: Map<number, MockJob>;
  triggerCount: number;
}

function returnT(content: unknown, msg: string | null = null, code = 200) {
  return JSON.stringify({ code, msg, content });
}

export async function startMockAdmin(username = VALID_USER, password = VALID_PASS): Promise<MockAdminHandle> {
  const groups = [
    { id: 1, appname: "xxl-job-executor-sample", title: "示例执行器", addressType: 0, addressList: null, updateTime: "2026-08-01 10:00:00" },
    { id: 2, appname: "order-executor", title: "订单执行器", addressType: 1, addressList: "http://127.0.0.1:9999/", updateTime: "2026-08-01 10:00:00" },
  ];

  let nextJobId = 2;
  const jobs = new Map<number, MockJob>([
    [
      1,
      {
        id: 1,
        jobGroup: 1,
        jobDesc: "测试任务1",
        scheduleType: "CRON",
        scheduleConf: "0 0 2 * * ?",
        glueType: "BEAN",
        executorHandler: "demoJobHandler",
        executorParam: "",
        executorRouteStrategy: "FIRST",
        executorBlockStrategy: "SERIAL_EXECUTION",
        executorTimeout: 0,
        executorFailRetryCount: 0,
        misfireStrategy: "DO_NOTHING",
        author: "XXL",
        alarmEmail: "",
        childJobId: "",
        triggerStatus: 1,
        triggerLastTime: 1754164800000,
        triggerNextTime: 1754251200000,
        addTime: "2026-07-01 10:00:00",
        updateTime: "2026-08-01 10:00:00",
      },
    ],
  ]);

  const logs = [
    {
      id: 100,
      jobGroup: 1,
      jobId: 1,
      executorAddress: "127.0.0.1:9999",
      executorHandler: "demoJobHandler",
      executorParam: "",
      executorShardingParam: null,
      executorFailRetryCount: 0,
      triggerTime: "2026-08-02 02:00:00",
      triggerCode: 1,
      triggerMsg: "调度成功",
      handleTime: "2026-08-02 02:00:01",
      handleCode: 1,
      handleMsg: "执行成功",
      alarmStatus: 0,
    },
  ];

  let triggerCount = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // 与真实 Admin 一样带 /xxl-job-admin 上下文前缀，路由前先去除
      const path = url.pathname.replace(/^\/xxl-job-admin/, "") || "/";
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const form = new URLSearchParams(bodyText);
      // xxl-job 的 @RequestParam 同时接受 query 与 form body，这里合并
      const param = (name: string): string | undefined => form.get(name) ?? url.searchParams.get(name) ?? undefined;

      const cookie = req.headers.cookie ?? "";
      const authed = cookie.includes(`${COOKIE_NAME}=mock-token`);

      const json = (text: string, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json;charset=UTF-8", ...headers });
        res.end(text);
      };
      const redirectToLogin = () => {
        res.writeHead(302, { Location: "/toLogin" });
        res.end();
      };

      // ---------------- 登录 ----------------
      if (path === "/login" && req.method === "POST") {
        if (param("userName") === username && param("password") === password) {
          json(returnT(null), 200, { "Set-Cookie": `${COOKIE_NAME}=mock-token; Path=/; HttpOnly` });
        } else {
          json(returnT(null, "账号或密码错误", 500));
        }
        return;
      }

      // ---------------- 鉴权拦截 ----------------
      if (!authed) {
        redirectToLogin();
        return;
      }

      // ---------------- 执行器组 ----------------
      if (path === "/jobgroup/pageList") {
        // 与真实 Admin 一致：pageList 直接返回裸 JSON，不带 ReturnT 包装
        json(JSON.stringify({ recordsFiltered: groups.length, data: groups }));
        return;
      }

      // ---------------- 任务管理 ----------------
      if (path === "/jobinfo/pageList") {
        let list = [...jobs.values()];
        const jobGroup = param("jobGroup");
        const triggerStatus = param("triggerStatus");
        const jobDesc = param("jobDesc");
        const executorHandler = param("executorHandler");
        // 与真实 Admin 一致：jobGroup=0 表示全部，triggerStatus=-1 表示全部状态
        if (jobGroup && Number(jobGroup) !== 0) list = list.filter((j) => j.jobGroup === Number(jobGroup));
        if (triggerStatus !== undefined && triggerStatus !== "" && Number(triggerStatus) !== -1) {
          list = list.filter((j) => j.triggerStatus === Number(triggerStatus));
        }
        if (jobDesc) list = list.filter((j) => j.jobDesc.includes(jobDesc));
        if (executorHandler) list = list.filter((j) => String(j.executorHandler).includes(executorHandler));
        json(JSON.stringify({ recordsFiltered: list.length, data: list }));
        return;
      }

      if (path === "/jobinfo/getById") {
        const job = jobs.get(Number(param("id")));
        json(job ? returnT(job) : returnT(null, "任务不存在", 500));
        return;
      }

      if (path === "/jobinfo/add" && req.method === "POST") {
        const jobGroup = Number(param("jobGroup"));
        const jobDesc = param("jobDesc");
        const executorHandler = param("executorHandler");
        if (!jobGroup || !jobDesc || !executorHandler) {
          json(returnT(null, "必填参数缺失", 500));
          return;
        }
        const id = nextJobId++;
        jobs.set(id, {
          id,
          jobGroup,
          jobDesc,
          scheduleType: param("scheduleType") ?? "NONE",
          scheduleConf: param("scheduleConf") ?? "",
          glueType: param("glueType") ?? "BEAN",
          executorHandler,
          executorParam: param("executorParam") ?? "",
          executorRouteStrategy: param("executorRouteStrategy") ?? "FIRST",
          executorBlockStrategy: param("executorBlockStrategy") ?? "SERIAL_EXECUTION",
          executorTimeout: Number(param("executorTimeout") ?? 0),
          executorFailRetryCount: Number(param("executorFailRetryCount") ?? 0),
          misfireStrategy: param("misfireStrategy") ?? "DO_NOTHING",
          author: param("author") ?? "",
          alarmEmail: param("alarmEmail") ?? "",
          childJobId: param("childJobId") ?? "",
          triggerStatus: 0,
          triggerLastTime: 0,
          triggerNextTime: 0,
          addTime: "2026-08-03 10:00:00",
          updateTime: "2026-08-03 10:00:00",
        });
        json(returnT(id));
        return;
      }

      if (path === "/jobinfo/update" && req.method === "POST") {
        const id = Number(param("id"));
        const job = jobs.get(id);
        if (!job) {
          json(returnT(null, "任务不存在", 500));
          return;
        }
        for (const [key, value] of form.entries()) {
          if (key === "id") continue;
          job[key] = ["executorTimeout", "executorFailRetryCount", "jobGroup", "triggerStatus"].includes(key) ? Number(value) : value;
        }
        job.updateTime = "2026-08-03 11:00:00";
        json(returnT(null));
        return;
      }

      if (path === "/jobinfo/start" && req.method === "POST") {
        const job = jobs.get(Number(param("id")));
        if (!job) return json(returnT(null, "任务不存在", 500));
        job.triggerStatus = 1;
        json(returnT(null));
        return;
      }

      if (path === "/jobinfo/stop" && req.method === "POST") {
        const job = jobs.get(Number(param("id")));
        if (!job) return json(returnT(null, "任务不存在", 500));
        job.triggerStatus = 0;
        json(returnT(null));
        return;
      }

      if (path === "/jobinfo/remove" && req.method === "POST") {
        const id = Number(param("id"));
        if (!jobs.has(id)) {
          json(returnT(null, "任务不存在", 500));
          return;
        }
        jobs.delete(id);
        json(returnT(null));
        return;
      }

      if (path === "/jobinfo/trigger" && req.method === "POST") {
        const job = jobs.get(Number(param("id")));
        if (!job) return json(returnT(null, "任务不存在", 500));
        triggerCount++;
        json(returnT(null));
        return;
      }

      if (path === "/jobinfo/nextTriggerTime") {
        const conf = param("scheduleConf") ?? "";
        if (!conf) {
          json(returnT(null, "调度配置不能为空", 500));
          return;
        }
        const base = Date.now();
        const times = [1, 2, 3, 4, 5].map((i) => new Date(base + i * 3600_000).toLocaleString("zh-CN", { hour12: false }));
        json(returnT(times));
        return;
      }

      // ---------------- 执行日志 ----------------
      if (path === "/joblog/pageList") {
        let list = [...logs];
        const jobId = param("jobId");
        if (jobId && Number(jobId) !== 0) list = list.filter((l) => l.jobId === Number(jobId));
        json(JSON.stringify({ recordsFiltered: list.length, data: list }));
        return;
      }

      if (path === "/joblog/logDetailCat") {
        const fromLineNum = Number(param("fromLineNum") ?? 1);
        const lines = ["# 任务开始执行", "参数: {}", "业务处理完成", "耗时: 350ms"];
        const slice = lines.slice(fromLineNum - 1);
        const toLineNum = fromLineNum + slice.length - 1;
        json(returnT({ fromLineNum, toLineNum, logContent: slice.join("\n"), isEnd: toLineNum >= lines.length }));
        return;
      }

      json(returnT(null, `mock 未实现的接口: ${path}`, 500));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/xxl-job-admin`,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    jobs,
    get triggerCount() {
      return triggerCount;
    },
  } as MockAdminHandle;
}
