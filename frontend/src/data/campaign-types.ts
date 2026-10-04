/** 防火宣传领域模型：活动、覆盖村组、名册、归档、导入失败项、核查项共用同一套类型。 */

export const CAMPAIGN_STATUSES = ['待开展', '进行中', '已完成', '已取消'] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

/** 覆盖村组：受众数以村组明细为准，所有汇总都从这里现算，不缓存旧汇总。 */
export type CampaignGroup = {
  /** 规范化后的村组名（去空白后的组名），同活动内同名村组合并到一条 */
  village: string
  /** 原始写法，展示时保留第一次导入/登记时的样子 */
  label: string
  audience: number
}

export type CampaignRecord = {
  id: number
  /** 活动编号，历史名册按「活动编号 + 原活动日期」归并 */
  code: string
  subject: string
  method: string
  staff: string
  /** 原活动日期：任何修正、合并、归档都不改动这个字段 */
  date: string
  status: CampaignStatus
  groups: CampaignGroup[]
  abnormal: boolean
  /** 已并入门册的原始行签名：同一份名册重复导入时整行跳过，受众不重复累加 */
  rosterKeys?: string[]
  /** 历史兼容：迁移前旧版本里无法解析的受众人数字段原样保留 */
  legacyAudience?: string
  /** 历史兼容：旧数据没有村组明细时置真，覆盖统计仍按村组口径计算 */
  legacy?: boolean
}

/** 归档版本：并发归档只有一个版本能落库，重复导入同一活动不会再产生新归档 */
export type CampaignArchive = {
  /** 归档归属键：活动编号 + 原活动日期 */
  key: string
  activityId: number
  code: string
  subject: string
  date: string
  /** 归档时的活动原日期，与活动当前日期必须一致，错位即视为状态错位 */
  originDate: string
  audience: number
  villageCount: number
  version: number
  archivedAt: string
  /** 归档清单文件名，供重新下载 */
  filename: string
}

export type ImportFailure = {
  /** 失败项在导入批次里的行号（含表头从 2 起） */
  row: number
  raw: Record<string, string>
  reason: string
  /** 已保留的失败项可继续处理：修正后再次提交，成功则移除 */
  kept: boolean
  importedAt: string
}

export type ImportResult = {
  imported: number
  merged: number
  skipped: number
  /** 本次解析出但未能入库的行，保留原因，允许后续继续处理 */
  failures: ImportFailure[]
}

export type VillageCoverage = {
  village: string
  label: string
  /** 覆盖到该村组的活动数（已取消活动不计） */
  activities: number
  /** 该村组累计受众人次（已取消活动不计） */
  audience: number
}

export type CoverageStats = {
  monthCount: number
  completedCount: number
  /** 覆盖人次：受众只认真实开展/完成的活动，已取消活动不计 */
  totalAudience: number
  cancelledCount: number
  villageCoverage: VillageCoverage[]
}

export type CheckItem = {
  id: string
  source: 'campaign' | 'checkpoint'
  refId: number
  title: string
  detail: string
  date: string
  pending: boolean
}

/** 归档/取数前置校验结果：归档状态错位或记录丢失时一律不得继续 */
export type IntegrityIssue = {
  level: 'error'
  scope: string
  message: string
}
