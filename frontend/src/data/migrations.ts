import type { EntryRow } from './types'
import type { RosterRow } from './campaign/types'

/**
 * 本地数据结构版本。
 *  v1：仓库初始化版本，宣传活动的受众/村组/活动状态是占位样例，且没有名册、归档等集合。
 *  v2：宣传与名册取数链路打通；历史名册按原活动日期保留。
 */
export const CURRENT_SCHEMA_VERSION = 2

type StoreShape = Record<string, unknown>

const toNumber = (value: unknown): number => {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/** 把「青松村一组、青松村二组」拆成有序去重的村组数组。 */
export function splitVillages(text: unknown): string[] {
  const seen: string[] = []
  String(text ?? '')
    .split(/[、,，;；\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((village) => {
      if (!seen.includes(village)) {
        seen.push(village)
      }
    })
  return seen
}

/** 判断老名册是否属于占位样例（活动或村组名里带「样例」），需要丢弃重建。 */
function isPlaceholderRoster(rows: RosterRow[]): boolean {
  return rows.some(
    (row) => String(row.活动编号 ?? '').includes('样例') || String(row.村组 ?? '').includes('样例'),
  )
}

/**
 * 由活动主表兜底生成历史名册：
 * 没有独立明细时，按主表上的村组与受众原数平均拆分（不整除的余数补给第一个村组），
 * 原始活动日期沿用主表活动日期，保持原样不改写。
 */
export function rosterFromCampaign(row: EntryRow): RosterRow[] {
  const villages = splitVillages(row['覆盖村组'])
  const total = toNumber(row['受众人数'])
  if (!villages.length) {
    return []
  }
  const base = Math.floor(total / villages.length)
  let remainder = total - base * villages.length
  const date = String(row['活动日期'] ?? '').trim()
  return villages.map((village) => {
    const extra = remainder > 0 ? 1 : 0
    remainder -= extra
    return {
      key: `${row['活动编号']}|${village}`,
      活动编号: String(row['活动编号']),
      村组: village,
      受众人数: base + extra,
      ...(date ? { 原始活动日期: date } : {}),
      来源: '历史迁移',
    }
  })
}

export function migrate(store: StoreShape, fromVersion: number, raw?: StoreShape): StoreShape {
  if (fromVersion < 2) {
    migrateCampaignDomain(store, raw ?? store)
  }
  return store
}

/**
 * v1 -> v2：规范宣传活动主表，并补齐与之匹配的历史名册。原活动日期一律保持原样。
 * raw 是尚未与种子合并的原始存档，用它判断用户是否真的保存过名册集合
 * （合并后的 store 一定含种子名册，无法区分）。
 */
function migrateCampaignDomain(store: StoreShape, raw: StoreShape): void {
  const campaigns = (store['campaign'] as EntryRow[] | undefined) ?? []
  const hadRoster = Object.prototype.hasOwnProperty.call(raw, 'campaignRoster')

  const normalized: EntryRow[] = campaigns.map((row) => {
    const status = String(row.status ?? row['活动状态'] ?? '待开展')
    const audience = toNumber(row['受众人数'])
    return {
      ...row,
      status,
      pending: status !== '已完成' && status !== '已取消',
      abnormal: false,
      '受众人数': audience,
      '活动状态': status,
      '覆盖村组': splitVillages(row['覆盖村组']).join('、'),
      '版本': typeof row['版本'] === 'number' ? row['版本'] : 1,
      '已归档': Boolean(row['已归档']),
    }
  })
  store['campaign'] = normalized

  const codes = new Set(normalized.map((row) => String(row['活动编号'])))
  const rawRoster = hadRoster ? (store['campaignRoster'] as RosterRow[] | undefined) ?? [] : []
  // 只有「用户自己保存过」的名册才按原样保留（仍须能对上现存活动、且非占位样例）；
  // v1 老存档里根本没有名册集合，此时绝不能沿用种子补进来的明细，必须完全以主表重建。
  const kept = hadRoster
    ? rawRoster.filter(
        (row) =>
          row &&
          typeof row.key === 'string' &&
          codes.has(String(row.活动编号)) &&
          !isPlaceholderRoster([row]),
      )
    : []
  const haveKeys = new Set(kept.map((row) => row.key))
  const rebuilt = normalized.flatMap((row) =>
    rosterFromCampaign(row).filter((item) => !haveKeys.has(item.key)),
  )
  store['campaignRoster'] = [...kept, ...rebuilt]

  if (!Array.isArray(store['campaignArchives'])) {
    store['campaignArchives'] = []
  }
  if (!Array.isArray(store['importFailures'])) {
    store['importFailures'] = []
  }
  if (!Array.isArray(store['checkTodos'])) {
    store['checkTodos'] = []
  }
}
