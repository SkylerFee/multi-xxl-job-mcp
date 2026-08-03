/**
 * XXL-JOB Admin HTTP 客户端。
 *
 * 对接 Admin 的 Web 接口（/login、/jobinfo/*、/jobgroup/*、/joblog/*），
 * 自动登录并维护 XXL_JOB_LOGIN_IDENTITY Cookie，Cookie 失效时自动重登一次。
 */

import { XxlJobConfig } from "./config.js";
import {
  LogDetailCat,
  PageResult,
  ReturnT,
  XxlJobGroup,
  XxlJobInfo,
  XxlJobLog,
} from "./models.js";

export class XxlJobApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "XxlJobApiError";
  }
}

type QueryParams = Record<string, string | number | boolean | undefined | null>;

export class XxlJobClient {
  private cookies = new Map<string, string>();
  private loggedIn = false;
  private loggingIn: Promise<void> | null = null;

  constructor(private readonly config: XxlJobConfig) {}

  // ------------------------------------------------------------------
  // 登录与会话
  // ------------------------------------------------------------------

  /** 登录调度中心，保存会话 Cookie */
  async login(): Promise<void> {
    const url = `${this.config.baseUrl}/login`;
    const body = new URLSearchParams({
      userName: this.config.username,
      password: this.config.password,
    });
    const resp = await this.rawFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    this.storeCookies(resp);
    const result = (await this.parseReturnT(resp, "/login")) as ReturnT;
    if (result.code !== 200) {
      throw new XxlJobApiError(
        `登录 XXL-JOB 失败: ${result.msg || "未知错误"}（请检查 XXL_JOB_USERNAME / XXL_JOB_PASSWORD）`,
        result.code,
        "/login",
      );
    }
    this.loggedIn = true;
  }

  /** 并发安全的登录（多工具同时触发时只登录一次） */
  private async ensureLoggedIn(): Promise<void> {
    if (this.loggedIn) return;
    if (!this.loggingIn) {
      this.loggingIn = this.login().finally(() => {
        this.loggingIn = null;
      });
    }
    await this.loggingIn;
  }

  private storeCookies(resp: Response): void {
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    for (const item of setCookies) {
      const [pair] = item.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) {
        this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  // ------------------------------------------------------------------
  // 请求封装
  // ------------------------------------------------------------------

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    let resp: Response;
    try {
      resp = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(this.cookies.size > 0 ? { Cookie: this.cookieHeader() } : {}),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new XxlJobApiError(
        `请求 XXL-JOB 调度中心失败（${url}）: ${msg}。请确认 XXL_JOB_URL 可达`,
        undefined,
        url,
      );
    }
    return resp;
  }

  /** 判断响应是否为"未登录"（302 跳登录页 或 返回 HTML 登录页） */
  private async isAuthRedirect(resp: Response): Promise<boolean> {
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("location") || "";
      return /login/i.test(location);
    }
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      const text = (await resp.text()).slice(0, 500);
      return /login/i.test(text);
    }
    return false;
  }

  private async parseReturnT(resp: Response, path: string): Promise<unknown> {
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new XxlJobApiError(
        `XXL-JOB 接口 ${path} 返回了非 JSON 内容（HTTP ${resp.status}），` +
          `响应片段: ${text.slice(0, 200)}`,
        resp.status,
        path,
      );
    }
  }

  /**
   * 统一请求入口：自动携带 Cookie，未登录时自动重登一次后重试。
   * 返回原始解析后的 JSON（不做 ReturnT 校验，由调用方按接口类型处理）。
   */
  private async requestRaw(method: "GET" | "POST", path: string, params: QueryParams = {}): Promise<unknown> {
    await this.ensureLoggedIn();
    return this.requestOnce(method, path, params, true);
  }

  /**
   * ReturnT 风格接口：登录/增删改/触发/getById 等，
   * 响应体为 {code, msg, content}，code != 200 时抛错。
   */
  private async request(method: "GET" | "POST", path: string, params: QueryParams = {}): Promise<ReturnT> {
    const raw = (await this.requestRaw(method, path, params)) as ReturnT;
    if (raw === null || typeof raw !== "object" || !("code" in raw)) {
      throw new XxlJobApiError(`接口 ${path} 返回了意外的响应结构: ${JSON.stringify(raw).slice(0, 200)}`, undefined, path);
    }
    if (raw.code !== 200) {
      throw new XxlJobApiError(raw.msg || `接口 ${path} 返回错误`, raw.code, path);
    }
    return raw;
  }

  /**
   * 分页列表接口：pageList 系列直接返回裸 JSON {recordsFiltered/recordsTotal, data}，
   * 不带 ReturnT 包装，不能做 code 校验。
   */
  private async requestPage<T>(method: "GET" | "POST", path: string, params: QueryParams = {}): Promise<PageResult<T>> {
    const raw = (await this.requestRaw(method, path, params)) as PageResult<T>;
    if (raw === null || typeof raw !== "object" || !Array.isArray(raw.data)) {
      throw new XxlJobApiError(`接口 ${path} 返回了意外的响应结构: ${JSON.stringify(raw).slice(0, 200)}`, undefined, path);
    }
    return raw;
  }

  private async requestOnce(
    method: "GET" | "POST",
    path: string,
    params: QueryParams,
    retryOnAuth: boolean,
  ): Promise<unknown> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      // 注意：不过滤空字符串。部分版本的 Admin 将 appname/title/jobDesc 等参数标为必填，
      // 缺失会直接 HTTP 400，需以空串形式显式传递。
      if (v !== undefined && v !== null) clean[k] = String(v);
    }

    let url = `${this.config.baseUrl}${path}`;
    const init: RequestInit = { method };
    if (method === "GET") {
      const qs = new URLSearchParams(clean).toString();
      if (qs) url += `?${qs}`;
    } else {
      init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      init.body = new URLSearchParams(clean).toString();
    }

    const resp = await this.rawFetch(url, init);

    if (await this.isAuthRedirect(resp)) {
      if (!retryOnAuth) {
        throw new XxlJobApiError("登录态失效且重新登录后仍被拒绝", undefined, path);
      }
      this.loggedIn = false;
      await this.login();
      return this.requestOnce(method, path, params, false);
    }

    return this.parseReturnT(resp, path);
  }

  // ------------------------------------------------------------------
  // 执行器组
  // ------------------------------------------------------------------

  /** 执行器组分页列表 */
  async listJobGroups(page: number, pageSize: number, appname?: string, title?: string): Promise<PageResult<XxlJobGroup>> {
    return this.requestPage<XxlJobGroup>("GET", "/jobgroup/pageList", {
      start: (page - 1) * pageSize,
      length: pageSize,
      appname: appname ?? "",
      title: title ?? "",
    });
  }

  // ------------------------------------------------------------------
  // 任务管理
  // ------------------------------------------------------------------

  /** 任务分页查询 */
  async listJobs(
    page: number,
    pageSize: number,
    filter: {
      jobGroup?: number;
      triggerStatus?: number;
      jobDesc?: string;
      executorHandler?: string;
      author?: string;
    } = {},
  ): Promise<PageResult<XxlJobInfo>> {
    return this.requestPage<XxlJobInfo>("GET", "/jobinfo/pageList", {
      start: (page - 1) * pageSize,
      length: pageSize,
      // 部分版本将 jobGroup/triggerStatus 标为必填：
      // jobGroup=0 表示全部执行器，triggerStatus=-1 表示全部状态
      jobGroup: filter.jobGroup ?? 0,
      triggerStatus: filter.triggerStatus ?? -1,
      jobDesc: filter.jobDesc ?? "",
      executorHandler: filter.executorHandler ?? "",
      author: filter.author ?? "",
    });
  }

  /**
   * 任务详情。优先调 /jobinfo/getById；
   * 部分版本无此接口（404），降级为通过 pageList 分页扫描定位。
   */
  async getJobById(id: number): Promise<XxlJobInfo> {
    try {
      const result = await this.request("GET", "/jobinfo/getById", { id });
      if (!result.content) {
        throw new XxlJobApiError(`未找到任务 id=${id}`, undefined, "/jobinfo/getById");
      }
      return result.content as XxlJobInfo;
    } catch (e) {
      const msg = e instanceof XxlJobApiError ? e.message : String(e);
      // 仅在接口不存在类错误时降级；业务错误（如未找到）直接抛出
      if (!/非 JSON 内容|意外的响应结构/.test(msg)) throw e;
      return this.findJobByIdViaPageList(id);
    }
  }

  /** 降级方案：分页扫描任务列表，按 id 定位 */
  private async findJobByIdViaPageList(id: number): Promise<XxlJobInfo> {
    const pageSize = 100;
    for (let page = 1; page <= 50; page++) {
      const result = await this.listJobs(page, pageSize);
      const found = result.data.find((j) => j.id === id);
      if (found) return found;
      if (result.data.length < pageSize) break;
    }
    throw new XxlJobApiError(`未找到任务 id=${id}`, undefined, "/jobinfo/pageList");
  }

  /** 新增任务，返回新任务 id */
  async addJob(fields: Record<string, string | number>): Promise<number> {
    const result = await this.request("POST", "/jobinfo/add", fields);
    return Number(result.content);
  }

  /** 更新任务 */
  async updateJob(fields: Record<string, string | number>): Promise<void> {
    await this.request("POST", "/jobinfo/update", fields);
  }

  /** 启动任务调度 */
  async startJob(id: number): Promise<void> {
    await this.request("POST", "/jobinfo/start", { id });
  }

  /** 停止任务调度 */
  async stopJob(id: number): Promise<void> {
    await this.request("POST", "/jobinfo/stop", { id });
  }

  /** 删除任务 */
  async removeJob(id: number): Promise<void> {
    await this.request("POST", "/jobinfo/remove", { id });
  }

  /** 手动触发一次执行 */
  async triggerJob(id: number, executorParam?: string, addressList?: string): Promise<void> {
    // trigger 接口要求 executorParam 和 addressList 始终存在（可为空字符串）
    const result = await this.request("POST", "/jobinfo/trigger", {
      id,
      executorParam: executorParam ?? "",
      addressList: addressList ?? "",
    });
    // 检查返回码（trigger 接口成功时 code 可能为 200 或其他）
    if (result.code !== undefined && result.code !== 200) {
      throw new XxlJobApiError(result.msg || `接口 /jobinfo/trigger 返回错误`, result.code, "/jobinfo/trigger");
    }
  }

  /** 预演未来触发时间（Admin 默认返回未来 5 次） */
  async nextTriggerTimes(scheduleType: string, scheduleConf: string): Promise<string[]> {
    const result = await this.request("GET", "/jobinfo/nextTriggerTime", {
      scheduleType,
      scheduleConf,
    });
    return (result.content as string[]) ?? [];
  }

  // ------------------------------------------------------------------
  // 执行日志
  // ------------------------------------------------------------------

  /** 执行日志分页查询 */
  async listJobLogs(
    page: number,
    pageSize: number,
    filter: {
      jobGroup?: number;
      jobId?: number;
      /** 1=成功，2=失败，3=进行中 */
      logStatus?: number;
      /** 调度时间过滤，格式 yyyy-MM-dd HH:mm:ss */
      filterTimeStart?: string;
      filterTimeEnd?: string;
    } = {},
  ): Promise<PageResult<XxlJobLog>> {
    let filterTime: string | undefined;
    if (filter.filterTimeStart && filter.filterTimeEnd) {
      filterTime = `${filter.filterTimeStart} - ${filter.filterTimeEnd}`;
    }
    return this.requestPage<XxlJobLog>("POST", "/joblog/pageList", {
      start: (page - 1) * pageSize,
      length: pageSize,
      jobGroup: filter.jobGroup ?? 0,
      jobId: filter.jobId ?? 0,
      logStatus: filter.logStatus ?? -1,
      filterTime: filterTime ?? "",
    });
  }

  /** 增量拉取执行器上的日志正文 */
  async logDetailCat(logId: number, executorAddress: string, triggerTime: number | string, fromLineNum = 1): Promise<LogDetailCat> {
    const result = await this.request("GET", "/joblog/logDetailCat", {
      logId,
      executorAddress,
      triggerTime,
      fromLineNum,
    });
    const detail = result.content as LogDetailCat;
    // 部分版本不返回 isEnd：内容为空即视为已读完，避免调用方无限续读
    if (detail && detail.isEnd === undefined) {
      detail.isEnd = !detail.logContent || detail.logContent.trim().length === 0;
    }
    return detail;
  }
}
