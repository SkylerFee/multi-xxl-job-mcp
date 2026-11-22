#!/usr/bin/env node
/**
 * XXL-JOB MCP 服务入口（stdio 传输）。
 *
 * 通过 XXL-JOB Admin Web API 提供任务配置读取/新增/修改、
 * 启停调度、手动触发、执行日志查看等能力。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { XxlJobClient, XxlJobApiError } from "./client.js";
import { runInit } from "./cli.js";
import { loadConfigFromDefaultPath } from "./config.js";
import { TargetError, TargetRegistry } from "./registry.js";
import {
  JOB_DEFAULTS,
  pageTotal,
  triggerStatusText,
  validateSchedule,
  XxlJobInfo,
} from "./models.js";

/** 服务标识与版本，需与 package.json 保持一致（MCP 客户端用它在 initialize 握手中识别服务） */
const SERVER_NAME = "multi-xxl-job-mcp";
const SERVER_VERSION = "0.0.1";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown, note?: string): ToolResult {
  const text = note ? `${note}\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * 把执行结果码翻译成中文描述。
 *
 * 取值来自上游 XxlJobContext：
 * - 成功码：标准版 1、部分二开版 200
 * - 失败码：0（未执行）/ 2（执行器未回调）/ 500（HANDLE_CODE_FAIL）
 * - 502（HANDLE_CODE_TIMEOUT）：执行超时，**必须与「未完成」区分**
 *   —— 超时是已经结束的失败，而「未完成」表示仍在执行中，
 *   混为一谈会把人引向「再等等」而不是「去查超时原因」
 *
 * @param handleCode 日志记录中的执行结果码
 */
function handleResultText(handleCode: number): string {
  if (handleCode === 1 || handleCode === 200) return "执行成功";
  if (handleCode === 502) return "执行超时";
  if (handleCode === 0 || handleCode === 2 || handleCode === 500) return "执行失败";
  return "未完成";
}

/**
 * 把任意异常转为工具错误结果。
 *
 * 目标寻址失败（未知 system/env）是参数问题而非服务故障，
 * 单独给出前缀，便于调用方区分「我用错了」和「调度中心出问题了」。
 */
function fail(e: unknown): ToolResult {
  if (e instanceof TargetError) {
    return { content: [{ type: "text", text: `目标参数错误: ${e.message}` }], isError: true };
  }
  const msg = e instanceof XxlJobApiError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `调用 XXL-JOB 失败: ${msg}` }], isError: true };
}

/**
 * 工具的目标参数 schema 片段。
 *
 * 所有工具都必须显式指定目标：这是刻意的设计选择——定时任务调度器上
 * 的误操作（尤其是 remove_job）不可恢复，用显式参数换取「不可能忘记切换环境」。
 */
const targetSchema = {
  system: z.string().describe("业务系统名（可用 list_instances 查询）"),
  env: z.string().describe("环境名，如 dev / staging / prod（可用 list_instances 查询）"),
};

/** 将 XxlJobInfo 序列化为 Admin update 接口需要的扁平表单字段 */
function jobToForm(job: XxlJobInfo): Record<string, string | number> {
  return {
    id: job.id,
    jobGroup: job.jobGroup,
    jobDesc: job.jobDesc ?? "",
    author: job.author ?? "",
    alarmEmail: job.alarmEmail ?? "",
    scheduleType: job.scheduleType ?? "NONE",
    scheduleConf: job.scheduleConf ?? "",
    misfireStrategy: job.misfireStrategy ?? JOB_DEFAULTS.misfireStrategy,
    executorRouteStrategy: job.executorRouteStrategy ?? JOB_DEFAULTS.executorRouteStrategy,
    executorHandler: job.executorHandler ?? "",
    executorParam: job.executorParam ?? "",
    executorBlockStrategy: job.executorBlockStrategy ?? JOB_DEFAULTS.executorBlockStrategy,
    executorTimeout: job.executorTimeout ?? 0,
    executorFailRetryCount: job.executorFailRetryCount ?? 0,
    glueType: job.glueType ?? JOB_DEFAULTS.glueType,
    glueSource: job.glueSource ?? "",
    glueRemark: job.glueRemark ?? "",
    childJobId: job.childJobId ?? "",
    triggerStatus: job.triggerStatus ?? 0,
  };
}

/**
 * 构建并注册全部工具的 MCP Server（供启动入口与测试复用）。
 *
 * @param registry 目标注册表，(system, env) -> 已登录的客户端
 */
export function buildServer(registry: TargetRegistry<XxlJobClient>): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ----------------------------------------------------------------
  // 目标发现
  // ----------------------------------------------------------------
  server.registerTool(
    "list_instances",
    {
      title: "列出所有可用目标",
      description:
        "列出配置文件中所有业务系统及其可用环境，返回系统名、别名、各环境的地址与登录用户名（不含密码）。" +
        "调用其他工具前先用它确认该传什么 system / env。",
      inputSchema: {},
    },
    async () => {
      try {
        const systems = registry.list().map((s) => ({
          system: s.system,
          alias: s.alias,
          instances: Object.fromEntries(
            s.envs.map((envName) => {
              const d = registry.describe(s.system, envName);
              return [envName, { url: d.url, username: d.username, usesEnvVars: d.usesEnvVars }];
            }),
          ),
        }));
        return ok({ systems });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----------------------------------------------------------------
  // 执行器组
  // ----------------------------------------------------------------
  server.registerTool(
    "list_job_groups",
    {
      title: "查询执行器组列表",
      description:
        "分页查询 XXL-JOB 的执行器组（执行器）列表，返回 id、AppName、名称、注册方式、在线机器地址等信息。新增任务前通常需要先查执行器组 id。",
      inputSchema: {
        ...targetSchema,
        page: z.number().int().min(1).default(1).describe("页码，从 1 开始"),
        pageSize: z.number().int().min(1).max(100).default(20).describe("每页条数"),
        appname: z.string().optional().describe("按执行器 AppName 过滤（可选）"),
        title: z.string().optional().describe("按执行器名称过滤（可选）"),
      },
    },
    async ({ system, env, page, pageSize, appname, title }) => {
      try {
        const result = await registry.get(system, env).listJobGroups(page, pageSize, appname, title);
        return ok({ recordsTotal: pageTotal(result), groups: result.data });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----------------------------------------------------------------
  // 任务查询
  // ----------------------------------------------------------------
  server.registerTool(
    "list_jobs",
    {
      title: "分页查询任务列表",
      description:
        "分页查询 XXL-JOB 任务列表，支持按执行器组、调度状态（0=停止/1=运行中）、任务描述、JobHandler、负责人过滤。",
      inputSchema: {
        ...targetSchema,
        page: z.number().int().min(1).default(1).describe("页码，从 1 开始"),
        pageSize: z.number().int().min(1).max(100).default(20).describe("每页条数"),
        jobGroup: z.number().int().optional().describe("执行器组 id（可用 list_job_groups 查询）"),
        triggerStatus: z.number().int().min(0).max(1).optional().describe("调度状态：0=停止，1=运行中"),
        jobDesc: z.string().optional().describe("任务描述模糊匹配"),
        executorHandler: z.string().optional().describe("JobHandler 名称过滤"),
        author: z.string().optional().describe("负责人过滤"),
      },
    },
    async ({ system, env, page, pageSize, jobGroup, triggerStatus, jobDesc, executorHandler, author }) => {
      try {
        const result = await registry.get(system, env).listJobs(page, pageSize, {
          jobGroup,
          triggerStatus,
          jobDesc,
          executorHandler,
          author,
        });
        const jobs = result.data.map((j) => ({ ...j, triggerStatusText: triggerStatusText(j.triggerStatus) }));
        return ok({ recordsTotal: pageTotal(result), jobs });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "查询任务详情",
      description: "根据任务 id 查询 XXL-JOB 任务的完整配置详情。",
      inputSchema: {
        ...targetSchema,
        jobId: z.number().int().describe("任务 id"),
      },
    },
    async ({ system, env, jobId }) => {
      try {
        const job = await registry.get(system, env).getJobById(jobId);
        return ok({ ...job, triggerStatusText: triggerStatusText(job.triggerStatus) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----------------------------------------------------------------
  // 任务新增 / 修改
  // ----------------------------------------------------------------
  server.registerTool(
    "add_job",
    {
      title: "新增任务",
      description:
        "在 XXL-JOB 中新增一个任务。必填：执行器组 id、任务描述、调度类型与配置、JobHandler。" +
        "未提供的可选项使用默认值：路由策略 FIRST、阻塞策略 SERIAL_EXECUTION、过期策略 DO_NOTHING、运行模式 BEAN。" +
        "新增后默认为停止状态，可用 start_job 启动。",
      inputSchema: {
        ...targetSchema,
        jobGroup: z.number().int().describe("执行器组 id（可用 list_job_groups 查询）"),
        jobDesc: z.string().describe("任务描述"),
        scheduleType: z.enum(["CRON", "FIX_RATE", "NONE"]).describe("调度类型：CRON=Cron 表达式，FIX_RATE=固定速度(秒)，NONE=不调度"),
        scheduleConf: z.string().optional().describe("调度配置：CRON 时为 Cron 表达式（6~7 段），FIX_RATE 时为秒数"),
        executorHandler: z.string().describe("执行器中的 JobHandler 名称（@XxlJob 注解值）"),
        executorParam: z.string().optional().describe("任务运行参数（可选）"),
        executorRouteStrategy: z
          .enum(["FIRST", "LAST", "ROUND", "RANDOM", "CONSISTENT_HASH", "LEAST_FREQUENTLY_USED", "LEAST_RECENTLY_USED", "FAILOVER", "BUSYOVER", "SHARDING_BROADCAST"])
          .optional()
          .describe("路由策略，默认 FIRST"),
        executorBlockStrategy: z
          .enum(["SERIAL_EXECUTION", "DISCARD_LATER", "COVER_EARLY"])
          .optional()
          .describe("阻塞处理策略，默认 SERIAL_EXECUTION"),
        executorTimeout: z.number().int().min(0).optional().describe("任务超时时间（秒），0=不限制"),
        executorFailRetryCount: z.number().int().min(0).optional().describe("失败重试次数，0=不重试"),
        misfireStrategy: z.enum(["DO_NOTHING", "FIRE_ONCE_NOW"]).optional().describe("调度过期策略，默认 DO_NOTHING"),
        author: z.string().optional().describe("负责人"),
        alarmEmail: z.string().optional().describe("报警邮件（多个逗号分隔）"),
        childJobId: z.string().optional().describe("子任务 id（多个逗号分隔）"),
      },
    },
    async (args) => {
      try {
        const scheduleError = validateSchedule(args.scheduleType, args.scheduleConf);
        if (scheduleError) return fail(new Error(scheduleError));

        const fields: Record<string, string | number> = {
          jobGroup: args.jobGroup,
          jobDesc: args.jobDesc,
          scheduleType: args.scheduleType,
          scheduleConf: args.scheduleConf ?? "",
          glueType: JOB_DEFAULTS.glueType,
          executorHandler: args.executorHandler,
          executorParam: args.executorParam ?? "",
          executorRouteStrategy: args.executorRouteStrategy ?? JOB_DEFAULTS.executorRouteStrategy,
          executorBlockStrategy: args.executorBlockStrategy ?? JOB_DEFAULTS.executorBlockStrategy,
          executorTimeout: args.executorTimeout ?? JOB_DEFAULTS.executorTimeout,
          executorFailRetryCount: args.executorFailRetryCount ?? JOB_DEFAULTS.executorFailRetryCount,
          misfireStrategy: args.misfireStrategy ?? JOB_DEFAULTS.misfireStrategy,
          author: args.author ?? "",
          alarmEmail: args.alarmEmail ?? "",
          childJobId: args.childJobId ?? "",
          triggerStatus: 0,
        };
        const newId = await registry.get(args.system, args.env).addJob(fields);
        return ok({ jobId: newId }, `任务新增成功，id=${newId}（当前为停止状态，可用 start_job 启动）`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_job",
    {
      title: "修改任务",
      description:
        "修改 XXL-JOB 任务配置。采用先读取现有全量配置、合并本次变更、再整体提交的方式，未传入的字段保持原值不变。" +
        "调度状态（启动/停止）请用 start_job / stop_job，不在此工具处理。",
      inputSchema: {
        ...targetSchema,
        jobId: z.number().int().describe("任务 id"),
        jobGroup: z.number().int().optional().describe("执行器组 id"),
        jobDesc: z.string().optional().describe("任务描述"),
        scheduleType: z.enum(["CRON", "FIX_RATE", "NONE"]).optional().describe("调度类型"),
        scheduleConf: z.string().optional().describe("调度配置（Cron 表达式或固定秒数）"),
        executorHandler: z.string().optional().describe("JobHandler 名称"),
        executorParam: z.string().optional().describe("任务运行参数"),
        executorRouteStrategy: z.enum(["FIRST", "LAST", "ROUND", "RANDOM", "CONSISTENT_HASH", "LEAST_FREQUENTLY_USED", "LEAST_RECENTLY_USED", "FAILOVER", "BUSYOVER", "SHARDING_BROADCAST"]).optional().describe("路由策略"),
        executorBlockStrategy: z.enum(["SERIAL_EXECUTION", "DISCARD_LATER", "COVER_EARLY"]).optional().describe("阻塞处理策略"),
        executorTimeout: z.number().int().min(0).optional().describe("任务超时时间（秒）"),
        executorFailRetryCount: z.number().int().min(0).optional().describe("失败重试次数"),
        misfireStrategy: z.enum(["DO_NOTHING", "FIRE_ONCE_NOW"]).optional().describe("调度过期策略"),
        author: z.string().optional().describe("负责人"),
        alarmEmail: z.string().optional().describe("报警邮件"),
        childJobId: z.string().optional().describe("子任务 id"),
      },
    },
    async (args) => {
      try {
        const target = registry.get(args.system, args.env);
        const existing = await target.getJobById(args.jobId);
        const form = jobToForm(existing);

        // 计算合并后的调度配置并校验
        const mergedType = args.scheduleType ?? String(form.scheduleType);
        const mergedConf = args.scheduleConf ?? String(form.scheduleConf);
        if (args.scheduleType !== undefined || args.scheduleConf !== undefined) {
          const scheduleError = validateSchedule(mergedType, mergedConf);
          if (scheduleError) return fail(new Error(scheduleError));
        }

        // 排除目标参数与 jobId：它们不是 Admin update 接口的表单字段，
        // 若混入 form 会被当作未知字段提交。
        const { jobId: _jobId, system: _system, env: _env, ...changes } = args;
        for (const [key, value] of Object.entries(changes)) {
          if (value !== undefined) form[key] = value as string | number;
        }

        await target.updateJob(form);
        const updated = await target.getJobById(args.jobId);
        return ok(updated, `任务 id=${args.jobId} 修改成功，以下为修改后的完整配置`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----------------------------------------------------------------
  // 启停 / 触发
  // ----------------------------------------------------------------
  server.registerTool(
    "start_job",
    {
      title: "启动任务",
      description: "启动指定任务的调度（使其按调度配置自动执行）。",
      inputSchema: { ...targetSchema, jobId: z.number().int().describe("任务 id") },
    },
    async ({ system, env, jobId }) => {
      try {
        await registry.get(system, env).startJob(jobId);
        return ok({ jobId, triggerStatus: 1 }, `任务 id=${jobId} 已启动调度`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "stop_job",
    {
      title: "停止任务",
      description: "停止指定任务的调度（不再自动执行，历史配置保留）。",
      inputSchema: { ...targetSchema, jobId: z.number().int().describe("任务 id") },
    },
    async ({ system, env, jobId }) => {
      try {
        await registry.get(system, env).stopJob(jobId);
        return ok({ jobId, triggerStatus: 0 }, `任务 id=${jobId} 已停止调度`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "remove_job",
    {
      title: "删除任务",
      description:
        "永久删除指定任务（不可恢复，任务配置与历史日志将一并清除）。" +
        "破坏性操作：请务必确认 system 与 env 指向正确的目标。",
      inputSchema: { ...targetSchema, jobId: z.number().int().describe("任务 id") },
    },
    async ({ system, env, jobId }) => {
      try {
        await registry.get(system, env).removeJob(jobId);
        return ok({ jobId }, `任务 id=${jobId} 已删除`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "trigger_job",
    {
      title: "手动触发一次执行",
      description:
        "手动触发指定任务立即执行一次（不影响原有调度状态）。可覆盖运行参数，也可指定执行器地址列表（为空则按任务配置的路由策略选择）。",
      inputSchema: {
        ...targetSchema,
        jobId: z.number().int().describe("任务 id"),
        executorParam: z.string().optional().describe("本次执行的运行参数（覆盖任务默认参数）"),
        addressList: z.string().optional().describe("执行器地址列表（多个逗号分隔），不传则按路由策略自动选择"),
      },
    },
    async ({ system, env, jobId, executorParam, addressList }) => {
      try {
        await registry.get(system, env).triggerJob(jobId, executorParam, addressList);
        return ok({ jobId }, `任务 id=${jobId} 已触发一次执行，可用 list_job_logs 查看执行结果`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "preview_next_trigger_times",
    {
      title: "预演未来触发时间",
      description: "根据调度类型与配置（如 Cron 表达式）预演未来若干次触发时间，用于校验调度配置是否符合预期。",
      inputSchema: {
        ...targetSchema,
        scheduleType: z.enum(["CRON", "FIX_RATE"]).describe("调度类型"),
        scheduleConf: z.string().describe("调度配置：CRON 为 Cron 表达式，FIX_RATE 为秒数"),
      },
    },
    async ({ system, env, scheduleType, scheduleConf }) => {
      try {
        const times = await registry.get(system, env).nextTriggerTimes(scheduleType, scheduleConf);
        return ok({ scheduleType, scheduleConf, nextTriggerTimes: times });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----------------------------------------------------------------
  // 执行日志
  // ----------------------------------------------------------------
  server.registerTool(
    "list_job_logs",
    {
      title: "查询执行日志列表",
      description:
        "分页查询任务的执行日志（调度记录），支持按执行器组、任务、执行状态、调度时间范围过滤。" +
        "返回每条记录的调度结果(triggerCode)、执行结果(handleCode)、执行器地址与触发时间，可据此调用 get_job_log_content 查看日志正文。",
      inputSchema: {
        ...targetSchema,
        page: z.number().int().min(1).default(1).describe("页码，从 1 开始"),
        pageSize: z.number().int().min(1).max(100).default(20).describe("每页条数"),
        jobGroup: z.number().int().optional().describe("执行器组 id"),
        jobId: z.number().int().optional().describe("任务 id"),
        logStatus: z.number().int().min(1).max(3).optional().describe("执行状态：1=成功，2=失败，3=进行中"),
        filterTimeStart: z.string().optional().describe("调度时间起始，格式 yyyy-MM-dd HH:mm:ss"),
        filterTimeEnd: z.string().optional().describe("调度时间截止，格式 yyyy-MM-dd HH:mm:ss"),
      },
    },
    async ({ system, env, page, pageSize, jobGroup, jobId, logStatus, filterTimeStart, filterTimeEnd }) => {
      try {
        const result = await registry.get(system, env).listJobLogs(page, pageSize, {
          jobGroup,
          jobId,
          logStatus,
          filterTimeStart,
          filterTimeEnd,
        });
        return ok({
          recordsTotal: pageTotal(result),
          logs: result.data.map((l) => ({
            ...l,
            // 兼容不同版本的成功码：标准版 1=成功，部分版本 200=成功
            triggerResult: l.triggerCode === 1 || l.triggerCode === 200 ? "调度成功" : "调度失败",
            handleResult: handleResultText(l.handleCode),
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_job_log_content",
    {
      title: "查看执行日志正文",
      description:
        "增量拉取某条执行记录的日志正文（来自执行器）。logId、executorAddress、triggerTime 取自 list_job_logs 的返回。" +
        "日志较长时，用返回的 toLineNum+1 作为下一次 fromLineNum 继续读取，直到 isEnd=true。",
      inputSchema: {
        ...targetSchema,
        logId: z.number().int().describe("执行日志记录 id（list_job_logs 返回的 id）"),
        executorAddress: z.string().describe("执行器地址（list_job_logs 返回的 executorAddress）"),
        // 刻意用 z.union([z.string(), z.int()]) 而不是 z.union([z.number(), z.string()])：
        // 后者的 JSON Schema 会产出 type: ["number","string"] 这种数组形式，虽然合法，
        // 但把 tool schema 映射到「单一 type」方言的客户端（如 Gemini function declarations
        // 用的 OpenAPI 子集）可能拒收整个工具或静默丢掉约束。
        // 写法顺序（string 在前）决定 zod 输出 anyOf 而非 type 数组，运行时接受的范围不变。
        triggerTime: z.union([z.string(), z.int()]).describe("触发时间（list_job_logs 返回的 triggerTime 原值）"),
        fromLineNum: z.number().int().min(1).default(1).describe("起始行号，首次传 1，续读传上次 toLineNum+1"),
      },
    },
    async ({ system, env, logId, executorAddress, triggerTime, fromLineNum }) => {
      try {
        const detail = await registry.get(system, env).logDetailCat(logId, executorAddress, triggerTime, fromLineNum);
        return ok(detail);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

/**
 * stdio 启动入口。
 *
 * 启动时即校验配置文件的结构与插值，任一错误都会拒绝启动——
 * 配置错误立刻暴露，比等到半夜发现某个环境密码写错要好。
 * 凭据有效性不在此校验，留到首次使用该目标时由 client 的登录流程判定。
 */
export async function main(): Promise<void> {
  const { config, path } = loadConfigFromDefaultPath();
  // 打印实际读取的路径，消除"到底读了哪个文件"的疑问
  console.error(`[${SERVER_NAME}] 配置文件: ${path}`);
  const registry = new TargetRegistry(config);
  const server = buildServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 服务通过标准输入/输出通信，日志只能走 stderr
  console.error(`[${SERVER_NAME}] 已启动，已加载 ${Object.keys(config.systems).length} 个系统`);
}

/**
 * 判断当前模块是否作为入口直接运行。
 * 通过 npx / npm 全局安装运行时，process.argv[1] 可能是 node_modules/.bin 下的符号链接，
 * 需用 realpathSync 解析为真实路径后再与 import.meta.url 比较，否则会误判为被导入而静默退出。
 * Windows 下路径大小写不敏感，统一转小写比较，避免盘符大小写差异导致误判。
 */
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  let entryHref: string;
  try {
    entryHref = pathToFileURL(realpathSync(resolve(argv1))).href;
  } catch {
    return false;
  }
  if (process.platform === "win32") {
    return entryHref.toLowerCase() === import.meta.url.toLowerCase();
  }
  return entryHref === import.meta.url;
}

/**
 * 处理 init 子命令：交互式生成配置文件。
 *
 * 用户主动取消（拒绝覆盖）时仍以非零退出码结束：调用方常写成 "init && start"，
 * 此时磁盘上没有新配置，用非零码让脚本立即停下，而不是带着旧配置继续跑。
 */
async function runInitCommand(): Promise<void> {
  const result = await runInit();
  if (result.status === "aborted") {
    process.exitCode = 1;
  }
}

// 直接运行时按子命令分发：init 走配置生成，其余启动 stdio 服务
if (isMainModule()) {
  if (process.argv[2] === "init") {
    runInitCommand().catch((e) => {
      console.error(`[${SERVER_NAME}] init 失败: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
  } else {
    main().catch((e) => {
      console.error(`[${SERVER_NAME}] 启动失败: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
  }
}