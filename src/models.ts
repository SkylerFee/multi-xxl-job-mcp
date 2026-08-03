/**
 * 数据结构与默认值：对应 XXL-JOB Admin 2.3.0+ 的任务模型。
 */

/** XXL-JOB Admin 统一返回体 ReturnT */
export interface ReturnT<T = unknown> {
  code: number;
  msg: string | null;
  content: T;
}

/**
 * DataTables 风格分页结果。
 * 标准 2.x 返回 recordsTotal；部分版本/二开版返回 recordsFiltered，两者兼容。
 */
export interface PageResult<T> {
  recordsTotal?: number;
  recordsFiltered?: number;
  data: T[];
}

/** 统一读取分页总数（兼容 recordsTotal / recordsFiltered） */
export function pageTotal<T>(page: PageResult<T>): number {
  return page.recordsTotal ?? page.recordsFiltered ?? page.data?.length ?? 0;
}

/** 执行器组 */
export interface XxlJobGroup {
  id: number;
  appname: string;
  title: string;
  /** 注册方式：0=自动注册，1=手动录入 */
  addressType: number;
  addressList: string | null;
  updateTime: string | null;
  registryList?: string[];
}

/** 任务信息（对应 xxl_job_info 表） */
export interface XxlJobInfo {
  id: number;
  jobGroup: number;
  jobDesc: string;
  addTime: string | null;
  updateTime: string | null;
  author: string | null;
  alarmEmail: string | null;
  /** 调度类型：CRON / FIX_RATE / NONE */
  scheduleType: string;
  scheduleConf: string | null;
  /** 调度过期策略：DO_NOTHING / FIRE_ONCE_NOW */
  misfireStrategy: string;
  /** 执行器路由策略：FIRST / LAST / ROUND / RANDOM / ... */
  executorRouteStrategy: string;
  executorHandler: string | null;
  executorParam: string | null;
  /** 阻塞处理策略：SERIAL_EXECUTION / DISCARD_LATER / COVER_EARLY */
  executorBlockStrategy: string;
  executorTimeout: number;
  executorFailRetryCount: number;
  /** 运行模式：BEAN / GLUE_GROOVY / ... */
  glueType: string;
  glueSource: string | null;
  glueRemark: string | null;
  glueUpdatetime: string | null;
  childJobId: string | null;
  /** 调度状态：0=停止，1=运行中 */
  triggerStatus: number;
  triggerLastTime: number;
  triggerNextTime: number;
}

/** 执行日志（对应 xxl_job_log 表） */
export interface XxlJobLog {
  id: number;
  jobGroup: number;
  jobId: number;
  executorAddress: string | null;
  executorHandler: string | null;
  executorParam: string | null;
  executorShardingParam: string | null;
  executorFailRetryCount: number;
  triggerTime: string | null;
  /** 调度结果：0=失败，1=成功 */
  triggerCode: number;
  triggerMsg: string | null;
  handleTime: string | null;
  /** 执行结果：0=失败，1=成功，2=无（未执行完） */
  handleCode: number;
  handleMsg: string | null;
  /** 报警状态：0=无，1=成功，2=失败，3=进行中 */
  alarmStatus: number;
}

/** 日志正文增量拉取结果 */
export interface LogDetailCat {
  fromLineNum: number;
  toLineNum: number;
  logContent: string;
  /** 日志是否已输出完毕 */
  isEnd: boolean;
}

/** 新增任务的入参（add_job 工具） */
export interface AddJobParams {
  jobGroup: number;
  jobDesc: string;
  scheduleType: "CRON" | "FIX_RATE" | "NONE";
  scheduleConf?: string;
  executorHandler: string;
  executorParam?: string;
  executorRouteStrategy?: string;
  executorBlockStrategy?: string;
  executorTimeout?: number;
  executorFailRetryCount?: number;
  misfireStrategy?: string;
  author?: string;
  alarmEmail?: string;
  childJobId?: string;
  glueType?: string;
}

/** add_job 的默认值（与 Admin 页面上的常用默认一致） */
export const JOB_DEFAULTS = {
  scheduleType: "CRON",
  misfireStrategy: "DO_NOTHING",
  executorRouteStrategy: "FIRST",
  executorBlockStrategy: "SERIAL_EXECUTION",
  executorTimeout: 0,
  executorFailRetryCount: 0,
  glueType: "BEAN",
} as const;

/** 校验 Cron 表达式的基础格式（秒 分 时 日 月 周 [年]，6~7 段） */
export function validateCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 6 || parts.length > 7) {
    return `Cron 表达式应为 6~7 段（秒 分 时 日 月 周 [年]），当前为 ${parts.length} 段: "${cron}"`;
  }
  return null;
}

/** 校验 scheduleConf 与 scheduleType 的匹配性，返回错误信息或 null */
export function validateSchedule(scheduleType: string, scheduleConf: string | undefined): string | null {
  if (scheduleType === "CRON") {
    if (!scheduleConf || !scheduleConf.trim()) {
      return "scheduleType=CRON 时必须提供 scheduleConf（Cron 表达式）";
    }
    return validateCron(scheduleConf);
  }
  if (scheduleType === "FIX_RATE") {
    const n = Number(scheduleConf);
    if (!scheduleConf || !Number.isInteger(n) || n < 1) {
      return "scheduleType=FIX_RATE 时 scheduleConf 必须为 >=1 的整数秒数";
    }
  }
  return null;
}

/** triggerStatus 的中文描述 */
export function triggerStatusText(status: number): string {
  return status === 1 ? "运行中" : "停止";
}
