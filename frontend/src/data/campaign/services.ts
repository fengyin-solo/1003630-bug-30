import { listRows, readCollection, saveRows, writeCollection } from '../local-store'
import { splitVillages } from '../migrations'
import type { EntryRow } from '../types'
import type {
  ArchiveRecord,
  CampaignStatus,
  CampaignView,
  CampaignViewItem,
  ImportFailure,
  RosterRow,
  VillageCoverage,
} from './types'

const CAMPAIGN_KEY = 'campaign'
const ROSTER_KEY = 'campaignRoster'
const ARCHIVE_KEY = 'campaignArchives'
const FAILURE_KEY = 'importFailures'

const TERMINAL_STATUSES: CampaignStatus[] = ['已完成', '已取消']

// ---------------------------------------------------------------------------
// 基础读写
// ---------------------------------------------------------------------------

function campaigns(): EntryRow[] {
  return listRows(CAMPAIGN_KEY)
}

function saveCampaigns(rows: EntryRow[]): void {
  saveRows(CAMPAIGN_KEY, rows)
}

function roster(): RosterRow[] {
  return readCollection<RosterRow>(ROSTER_KEY)
}

function archives(): ArchiveRecord[] {
  return readCollection<ArchiveRecord>(ARCHIVE_KEY)
}

function failures(): ImportFailure[] {
  return readCollection<ImportFailure>(FAILURE_KEY)
}

const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const rosterKey = (code: string, village: string): string => `${code}|${village}`

// ---------------------------------------------------------------------------
// 名册合并（重复村组的合并口径由这里统一决定）
// ---------------------------------------------------------------------------
// 合并方式：同一活动下村组名相同即视为同一村组，
//   - 明细只保留一条（保序：以首次出现顺序为准）；
//   - 受众人数累加；
//   - 原始活动日期保留较早的一条（历史名册按原活动日期兼容，不回填主表日期）。
function rosterByCode(rows: RosterRow[]): Map<string, RosterRow[]> {
  const map = new Map<string, RosterRow[]>()
  for (const row of rows) {
    const list = map.get(row.活动编号) ?? []
    list.push(row)
    map.set(row.活动编号, list)
  }
  return map
}

/** 把某活动的名册明细按村组合并去重，返回保序的村组与受众。 */
function mergeVillages(details: RosterRow[]): { villages: string[]; audience: number } {
  const order: string[] = []
  const audienceByVillage = new Map<string, number>()
  for (const detail of details) {
    const village = detail.村组
    if (!village) {
      continue
    }
    if (!audienceByVillage.has(village)) {
      order.push(village)
      audienceByVillage.set(village, 0)
    }
    audienceByVillage.set(village, (audienceByVillage.get(village) ?? 0) + num(detail.受众人数))
  }
  let audience = 0
  audienceByVillage.forEach((value) => {
    audience += value
  })
  return { villages: order, audience }
}

// ---------------------------------------------------------------------------
// 统一聚合：活动列表 / 覆盖统计 / 归档 全部从这里取数
// ---------------------------------------------------------------------------

function toViewItem(row: EntryRow, details: RosterRow[], archived: boolean): CampaignViewItem {
  const status = String(row.status) as CampaignStatus
  const { villages, audience } = mergeVillages(details)
  return {
    id: Number(row.id),
    活动编号: String(row['活动编号'] ?? ''),
    宣传主题: String(row['宣传主题'] ?? ''),
    宣传方式: String(row['宣传方式'] ?? ''),
    执行人员: String(row['执行人员'] ?? ''),
    活动日期: String(row['活动日期'] ?? ''),
    活动状态: status,
    status,
    pending: !TERMINAL_STATUSES.includes(status),
    abnormal: Boolean(row.abnormal),
    覆盖村组: villages,
    覆盖村组文本: villages.join('、'),
    受众人数: audience,
    原始受众人数: num(row['受众人数']),
    版本: typeof row['版本'] === 'number' ? (row['版本'] as number) : 1,
    已归档: archived,
  }
}

/** 统一取数入口。month 形如 '2026-10'，按名册里的原活动日期统计本月活动。 */
export function buildView(month?: string): CampaignView {
  const rows = campaigns()
  const detailsByCode = rosterByCode(roster())
  const archiveByCode = new Map(archives().map((record) => [record.活动编号, record]))

  const items = rows.map((row) => {
    const code = String(row['活动编号'] ?? '')
    return toViewItem(row, detailsByCode.get(code) ?? [], archiveByCode.has(code))
  })

  // 覆盖统计：已取消活动不计入；日期取名册原始活动日期（无则回退主表日期）。
  const villageMap = new Map<string, VillageCoverage>()
  let coveredAudience = 0
  for (const item of items) {
    if (item.活动状态 === '已取消') {
      continue
    }
    const details = (detailsByCode.get(item.活动编号) ?? []).filter((d) => d.村组)
    for (const detail of details) {
      const current = villageMap.get(detail.村组) ?? {
        村组: detail.村组,
        活动场次: 0,
        受众人次: 0,
      }
      current.活动场次 += 1
      current.受众人次 += num(detail.受众人数)
      villageMap.set(detail.村组, current)
    }
    coveredAudience += item.受众人数
  }

  const monthPrefix =
    month ?? new Date().toISOString().slice(0, 7)
  const monthCount = items.filter((item) => {
    if (item.活动状态 === '已取消') {
      return false
    }
    return effectiveMonth(item.活动编号, items, detailsByCode) === monthPrefix
  }).length

  return {
    items,
    total: items.length,
    villages: [...villageMap.values()],
    coveredAudience,
    monthCount,
    completedCount: items.filter((item) => item.活动状态 === '已完成').length,
    archives: archives(),
  }
}

/** 某活动用于统计的月份：名册里最早的原始活动日期；没有则回退主表日期。 */
function effectiveMonth(
  code: string,
  items: CampaignViewItem[],
  detailsByCode: Map<string, RosterRow[]>,
): string {
  const dates = (detailsByCode.get(code) ?? [])
    .map((detail) => String(detail.原始活动日期 ?? '').trim())
    .filter(Boolean)
    .sort()
  const fallback = items.find((item) => item.活动编号 === code)?.活动日期 ?? ''
  return (dates[0] ?? fallback).slice(0, 7)
}

/** 活动列表页筛选（按宣传主题/方式/村组模糊匹配）。 */
export function queryCampaigns(filters: Record<string, string> = {}): CampaignView {
  const view = buildView()
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (!pairs.length) {
    return view
  }
  const items = view.items.filter((item) =>
    pairs.every(([field, value]) => {
      const keyword = value.trim()
      if (field === '覆盖村组') {
        return item.覆盖村组文本.includes(keyword)
      }
      return String(item[field as keyof CampaignViewItem] ?? '').includes(keyword)
    }),
  )
  return { ...view, items, total: items.length }
}

// ---------------------------------------------------------------------------
// 活动状态流转：取消后受众立即从覆盖中扣除（取消态不参与聚合）
// ---------------------------------------------------------------------------

const NEXT_STATUS: Record<string, CampaignStatus> = {
  开展活动: '进行中',
  确认完成: '已完成',
  取消活动: '已取消',
}

export function campaignAction(id: number, action: string): { ok: boolean; message: string } {
  const target = NEXT_STATUS[action]
  if (!target) {
    return { ok: false, message: `防火宣传活动没有登记「${action}」这个动作` }
  }
  const rows = campaigns()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的防火宣传活动` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `防火宣传活动已经是「${target}」，不用重复操作` }
  }
  if (current === '已取消') {
    return { ok: false, message: '活动已取消，不能再改变状态；如需恢复请重新登记' }
  }
  // 每次状态变化都推进版本，作为并发归档的乐观锁依据。
  const version = (typeof rows[index]['版本'] === 'number' ? (rows[index]['版本'] as number) : 1) + 1
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    '活动状态': target,
    pending: !TERMINAL_STATUSES.includes(target),
    abnormal: false,
    '版本': version,
  }
  const next = [...rows]
  next[index] = updated
  saveCampaigns(next)
  return { ok: true, message: `防火宣传活动已${action}，当前状态「${target}」` }
}

// ---------------------------------------------------------------------------
// 村组修正：改主表村组并同步合并名册，旧汇总不会残留
// ---------------------------------------------------------------------------

/**
 * 修正覆盖村组。传入修正后的完整村组列表；
 * 名册按新口径重建：仍保留的村组沿用明细，新增村组以 0 受众占位，被删掉的村组连同受众一起移除。
 */
export function correctVillages(
  id: number,
  rawVillages: string,
): { ok: boolean; message: string } {
  const rows = campaigns()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的防火宣传活动` }
  }
  const row = rows[index]
  const code = String(row['活动编号'] ?? '')
  const wanted = splitVillages(rawVillages)

  const details = roster().filter((item) => item.活动编号 === code)
  const keptByVillage = new Map<string, RosterRow>()
  for (const detail of details) {
    if (wanted.includes(detail.村组) && !keptByVillage.has(detail.村组)) {
      keptByVillage.set(detail.村组, detail)
    }
  }
  const merged: RosterRow[] = wanted.map((village) => {
    const existing = keptByVillage.get(village)
    if (existing) {
      return existing
    }
    return {
      key: rosterKey(code, village),
      活动编号: code,
      村组: village,
      受众人数: 0,
      原始活动日期: String(row['活动日期'] ?? ''),
      来源: '村组修正',
    }
  })

  const otherDetails = roster().filter((item) => item.活动编号 !== code)
  writeCollection(ROSTER_KEY, [...otherDetails, ...merged])

  const { audience } = mergeVillages(merged)
  const version = (typeof row['版本'] === 'number' ? (row['版本'] as number) : 1) + 1
  const updated: EntryRow = {
    ...row,
    '覆盖村组': wanted.join('、'),
    '受众人数': audience,
    '版本': version,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveCampaigns(nextRows)
  return { ok: true, message: `已按 ${wanted.length} 个村组重新合并，旧汇总已清除` }
}

// ---------------------------------------------------------------------------
// 名册导入：重复活动/村组走合并，失败项带原因保留并可继续处理
// ---------------------------------------------------------------------------

export type ImportPreview = {
  /** 解析成功、待合并的明细（已按 活动+村组 合并）。 */
  accepted: RosterRow[]
  /** 解析失败的原始行，带原因，供界面保留。 */
  failures: ImportFailure[]
  /** 命中了已有活动，归档视图里按此提示「重复导入」。 */
  touchedCodes: string[]
  newCodes: string[]
}

type RawImportRow = { 活动编号: string; 村组: string; 受众人数: string; 活动日期: string }

/** 解析粘贴的 CSV/制表符文本，不直接落库。 */
export function parseRosterText(text: string): ImportPreview {
  const codes = new Set(campaigns().map((row) => String(row['活动编号'] ?? '')))
  const acceptedByKey = new Map<string, RosterRow>()
  const failures: ImportFailure[] = []
  const failureKeys = new Set<string>()

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  lines.forEach((line, index) => {
    // 行内只按逗号/制表符拆字段；顿号「、」是村组名的合法组成部分，不能当分隔符。
    const cells = line.split(/[,\t，]/).map((cell) => cell.trim())
    const [code = '', village = '', audienceText = '', dateText = ''] = cells
    const seq = `${code}|${village}|${index + 1}`

    if (!code) {
      pushFailure(failures, failureKeys, seq, code, village, audienceText, dateText, '缺少活动编号')
      return
    }
    if (!codes.has(code)) {
      pushFailure(failures, failureKeys, seq, code, village, audienceText, dateText, `活动编号 ${code} 不存在`)
      return
    }
    if (!village) {
      pushFailure(failures, failureKeys, seq, code, village, audienceText, dateText, '缺少村组')
      return
    }
    const audience = Number(audienceText)
    if (audienceText === '' || !Number.isFinite(audience) || audience < 0) {
      pushFailure(failures, failureKeys, seq, code, village, audienceText, dateText, '受众人数不是非负数字')
      return
    }
    if (dateText && !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
      pushFailure(failures, failureKeys, seq, code, village, audienceText, dateText, '活动日期格式应为 YYYY-MM-DD')
      return
    }

    // 同一批次内重复村组：受众累加，日期取较早一条。
    const key = rosterKey(code, village)
    const existing = acceptedByKey.get(key)
    if (existing) {
      existing.受众人数 += Math.floor(audience)
      if (dateText && (!existing.原始活动日期 || dateText < existing.原始活动日期)) {
        existing.原始活动日期 = dateText
      }
    } else {
      const campaign = campaigns().find((row) => String(row['活动编号']) === code)
      acceptedByKey.set(key, {
        key,
        活动编号: code,
        村组: village,
        受众人数: Math.floor(audience),
        ...(dateText
          ? { 原始活动日期: dateText }
          : { 原始活动日期: String(campaign?.['活动日期'] ?? '') }),
        来源: '导入',
      })
    }
  })

  const accepted = [...acceptedByKey.values()]
  const touchedCodes = [...new Set(accepted.map((row) => row.活动编号))]
  return {
    accepted,
    failures,
    touchedCodes,
    newCodes: touchedCodes.filter((code) => !codes.has(code)),
  }
}

function pushFailure(
  failures: ImportFailure[],
  seen: Set<string>,
  key: string,
  code: string,
  village: string,
  audience: string,
  date: string,
  reason: string,
): void {
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  failures.push({ key, 活动编号: code, 村组: village, 受众人数: audience, 活动日期: date, 原因: reason })
}

/**
 * 确认导入：合法项合并进名册（重复村组受众累加、旧汇总随之刷新）；
 * 失败项持久保留并带原因，不影响合法项入库，之后可修正再继续处理。
 * 返回受影响活动编号，便于随后导出活动清单。
 */
export function commitImport(preview: ImportPreview): {
  ok: boolean
  message: string
  mergedCodes: string[]
} {
  const gate = verifyArchiveIntegrity()
  if (!gate.ok) {
    return { ok: false, message: gate.message, mergedCodes: [] }
  }

  const current = roster()
  const byKey = new Map(current.map((row) => [row.key, row]))
  for (const incoming of preview.accepted) {
    const existing = byKey.get(incoming.key)
    if (existing) {
      existing.受众人数 += incoming.受众人数
      if (incoming.原始活动日期) {
        if (!existing.原始活动日期 || incoming.原始活动日期 < existing.原始活动日期) {
          existing.原始活动日期 = incoming.原始活动日期
        }
      }
    } else {
      const created: RosterRow = { ...incoming }
      byKey.set(created.key, created)
    }
  }
  writeCollection(ROSTER_KEY, [...byKey.values()])

  // 主表村组与受众随名册重新合并，避免旧汇总残留；活动日期保持原样不动。
  const rows = campaigns()
  const detailsByCode = rosterByCode(roster())
  const nextRows = rows.map((row) => {
    const code = String(row['活动编号'] ?? '')
    const { villages, audience } = mergeVillages(detailsByCode.get(code) ?? [])
    return {
      ...row,
      '覆盖村组': villages.join('、'),
      '受众人数': audience,
    }
  })
  saveCampaigns(nextRows)

  // 失败项与本次解析结果合并保留（同键覆盖为最新原因）。
  const priorFailures = failures().filter((item) => !preview.failures.some((f) => f.key === item.key))
  writeCollection(FAILURE_KEY, [...priorFailures, ...preview.failures])

  return {
    ok: true,
    message: `已合并 ${preview.accepted.length} 条名册明细，${preview.failures.length} 条失败项已保留原因`,
    mergedCodes: preview.touchedCodes,
  }
}

/** 修正一条失败项后重试：合法则并入名册并从失败清单移除。 */
export function retryFailure(key: string, patch: Partial<RawImportRow>): { ok: boolean; message: string } {
  const current = failures()
  const index = current.findIndex((item) => item.key === key)
  if (index < 0) {
    return { ok: false, message: '失败项不存在或已处理' }
  }
  const fixed = { ...current[index], ...patch }
  const preview = parseRosterText(
    `${fixed.活动编号},${fixed.村组},${fixed.受众人数},${fixed.活动日期}`,
  )
  const rest = current.filter((item) => item.key !== key)
  if (preview.failures.length) {
    writeCollection(
      FAILURE_KEY,
      rest.map((item) =>
        item.key === key ? { ...item, ...patch, 原因: preview.failures[0].原因 } : item,
      ),
    )
    return { ok: false, message: preview.failures[0].原因 }
  }
  const result = commitImport({ ...preview, failures: [] })
  writeCollection(FAILURE_KEY, rest)
  return result.ok
    ? { ok: true, message: '失败项已修正并并入名册' }
    : { ok: false, message: result.message }
}

export function discardFailure(key: string): void {
  writeCollection(
    FAILURE_KEY,
    failures().filter((item) => item.key !== key),
  )
}

export function listFailures(): ImportFailure[] {
  return failures()
}

// ---------------------------------------------------------------------------
// 归档：并发只接受一个版本；重复归档收敛；归档错位/记录丢失时拒绝继续
// ---------------------------------------------------------------------------

export type ArchiveAttempt = {
  ok: boolean
  message: string
  record?: ArchiveRecord
}

/**
 * 归档一个已完成活动。
 * expectedVersion 是打开归档确认时看到的活动版本；
 * 若活动在确认前又被改动（版本推进）或已被其他操作者归档，则本次拒绝，只接受一个版本。
 */
export function archiveCampaign(id: number, expectedVersion: number, operator: string): ArchiveAttempt {
  const gate = verifyArchiveIntegrity()
  if (!gate.ok) {
    return { ok: false, message: gate.message }
  }

  const rows = campaigns()
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的活动，归档中止` }
  }
  const code = String(row['活动编号'] ?? '')
  const currentVersion = typeof row['版本'] === 'number' ? (row['版本'] as number) : 1
  if (currentVersion !== expectedVersion) {
    return {
      ok: false,
      message: `活动 ${code} 已被改动（版本 ${expectedVersion} → ${currentVersion}），请刷新后基于最新版本归档`,
    }
  }
  if (String(row.status) !== '已完成') {
    return { ok: false, message: `活动 ${code} 当前为「${row.status}」，只有已完成活动允许归档` }
  }

  const details = roster().filter((item) => item.活动编号 === code)
  const { villages, audience } = mergeVillages(details)
  if (!villages.length) {
    return { ok: false, message: `活动 ${code} 没有任何覆盖村组，拒绝归档空记录` }
  }

  const existing = archives()
  const duplicate = existing.find((record) => record.活动编号 === code)
  if (duplicate && duplicate.版本 === currentVersion) {
    return { ok: false, message: `活动 ${code} 已归档（版本 ${currentVersion}），同一版本不重复归档`, record: duplicate }
  }

  const record: ArchiveRecord = {
    id: duplicate?.id ?? nextArchiveId(existing),
    活动编号: code,
    宣传主题: String(row['宣传主题'] ?? ''),
    覆盖村组: villages,
    受众合计: audience,
    版本: currentVersion,
    归档时间: new Date().toISOString(),
    归档人: operator || '值班员',
  }

  // 重复归档（活动再次走到已完成）：同编号只保留一条，旧记录被新版本覆盖，不重复显示。
  const kept = existing.filter((recordItem) => recordItem.活动编号 !== code)
  writeCollection(ARCHIVE_KEY, [...kept, record])

  const nextRows = rows.map((item) =>
    Number(item.id) === id ? { ...item, 已归档: true } : item,
  )
  saveCampaigns(nextRows)
  return {
    ok: true,
    message: duplicate
      ? `活动 ${code} 已按版本 ${currentVersion} 重新归档，旧归档已收敛`
      : `活动 ${code} 归档完成（版本 ${currentVersion}）`,
    record,
  }
}

function nextArchiveId(rows: ArchiveRecord[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
}

/**
 * 归档完整性校验：归档状态错位或归档记录丢失时不得继续。
 *  - 主表标了已归档，但 archives 里找不到记录 → 状态错位；
 *  - archives 里有记录，但主表活动丢失或不是已完成 → 记录丢失/错位。
 */
export function verifyArchiveIntegrity(): { ok: boolean; message: string; problems: string[] } {
  const rows = campaigns()
  const records = archives()
  const byCode = new Map(rows.map((row) => [String(row['活动编号'] ?? ''), row]))
  const problems: string[] = []

  for (const row of rows) {
    if (row['已归档'] === true) {
      const code = String(row['活动编号'] ?? '')
      const record = records.find((item) => item.活动编号 === code)
      if (!record) {
        problems.push(`活动 ${code} 标记为已归档，但归档记录丢失`)
      }
    }
  }
  for (const record of records) {
    const row = byCode.get(record.活动编号)
    if (!row) {
      problems.push(`归档记录 ${record.活动编号} 对应的活动已丢失`)
    } else if (String(row.status) !== '已完成') {
      problems.push(`归档记录 ${record.活动编号} 与当前状态「${row.status}」错位`)
    }
  }

  if (problems.length) {
    return { ok: false, message: `归档数据异常，已停止处理：${problems.join('；')}`, problems }
  }
  return { ok: true, message: '归档数据完整', problems: [] }
}

// ---------------------------------------------------------------------------
// 导出：处理确认后生成可下载的活动清单（CSV）
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 生成合并后的活动清单 CSV 文本（取消活动受众列 0，覆盖村组为合并结果）。 */
export function buildCampaignCsv(): { filename: string; content: string } {
  const view = buildView()
  const header = ['活动编号', '宣传主题', '宣传方式', '覆盖村组', '执行人员', '活动日期', '受众人数', '活动状态', '版本', '已归档']
  const lines = [header.join(',')]
  for (const item of view.items) {
    const audience = item.活动状态 === '已取消' ? 0 : item.受众人数
    lines.push(
      [
        item.活动编号,
        item.宣传主题,
        item.宣传方式,
        item.覆盖村组文本,
        item.执行人员,
        item.活动日期,
        audience,
        item.活动状态,
        item.版本,
        item.已归档 ? '是' : '否',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: `防火宣传活动清单-${new Date().toISOString().slice(0, 10)}.csv`, content: `﻿${lines.join('\n')}` }
}

export type { CampaignView, VillageCoverage }
