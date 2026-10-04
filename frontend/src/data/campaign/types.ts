/**
 * 防火宣传领域模型。
 *
 * 取数链路只有一条：
 *   活动主表 campaigns（含受众原数、村组、活动日期、归档版本）
 *     + 宣传名册 roster（按「活动编号 + 村组」的明细）
 *   ——由 services.ts 统一聚合为活动列表、覆盖统计与归档记录。
 * 活动列表、覆盖统计、检查站核查三处都从同一聚合结果取数，不再各算各的。
 */

/** 活动主表状态。已取消的活动不计入覆盖；已完成才允许归档。 */
export type CampaignStatus = '待开展' | '进行中' | '已完成' | '已取消'

/** 宣传名册中的一条村组明细。同活动下同村组只保留一条，受众合并。 */
export type RosterRow = {
  /** 业务主键：活动编号 + '|' + 村组 */
  key: string
  活动编号: string
  村组: string
  /** 本次宣传触达的受众人数。 */
  受众人数: number
  /**
   * 原始活动日期：历史名册按原活动日期兼容，不回填、不改写。
   * 为空表示沿用活动主表的活动日期。
   */
  原始活动日期?: string
  /** 数据来源：种子/手工/导入批次。 */
  来源: string
}

/** 一次导入处理后的失败项，保留失败原因，允许修正后继续处理。 */
export type ImportFailure = {
  key: string
  活动编号: string
  村组: string
  受众人数: string
  活动日期: string
  原因: string
}

/** 归档记录：同一活动的重复归档收敛为一条，只保留一个胜出版本。 */
export type ArchiveRecord = {
  id: number
  活动编号: string
  宣传主题: string
  /** 归档时采用的活动覆盖快照：村组与受众都是合并后的结果。 */
  覆盖村组: string[]
  受众合计: number
  /** 归档基于的活动主表版本；并发归档时只有一个版本胜出。 */
  版本: number
  归档时间: string
  归档人: string
}

/** 覆盖统计里每个村组一行。 */
export type VillageCoverage = {
  村组: string
  活动场次: number
  受众人次: number
}

/** 统一聚合结果：列表、覆盖、归档都从它派生。 */
export type CampaignView = {
  /** 合并村组、扣除已取消后的活动行。 */
  items: CampaignViewItem[]
  total: number
  /** 覆盖统计。 */
  villages: VillageCoverage[]
  /** 覆盖总人次（已取消活动不计入）。 */
  coveredAudience: number
  /** 本月（按原活动日期）活动数。 */
  monthCount: number
  completedCount: number
  archives: ArchiveRecord[]
}

export type CampaignViewItem = {
  id: number
  活动编号: string
  宣传主题: string
  宣传方式: string
  执行人员: string
  活动日期: string
  活动状态: CampaignStatus
  status: CampaignStatus
  pending: boolean
  abnormal: boolean
  /** 合并去重后的村组（保序）。 */
  覆盖村组: string[]
  覆盖村组文本: string
  /** 合并后的受众数。 */
  受众人数: number
  /** 活动主表里登记的受众原数，供核对。 */
  原始受众人数: number
  版本: number
  已归档: boolean
}
