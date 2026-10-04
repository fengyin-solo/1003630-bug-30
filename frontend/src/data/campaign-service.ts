import { allRows, listRows, saveRows, __resetStoreCacheForTest } from './local-store'
import type { EntryRow } from './types'
import type {
  CampaignArchive,
  CampaignGroup,
  CampaignRecord,
  CampaignStatus,
  CheckItem,
  CoverageStats,
  ImportFailure,
  ImportResult,
  IntegrityIssue,
  VillageCoverage,
} from './campaign-types'
import { CAMPAIGN_STATUSES } from './campaign-types'

// 防火宣传有自己的领域存储：活动、归档、导入失败项、核查处置各一份，取数只走这一层。
const CAMPAIGN_KEY = 'forest-fire-patrol:campaign-activities'
const ARCHIVE_KEY = 'forest-fire-patrol:campaign-archives'
const FAILURE_KEY = 'forest-fire-patrol:campaign-import-failures'
const CHECK_DONE_KEY = 'forest-fire-patrol:campaign-check-done'

function storageGet<T>(key: string): T | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function storageSet(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

function normalizeVillage(raw: string): string {
  return raw.trim().replace(/\s+/g, '')
}

function parseAudience(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.trunc(raw))
  const text = String(raw ?? '').trim().replace(/,/g, '')
  if (text === '') return null
  if (!/^\d+$/.test(text)) return null
  return Number(text)
}

/** 同活动内重复村组：按规范化村名合并，受众累加，展示名保留第一次出现的写法。 */
export function mergeGroups(existing: CampaignGroup[], incoming: CampaignGroup[]): CampaignGroup[] {
  const next = existing.map((group) => ({ ...group }))
  const indexByVillage = new Map(next.map((group, index) => [group.village, index]))
  for (const group of incoming) {
    const village = normalizeVillage(group.label)
    if (!village) continue
    const index = indexByVillage.get(village)
    if (index === undefined) {
      next.push({ village, label: group.label.trim() || village, audience: group.audience })
      indexByVillage.set(village, next.length - 1)
    } else {
      next[index].audience += group.audience
    }
  }
  return next
}

function audienceOf(record: CampaignRecord): number {
  return record.groups.reduce((sum, group) => sum + group.audience, 0)
}

// ---------- 历史迁移：旧版通用台账里的宣传记录，按原活动日期原样迁入 ----------

function migrateLegacy(): CampaignRecord[] {
  const legacyRows = listRows('campaign')
  return legacyRows.map((row, order) => {
    const status = CAMPAIGN_STATUSES.includes(String(row.status) as CampaignStatus)
      ? (String(row.status) as CampaignStatus)
      : '待开展'
    const date = String(row['活动日期'] ?? '').trim()
    const rawVillages = String(row['覆盖村组'] ?? '').trim()
    const audience = parseAudience(row['受众人数'])
    const names = rawVillages
      .split(/[、,，;；/\\|\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    const groups: CampaignGroup[] = []
    if (names.length > 0) {
      // 旧台账只有汇总受众，没有村组明细：按村组数均摊，余数给第一个村组。
      const base = audience === null ? 0 : Math.floor(audience / names.length)
      let rest = audience === null ? 0 : audience - base * names.length
      names.forEach((name, index) => {
        const value = base + (index === 0 ? rest : 0)
        rest = index === 0 ? 0 : rest
        groups.push({ village: normalizeVillage(name), label: name, audience: value })
      })
    }
    return {
      id: Number(row.id) || order + 1,
      code: String(row['活动编号'] ?? `CAMP-${order + 1}`).trim(),
      subject: String(row['宣传主题'] ?? '').trim(),
      method: String(row['宣传方式'] ?? '').trim(),
      staff: String(row['执行人员'] ?? '').trim(),
      date,
      status,
      groups,
      abnormal: Boolean(row.abnormal) || audience === null,
      legacy: true,
      legacyAudience: String(row['受众人数'] ?? ''),
    }
  })
}

let cacheActivities: CampaignRecord[] | null = null

function loadActivities(): CampaignRecord[] {
  if (cacheActivities) return cacheActivities
  const stored = storageGet<CampaignRecord[]>(CAMPAIGN_KEY)
  if (stored) {
    cacheActivities = stored
    return stored
  }
  const migrated = migrateLegacy()
  cacheActivities = migrated
  persistActivities(migrated)
  return migrated
}

function toEntryRows(records: CampaignRecord[]): EntryRow[] {
  return records.map((record) => ({
    id: record.id,
    status: record.status,
    pending: record.status !== '已完成' && record.status !== '已取消',
    abnormal: record.abnormal,
    活动编号: record.code,
    宣传主题: record.subject,
    宣传方式: record.method,
    覆盖村组: record.groups.map((group) => group.label).join('、'),
    执行人员: record.staff,
    活动日期: record.date,
    受众人数: audienceOf(record),
    活动状态: record.status,
  }))
}

// 镜像回通用台账，运营概览与其它模块读到的宣传数据与领域层完全一致。
function persistActivities(records: CampaignRecord[]): void {
  cacheActivities = records
  storageSet(CAMPAIGN_KEY, records)
  saveRows('campaign', toEntryRows(records))
}

function loadArchives(): CampaignArchive[] {
  return storageGet<CampaignArchive[]>(ARCHIVE_KEY) ?? []
}

function persistArchives(archives: CampaignArchive[]): void {
  storageSet(ARCHIVE_KEY, archives)
}

function loadFailures(): ImportFailure[] {
  return storageGet<ImportFailure[]>(FAILURE_KEY) ?? []
}

function persistFailures(failures: ImportFailure[]): void {
  storageSet(FAILURE_KEY, failures)
}

function loadCheckDone(): Record<string, boolean> {
  return storageGet<Record<string, boolean>>(CHECK_DONE_KEY) ?? {}
}

// ---------- 完整性校验：归档状态错位或记录丢失时，任何写操作都不得继续 ----------

export function runIntegrityChecks(
  records: CampaignRecord[] = loadActivities(),
  archives: CampaignArchive[] = loadArchives(),
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = []
  const seenIds = new Set<number>()
  const keyToRecord = new Map<string, CampaignRecord>()

  for (const record of records) {
    if (seenIds.has(record.id)) {
      issues.push({ level: 'error', scope: `活动 ${record.id}`, message: '活动编号（id）重复，记录可能丢失' })
    }
    seenIds.add(record.id)
    if (!record.code) {
      issues.push({ level: 'error', scope: `活动 ${record.id}`, message: '活动编号缺失' })
    }
    if (!record.date) {
      issues.push({ level: 'error', scope: record.code || `活动 ${record.id}`, message: '原活动日期缺失' })
    }
    if (!CAMPAIGN_STATUSES.includes(record.status)) {
      issues.push({ level: 'error', scope: record.code, message: `归档状态错位：未知状态「${record.status}」` })
    }
    const villageSeen = new Set<string>()
    for (const group of record.groups) {
      if (!group.village) {
        issues.push({ level: 'error', scope: record.code, message: '存在空村组名，覆盖统计无法计算' })
      }
      if (villageSeen.has(group.village)) {
        issues.push({ level: 'error', scope: record.code, message: `村组「${group.village}」存在未合并的重复明细` })
      }
      villageSeen.add(group.village)
      if (!Number.isInteger(group.audience) || group.audience < 0) {
        issues.push({ level: 'error', scope: record.code, message: `村组「${group.village}」受众人数异常` })
      }
    }
    const key = `${record.code}__${record.date}`
    const other = keyToRecord.get(key)
    if (other) {
      issues.push({
        level: 'error',
        scope: record.code,
        message: `活动编号 + 原活动日期（${record.date}）出现两条记录，归档归属冲突`,
      })
    }
    keyToRecord.set(key, record)
  }

  for (const archive of archives) {
    const owner = keyToRecord.get(archive.key)
    if (!owner) {
      issues.push({ level: 'error', scope: archive.code, message: `归档「${archive.code}」找不到原活动记录，记录丢失，不得继续` })
      continue
    }
    if (owner.status !== '已完成') {
      issues.push({
        level: 'error',
        scope: archive.code,
        message: `归档「${archive.code}」状态错位：活动当前为「${owner.status}」，归档要求为「已完成」`,
      })
    }
    if (archive.originDate !== owner.date) {
      issues.push({
        level: 'error',
        scope: archive.code,
        message: `归档「${archive.code}」原活动日期被改动（${archive.originDate} → ${owner.date}）`,
      })
    }
    if (archive.activityId !== owner.id) {
      issues.push({ level: 'error', scope: archive.code, message: `归档「${archive.code}」归属记录错位` })
    }
  }

  return issues
}

function guard(): IntegrityIssue[] | null {
  const issues = runIntegrityChecks()
  return issues.length > 0 ? issues : null
}

// ---------- 取数：活动列表、覆盖统计、核查项全部现算，不保留旧汇总 ----------

export function coverageStats(records: CampaignRecord[], now = new Date()): CoverageStats {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const byVillage = new Map<string, VillageCoverage>()
  let monthCount = 0
  let completedCount = 0
  let totalAudience = 0
  let cancelledCount = 0

  for (const record of records) {
    if (record.status === '已取消') {
      cancelledCount += 1
      continue // 取消后受众数不更新：已取消活动完全退出覆盖口径
    }
    if (record.date.slice(0, 7) === month) monthCount += 1
    if (record.status === '已完成') completedCount += 1
    for (const group of record.groups) {
      totalAudience += group.audience
      const current = byVillage.get(group.village) ?? {
        village: group.village,
        label: group.label,
        activities: 0,
        audience: 0,
      }
      current.activities += 1
      current.audience += group.audience
      byVillage.set(group.village, current)
    }
  }

  return {
    monthCount,
    completedCount,
    totalAudience,
    cancelledCount,
    villageCoverage: [...byVillage.values()].sort((a, b) => b.audience - a.audience || a.village.localeCompare(b.village, 'zh')),
  }
}

/** 核查项：已归档宣传活动 + 检查站待办，同步生成；每次现算，处置结果单独持久化。 */
export function buildCheckItems(
  records: CampaignRecord[] = loadActivities(),
  archives: CampaignArchive[] = loadArchives(),
): CheckItem[] {
  const items: CheckItem[] = []
  const archivedKeys = new Set(archives.map((archive) => archive.key))

  for (const record of records) {
    if (record.status === '已完成' && archivedKeys.has(`${record.code}__${record.date}`)) {
      items.push({
        id: `campaign:${record.id}`,
        source: 'campaign',
        refId: record.id,
        title: `宣传活动覆盖核查：${record.subject || record.code}`,
        detail: `${record.code} · ${record.date} · 覆盖 ${record.groups.length} 个村组 · ${audienceOf(record)} 人次`,
        date: record.date,
        pending: true,
      })
    }
  }

  // 别的模块的检查站待办同步生成核查项
  const checkpointRows = listRows('checkpoint')
  for (const row of checkpointRows) {
    const status = String(row.status)
    if (status === '临时关闭') continue
    const pending = status === '升级检查' || status === '等待换岗'
    items.push({
      id: `checkpoint:${row.id}`,
      source: 'checkpoint',
      refId: Number(row.id),
      title: `检查站待办：${String(row['站点编号'] ?? '')} ${pending ? `（${status}）` : ''}`.trim(),
      detail: `${String(row['站点位置'] ?? '')} · 值守 ${String(row['值守人员'] ?? '')}`,
      date: String(row['值班日期'] ?? ''),
      pending,
    })
  }

  const done = loadCheckDone()
  for (const item of items) {
    if (done[item.id]) item.pending = false
  }
  return items
}

export type CampaignState = {
  records: CampaignRecord[]
  archives: CampaignArchive[]
  failures: ImportFailure[]
  checks: CheckItem[]
  coverage: CoverageStats
  issues: IntegrityIssue[]
}

export function loadCampaignState(): CampaignState {
  const records = loadActivities()
  const archives = loadArchives()
  const failures = loadFailures()
  return {
    records,
    archives,
    failures,
    checks: buildCheckItems(records, archives),
    coverage: coverageStats(records),
    issues: runIntegrityChecks(records, archives),
  }
}

// ---------- 状态流转 ----------

type MutationResult = { ok: boolean; message: string }

function findRecord(records: CampaignRecord[], id: number): CampaignRecord | undefined {
  return records.find((record) => record.id === id)
}

function nextId(records: CampaignRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.id), 0) + 1
}

export function startActivity(id: number): MutationResult {
  const issues = guard()
  if (issues) return { ok: false, message: `完整性校验未通过：${issues[0].message}` }
  const records = loadActivities()
  const record = findRecord(records, id)
  if (!record) return { ok: false, message: `没有找到编号为 ${id} 的防火宣传活动` }
  if (record.status === '进行中') return { ok: false, message: '活动已经在进行中' }
  if (record.status !== '待开展') return { ok: false, message: `活动当前为「${record.status}」，不能开展` }
  record.status = '进行中'
  persistActivities(records)
  return { ok: true, message: `活动 ${record.code} 已开展` }
}

export function cancelActivity(id: number): MutationResult {
  const issues = guard()
  if (issues) return { ok: false, message: `完整性校验未通过：${issues[0].message}` }
  const records = loadActivities()
  const record = findRecord(records, id)
  if (!record) return { ok: false, message: `没有找到编号为 ${id} 的防火宣传活动` }
  if (record.status === '已取消') return { ok: false, message: '活动已取消，不用重复操作' }
  if (record.status === '已完成') return { ok: false, message: '活动已完成并归档，不能取消' }
  record.status = '已取消'
  persistActivities(records) // 覆盖统计由村组明细现算，取消后受众数立即退出口径
  return { ok: true, message: `活动 ${record.code} 已取消，覆盖人次已同步剔除` }
}

function timestampName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function buildListCsv(records: CampaignRecord[]): string {
  const header = ['活动编号', '宣传主题', '宣传方式', '覆盖村组', '执行人员', '活动日期', '受众人数', '活动状态']
  const escape = (value: string | number) => {
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [header.join(',')]
  for (const record of records) {
    lines.push(
      [
        record.code,
        record.subject,
        record.method,
        record.groups.map((group) => group.label).join('、'),
        record.staff,
        record.date,
        audienceOf(record),
        record.status,
      ]
        .map(escape)
        .join(','),
    )
  }
  return `﻿${lines.join('\n')}`
}

export type CompleteResult = MutationResult & { filename?: string; content?: string; archive?: CampaignArchive }

/** 确认完成 = 完成流转 + 归档。并发/重复调用只有一个归档版本能落库，并生成可下载清单。 */
export function completeActivity(id: number, download: (filename: string, content: string) => void): CompleteResult {
  const issues = guard()
  if (issues) return { ok: false, message: `完整性校验未通过：${issues[0].message}` }
  const records = loadActivities()
  const archives = loadArchives()
  const record = findRecord(records, id)
  if (!record) return { ok: false, message: `没有找到编号为 ${id} 的防火宣传活动` }
  if (record.status === '已完成') {
    return { ok: false, message: '活动已完成归档，并发归档只保留一个版本，无需重复归档' }
  }
  if (record.status === '已取消') return { ok: false, message: '活动已取消，不能完成归档' }
  if (record.groups.length === 0) return { ok: false, message: '活动尚未登记任何覆盖村组，不能归档' }

  const key = `${record.code}__${record.date}`
  // 同一活动重复导入/重复确认：归档键已存在时直接拒绝，保证只有一个版本。
  if (archives.some((archive) => archive.key === key)) {
    return { ok: false, message: '该活动已有归档版本，并发归档只接受一个版本' }
  }

  record.status = '已完成'
  const now = new Date()
  const filename = `防火宣传清单-${record.code}-${timestampName(now)}.csv`
  const content = buildListCsv(records)
  const archive: CampaignArchive = {
    key,
    activityId: record.id,
    code: record.code,
    subject: record.subject,
    date: record.date,
    originDate: record.date, // 原活动日期保持原样
    audience: audienceOf(record),
    villageCount: record.groups.length,
    version: 1,
    archivedAt: now.toISOString(),
    filename,
  }

  persistActivities(records)
  persistArchives([...archives, archive])
  // 落库后立刻自检：归档状态错位或记录丢失则整体回滚，不得带错继续。
  const afterIssues = runIntegrityChecks(loadActivities(), loadArchives())
  if (afterIssues.length > 0) {
    record.status = '进行中'
    persistActivities(records)
    persistArchives(archives)
    return { ok: false, message: `归档后校验失败并已回滚：${afterIssues[0].message}` }
  }

  download(filename, content)
  return { ok: true, message: `活动 ${record.code} 已完成归档，清单已生成并开始下载`, filename, content, archive }
}

/** 村组修正：直接替换明细（内部先合并重复村组），所有汇总下次读取时重算。 */
export function correctGroups(id: number, groups: { village: string; audience: number }[]): MutationResult {
  const issues = guard()
  if (issues) return { ok: false, message: `完整性校验未通过：${issues[0].message}` }
  const records = loadActivities()
  const record = findRecord(records, id)
  if (!record) return { ok: false, message: `没有找到编号为 ${id} 的防火宣传活动` }
  if (record.status === '已完成') return { ok: false, message: '活动已完成归档，村组明细不能再修正' }
  const incoming: CampaignGroup[] = []
  for (const item of groups) {
    const label = item.village.trim()
    const audience = Number(item.audience)
    if (!label) return { ok: false, message: '村组名不能为空，修正未保存' }
    if (!Number.isFinite(audience) || audience < 0 || !Number.isInteger(audience)) {
      return { ok: false, message: `村组「${label}」受众人数必须是不小于 0 的整数` }
    }
    incoming.push({ village: normalizeVillage(label), label, audience })
  }
  if (incoming.length === 0) return { ok: false, message: '至少保留一个村组，修正未保存' }
  record.groups = mergeGroups([], incoming)
  persistActivities(records)
  return { ok: true, message: `活动 ${record.code} 村组已修正，覆盖统计已按新明细重算` }
}

// ---------- 名册导入：失败项保留原因，可继续处理；重复整行跳过不重复计数 ----------

const FIELD_ALIASES: Record<string, string> = {
  活动编号: 'code',
  编号: 'code',
  宣传主题: 'subject',
  主题: 'subject',
  宣传方式: 'method',
  方式: 'method',
  覆盖村组: 'village',
  村组: 'village',
  村组名称: 'village',
  执行人员: 'staff',
  人员: 'staff',
  活动日期: 'date',
  原活动日期: 'date',
  受众人数: 'audience',
  受众: 'audience',
  人数: 'audience',
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const content = text.replace(/^﻿/, '')
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i]
    if (inQuotes) {
      if (char === '"' && content[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (char === '"') {
        inQuotes = false
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      field = ''
      row = []
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}

function rosterLineKey(raw: Record<string, string>): string {
  return ['code', 'subject', 'method', 'village', 'staff', 'date', 'audience']
    .map((field) => raw[field] ?? '')
    .join('|')
}

export function parseRoster(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const table = parseCsv(text)
  if (table.length < 2) return { headers: [], rows: [] }
  const headers = table[0].map((cell) => cell.trim())
  const mapped = headers.map((header) => FIELD_ALIASES[header] ?? '')
  const required = ['code', 'date', 'village']
  for (const field of required) {
    if (!mapped.includes(field)) {
      throw new Error(`名册缺少必需列：${field === 'code' ? '活动编号' : field === 'date' ? '活动日期' : '覆盖村组'}`)
    }
  }
  const rows = table.slice(1).map((cells) => {
    const raw: Record<string, string> = {}
    cells.forEach((cell, index) => {
      const field = mapped[index]
      if (field) raw[field] = cell.trim()
    })
    return raw
  })
  return { headers, rows }
}

type AppliedLine = {
  code: string
  date: string
  subject: string
  method: string
  staff: string
  villageLabel: string
  village: string
  audience: number
  /** 已存在活动并入计 merged，新建活动计 imported，整行重复计 skipped */
  kind: 'imported' | 'merged' | 'skipped'
}

function applyRosterRows(
  inputRows: Record<string, string>[],
  startRowNo: number,
): { applied: AppliedLine[]; failures: ImportFailure[] } {
  const records = loadActivities()
  const archives = loadArchives()
  const archivedKeys = new Set(archives.map((archive) => archive.key))
  const applied: AppliedLine[] = []
  const failures: ImportFailure[] = []
  const touched = new Map<string, CampaignRecord>()
  const lineSeen = new Set<string>()

  inputRows.forEach((raw, offset) => {
    const rowNo = startRowNo + offset
    const code = (raw.code ?? '').trim()
    const date = (raw.date ?? '').trim()
    const villageLabel = (raw.village ?? '').trim()
    const audience = parseAudience(raw.audience)

    if (!code) return failures.push({ row: rowNo, raw: { ...raw }, reason: '缺少活动编号', kept: true, importedAt: new Date().toISOString() })
    if (!date) return failures.push({ row: rowNo, raw: { ...raw }, reason: '缺少原活动日期', kept: true, importedAt: new Date().toISOString() })
    if (!villageLabel) return failures.push({ row: rowNo, raw: { ...raw }, reason: '缺少覆盖村组', kept: true, importedAt: new Date().toISOString() })
    if (audience === null) {
      return failures.push({ row: rowNo, raw: { ...raw }, reason: `受众人数无法识别：「${raw.audience ?? ''}」`, kept: true, importedAt: new Date().toISOString() })
    }
    const village = normalizeVillage(villageLabel)

    let record = touched.get(`${code}__${date}`)
    if (!record) record = records.find((item) => item.code === code && item.date === date)

    if (record) {
      if (record.status === '已取消') {
        failures.push({ row: rowNo, raw: { ...raw }, reason: `活动 ${code} 已取消，名册不能再并入`, kept: true, importedAt: new Date().toISOString() })
        return
      }
      if (archivedKeys.has(`${code}__${date}`) || record.status === '已完成') {
        failures.push({ row: rowNo, raw: { ...raw }, reason: `活动 ${code} 已完成归档，名册不可变更`, kept: true, importedAt: new Date().toISOString() })
        return
      }
    }

    const lineKey = `${code}__${date}__${rosterLineKey(raw)}`
    if (lineSeen.has(lineKey) || (record && record.rosterKeys?.includes(lineKey))) {
      applied.push({ code, date, subject: raw.subject ?? '', method: raw.method ?? '', staff: raw.staff ?? '', villageLabel, village, audience, kind: 'skipped' })
      return
    }
    lineSeen.add(lineKey)

    let kind: AppliedLine['kind']
    if (!record) {
      record = {
        id: nextId(records),
        code,
        subject: raw.subject ?? '',
        method: raw.method ?? '',
        staff: raw.staff ?? '',
        date, // 历史名册按原活动日期兼容：新建也沿用名册日期，不取当天
        status: '待开展',
        groups: [],
        abnormal: false,
        rosterKeys: [],
      }
      records.push(record)
      kind = 'imported'
    } else {
      kind = 'merged'
    }
    touched.set(`${code}__${date}`, record)
    if (raw.subject && !record.subject) record.subject = raw.subject
    if (raw.method && !record.method) record.method = raw.method
    if (raw.staff && !record.staff) record.staff = raw.staff

    record.groups = mergeGroups(record.groups, [{ village, label: villageLabel, audience }])
    record.rosterKeys = [...(record.rosterKeys ?? []), lineKey]
    applied.push({ code, date, subject: record.subject, method: record.method, staff: record.staff, villageLabel, village, audience, kind })
  })

  return { applied, failures }
}

export function importRoster(text: string): ImportResult {
  const issues = guard()
  if (issues) throw new Error(`完整性校验未通过：${issues[0].message}`)
  const { rows } = parseRoster(text)
  if (rows.length === 0) throw new Error('名册里没有可导入的数据行')

  const { applied, failures } = applyRosterRows(rows, 2)
  if (applied.length > 0) {
    // applyRosterRows 已在缓存中的同一数组引用上完成改动，直接持久化
    persistActivities(loadActivities())
  }

  const previous = loadFailures()
  // 保留历史失败项可继续处理；同位置同原因同内容的行不重复堆叠
  const oldKeys = new Set(previous.map((item) => `${item.row}|${item.reason}|${JSON.stringify(item.raw)}`))
  const added = failures.filter((item) => {
    const key = `${item.row}|${item.reason}|${JSON.stringify(item.raw)}`
    if (oldKeys.has(key)) return false
    oldKeys.add(key)
    return true
  })
  persistFailures([...previous, ...added])

  return {
    imported: applied.filter((line) => line.kind === 'imported').length,
    merged: applied.filter((line) => line.kind === 'merged').length,
    skipped: applied.filter((line) => line.kind === 'skipped').length,
    failures,
  }
}

/** 保留的失败项修正后继续处理：成功即移除，失败则刷新原因继续保留。 */
export function retryFailure(failureId: string, patch: Record<string, string>): MutationResult & { removed?: boolean } {
  const issues = guard()
  if (issues) return { ok: false, message: `完整性校验未通过：${issues[0].message}` }
  const failures = loadFailures()
  const index = failures.findIndex((item) => itemId(item) === failureId)
  if (index < 0) return { ok: false, message: '失败项不存在，可能已处理' }
  const target = failures[index]
  const raw = { ...target.raw, ...patch }
  // 补录视为新的一行加入当前批次，行号沿用失败项原始行号
  const { applied, failures: newFailures } = applyRosterRows([raw], target.row)
  if (newFailures.length > 0) {
    failures[index] = { ...target, raw, reason: newFailures[0].reason }
    persistFailures(failures)
    return { ok: false, message: newFailures[0].reason }
  }
  persistActivities(loadActivities())
  persistFailures(failures.filter((item) => itemId(item) !== failureId))
  return { ok: true, message: '失败项已补录成功并从失败清单移除', removed: true }
}

export function discardFailure(failureId: string): void {
  persistFailures(loadFailures().filter((item) => itemId(item) !== failureId))
}

export function itemId(item: ImportFailure): string {
  return `${item.importedAt}#${item.row}#${JSON.stringify(item.raw)}`
}

// ---------- 核查处置 ----------

export function setCheckDone(id: string, done: boolean): void {
  const map = loadCheckDone()
  if (done) map[id] = true
  else delete map[id]
  storageSet(CHECK_DONE_KEY, map)
}

// 通用台账里的宣传镜像也供其它模块读，保持引用一致。
export function mirroredCampaignRows(): EntryRow[] {
  return allRows()['campaign'] ?? []
}

/** 仅供测试：清空内存缓存，模拟重新进入页面从 localStorage 冷启动。 */
export function __resetCampaignCacheForTest(): void {
  cacheActivities = null
  __resetStoreCacheForTest()
}
