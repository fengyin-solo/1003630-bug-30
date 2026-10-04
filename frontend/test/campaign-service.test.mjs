/**
 * 防火宣传取数链路的纯逻辑测试（不依赖浏览器/Vitest）：node test/campaign-service.test.mjs
 * 用 localStorage 垫片模拟持久化，每个用例重置存储与模块缓存。
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tmpDir = resolve(here, '../.tmp-test-build')

// ---- 极简 TS -> JS 转译：这些源文件只用了类型注解与 import，esbuild 一次编平 ----
import { build } from 'esbuild'

async function loadService() {
  await build({
    entryPoints: [resolve(here, '../src/data/campaign-service.ts')],
    outfile: resolve(tmpDir, 'campaign-service.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  return import(pathToFileURL(resolve(tmpDir, 'campaign-service.mjs')).href + `?t=${Date.now()}`)
}

// ---- localStorage 垫片 ----
function installShim(seed = {}) {
  const map = new Map(Object.entries(seed))
  globalThis.window = {
    localStorage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key),
      clear: () => map.clear(),
    },
  }
  return map
}

const ENTRIES_KEY = 'forest-fire-patrol:entries'
const CAMPAIGN_KEY = 'forest-fire-patrol:campaign-activities'
const ARCHIVE_KEY = 'forest-fire-patrol:campaign-archives'
const FAILURE_KEY = 'forest-fire-patrol:campaign-import-failures'
const CHECK_DONE_KEY = 'forest-fire-patrol:campaign-check-done'

const seedEntries = {
  campaign: [
    {
      id: 1,
      status: '进行中',
      pending: true,
      abnormal: false,
      活动编号: 'CAMP-2026-001',
      宣传主题: '清明防火进村',
      宣传方式: '院坝会',
      覆盖村组: '青松一组、青松二组',
      执行人员: '周林',
      活动日期: '2026-09-15',
      受众人数: '101',
      活动状态: '进行中',
    },
    {
      id: 2,
      status: '待开展',
      pending: true,
      abnormal: false,
      活动编号: 'CAMP-2026-002',
      宣传主题: '国庆设点宣传',
      宣传方式: '宣传车',
      覆盖村组: '白果村',
      执行人员: '李岚',
      活动日期: '2026-10-01',
      受众人数: '60',
      活动状态: '待开展',
    },
    {
      id: 3,
      status: '待开展',
      pending: true,
      abnormal: false,
      活动编号: 'CAMP-2025-009',
      宣传主题: '历史老活动',
      宣传方式: '标语',
      覆盖村组: '楠木村',
      执行人员: '老周',
      活动日期: '2025-12-20',
      受众人数: '三十', // 无法解析的历史脏数据
      活动状态: '待开展',
    },
  ],
  checkpoint: [
    {
      id: 1,
      status: '升级检查',
      pending: false,
      abnormal: false,
      站点编号: 'CHEC-0001',
      站点位置: '青松垭口',
      值守人员: '王强',
      检查项目: '火种收缴',
      通行车辆数: '12',
      收缴火种数: '3',
      值班日期: '2026-10-02',
      运行状态: '升级检查',
    },
  ],
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

function freshStore() {
  return installShim({ [ENTRIES_KEY]: JSON.stringify(seedEntries) })
}

test('历史台账迁移：按原活动日期兼容，受众按村组均摊，脏数据保留原因', async () => {
  const svc = await loadService()
  freshStore()
  const state = svc.loadCampaignState()
  assert.equal(state.records.length, 3)
  const first = state.records.find((r) => r.code === 'CAMP-2026-001')
  assert.equal(first.date, '2026-09-15')
  assert.equal(first.groups.length, 2)
  assert.equal(first.groups[0].audience + first.groups[1].audience, 101)
  assert.equal(first.legacy, true)
  const dirty = state.records.find((r) => r.code === 'CAMP-2025-009')
  assert.equal(dirty.legacyAudience, '三十')
  assert.equal(dirty.groups[0].audience, 0)
})

test('取消后受众数更新：取消活动立刻退出活动列表之外的覆盖统计口径', async () => {
  const svc = await loadService()
  freshStore()
  let state = svc.loadCampaignState()
  const before = state.coverage.totalAudience
  assert.equal(before, 161) // 101 + 60 + 0
  const result = svc.cancelActivity(2)
  assert.equal(result.ok, true, result.message)
  state = svc.loadCampaignState()
  assert.equal(state.records.find((r) => r.id === 2).status, '已取消')
  assert.equal(state.coverage.totalAudience, 101)
  assert.equal(state.coverage.cancelledCount, 1)
  const byVillage = state.coverage.villageCoverage.find((v) => v.village === '白果村')
  assert.equal(byVillage, undefined)
  // 通用台账镜像同步：运营概览/其它模块读到的状态与活动一致，受众展示原始明细
  const rows = svc.mirroredCampaignRows()
  const mirror = rows.find((r) => r.id === 2)
  assert.equal(mirror['受众人数'], 60)
  assert.equal(mirror['活动状态'], '已取消')
  assert.equal(mirror['status'], '已取消')
})

test('村组修正后旧汇总不残留：覆盖统计与镜像列表同时按新明细重算', async () => {
  const svc = await loadService()
  freshStore()
  const result = svc.correctGroups(2, [
    { village: '白果村一组', audience: 25 },
    { village: '白果村二组', audience: 20 },
    { village: ' 白果村二组 ', audience: 10 }, // 重复村组：合并、受众累加
  ])
  assert.equal(result.ok, true, result.message)
  const state = svc.loadCampaignState()
  const record = state.records.find((r) => r.id === 2)
  assert.equal(record.groups.length, 2)
  const merged = record.groups.find((g) => g.village === '白果村二组')
  assert.equal(merged.audience, 30)
  assert.equal(state.coverage.totalAudience, 101 + 55)
  const mirror = svc.mirroredCampaignRows().find((r) => r.id === 2)
  assert.equal(mirror['受众人数'], 55)
  assert.ok(mirror['覆盖村组'].includes('白果村一组'))
})

test('同一活动重复导入不重复归档：整行重复跳过，新行并入受众，归档只有一个版本', async () => {
  const svc = await loadService()
  freshStore()
  const roster = [
    '活动编号,宣传主题,宣传方式,覆盖村组,执行人员,活动日期,受众人数',
    'CAMP-2026-010,设卡宣传,宣传车,红岩一组,郑凯,2026-10-03,40',
    'CAMP-2026-010,设卡宣传,宣传车,红岩二组,郑凯,2026-10-03,30',
  ].join('\n')
  const first = svc.importRoster(roster)
  assert.equal(first.imported, 1)
  assert.equal(first.merged, 1)
  assert.equal(first.failures.length, 0)
  const again = svc.importRoster(roster)
  assert.equal(again.imported, 0)
  assert.equal(again.merged, 0)
  assert.equal(again.skipped, 2) // 重复导入不重复计数、不重复显示归档
  let state = svc.loadCampaignState()
  const record = state.records.find((r) => r.code === 'CAMP-2026-010')
  assert.equal(record.groups.reduce((s, g) => s + g.audience, 0), 70)

  let downloaded = []
  const r1 = svc.completeActivity(record.id, (filename, content) => downloaded.push({ filename, content }))
  assert.equal(r1.ok, true, r1.message)
  assert.equal(downloaded.length, 1)
  assert.ok(downloaded[0].filename.endsWith('.csv'))
  assert.ok(downloaded[0].content.includes('CAMP-2026-010'))
  // 并发/重复归档：第二个调用只接受失败结果，不产生第二版本
  const r2 = svc.completeActivity(record.id, () => downloaded.push({}))
  assert.equal(r2.ok, false)
  assert.match(r2.message, /一个版本/)
  state = svc.loadCampaignState()
  assert.equal(state.archives.length, 1)
  assert.equal(state.archives[0].version, 1)
  assert.equal(state.archives[0].audience, 70)
  assert.equal(state.archives[0].originDate, '2026-10-03')
})

test('原活动日期保持原样：完成/归档/再次进入后日期不变，归档后校验通过', async () => {
  const svc = await loadService()
  freshStore()
  const rec = svc.loadCampaignState().records.find((r) => r.id === 1)
  svc.completeActivity(rec.id, () => {})
  const state = svc.loadCampaignState()
  const archived = state.records.find((r) => r.id === 1)
  assert.equal(archived.date, '2026-09-15')
  assert.equal(state.archives[0].originDate, '2026-09-15')
  assert.deepEqual(state.issues, [])
  // 再次进入（重新加载）覆盖结果一致
  const again = svc.loadCampaignState()
  assert.equal(again.coverage.totalAudience, 101 + 60)
})

test('导入失败项保留原因并可继续处理：修正字段后补录成功并移除', async () => {
  const svc = await loadService()
  freshStore()
  const roster = [
    '活动编号,覆盖村组,活动日期,受众人数',
    'CAMP-2026-020,杉树村,2026-10-04,二十', // 受众非数字
    ',大坪村,2026-10-04,15', // 缺编号
    'CAMP-2026-021,大坪村,2026-10-04,15',
  ].join('\n')
  const result = svc.importRoster(roster)
  assert.equal(result.imported, 1)
  assert.equal(result.failures.length, 2)
  assert.match(result.failures[0].reason, /受众人数/)
  const state1 = svc.loadCampaignState()
  assert.equal(state1.failures.length, 2)
  // 修正第一条
  const fid = svc.itemId(state1.failures[0])
  const retry = svc.retryFailure(fid, { audience: '20' })
  assert.equal(retry.ok, true, retry.message)
  const state2 = svc.loadCampaignState()
  assert.equal(state2.failures.length, 1)
  assert.ok(state2.records.find((r) => r.code === 'CAMP-2026-020'))
  // 另一条放弃
  svc.discardFailure(svc.itemId(state2.failures[0]))
  assert.equal(svc.loadCampaignState().failures.length, 0)
})

test('归档状态错位或记录丢失时不得继续：校验报错并阻止写操作', async () => {
  const svc = await loadService()
  const map = freshStore()
  // 先制造一份归档
  svc.completeActivity(1, () => {})
  const archives = JSON.parse(map.get(ARCHIVE_KEY))
  // 场景一：记录丢失（删掉活动）
  const activities = JSON.parse(map.get(CAMPAIGN_KEY)).filter((r) => r.id !== 1)
  map.set(CAMPAIGN_KEY, JSON.stringify(activities))
  map.set(ARCHIVE_KEY, JSON.stringify(JSON.parse(JSON.stringify(archives))))
  // 同步通用台账镜像，避免冷启动把旧种子重新迁移成 id 重复
  const seed = JSON.parse(map.get(ENTRIES_KEY))
  map.set(ENTRIES_KEY, JSON.stringify({ ...seed, campaign: activities.map((r) => ({ id: r.id, status: r.status })) }))
  // 模拟重新进入页面：从被破坏的 localStorage 冷启动
  svc.__resetCampaignCacheForTest()
  let state = svc.loadCampaignState()
  assert.ok(state.issues.some((i) => i.message.includes('找不到原活动记录')))
  const blocked = svc.cancelActivity(2)
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /完整性校验/)
  // 场景二：归档状态错位（活动存在但状态被改回待开展）
  const mismatch = JSON.parse(JSON.stringify(activities))
  mismatch.push({
    id: 1,
    code: 'CAMP-2026-001',
    subject: '清明防火进村',
    method: '院坝会',
    staff: '周林',
    date: '2026-09-15',
    status: '待开展',
    groups: [{ village: '青松一组', label: '青松一组', audience: 51 }],
    abnormal: false,
    rosterKeys: [],
  })
  map.set(CAMPAIGN_KEY, JSON.stringify(mismatch))
  const seed2 = JSON.parse(map.get(ENTRIES_KEY))
  map.set(ENTRIES_KEY, JSON.stringify({ ...seed2, campaign: mismatch.map((r) => ({ id: r.id, status: r.status })) }))
  svc.__resetCampaignCacheForTest()
  state = svc.loadCampaignState()
  assert.ok(state.issues.some((i) => i.message.includes('状态错位')))
  assert.equal(svc.startActivity(1).ok, false)
  // 导入也被阻止
  assert.throws(
    () => svc.importRoster('活动编号,覆盖村组,活动日期,受众人数\nX,某村,2026-10-04,1'),
    /完整性校验/,
  )
})

test('检查站面板核查项：归档宣传与检查站待办同步生成，处置持久化', async () => {
  const svc = await loadService()
  freshStore()
  svc.completeActivity(1, () => {})
  const items = svc.buildCheckItems()
  const campaignItem = items.find((i) => i.source === 'campaign')
  assert.ok(campaignItem)
  assert.equal(campaignItem.pending, true)
  const cpItem = items.find((i) => i.source === 'checkpoint')
  assert.ok(cpItem)
  assert.equal(cpItem.title.includes('升级检查'), true)
  assert.equal(cpItem.pending, true)
  svc.setCheckDone(cpItem.id, true)
  const after = svc.buildCheckItems()
  assert.equal(after.find((i) => i.id === cpItem.id).pending, false)
  assert.equal(after.find((i) => i.id === campaignItem.id).pending, true)
})

test('活动清单可下载：导出 CSV 带表头、BOM 与全部活动，字段转义', async () => {
  const svc = await loadService()
  freshStore()
  const csv = svc.buildListCsv(svc.loadCampaignState().records)
  assert.ok(csv.startsWith('﻿'))
  assert.ok(csv.includes('活动编号,宣传主题,宣传方式,覆盖村组,执行人员,活动日期,受众人数,活动状态'))
  assert.ok(csv.includes('CAMP-2026-001'))
  assert.ok(csv.includes('101'))
})

// ---- 执行 ----
mkdirSync(tmpDir, { recursive: true })
let passed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed += 1
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}
console.log(`\n${passed}/${tests.length} passed`)
