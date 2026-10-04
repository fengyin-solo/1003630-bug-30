<template>
  <section class="page" data-module="campaign">
    <header class="page-head">
      <div>
        <h2>防火宣传管理</h2>
        <p class="page-desc">维护防火宣传活动与宣传名册，活动列表、覆盖统计、检查站核查同源取数；取消即退出覆盖口径，村组修正后汇总即时重算。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出防火宣传清单</button>
      </div>
    </header>

    <div v-if="issues.length" class="integrity-banner">
      <strong>数据完整性校验未通过，已禁止继续操作：</strong>
      <ul>
        <li v-for="(issue, index) in issues" :key="index">{{ issue.scope }}：{{ issue.message }}</li>
      </ul>
    </div>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>活动编号</span>
        <input v-model="filters.code" placeholder="按活动编号检索" />
      </label>
      <label class="filter-item">
        <span>宣传主题</span>
        <input v-model="filters.subject" placeholder="按宣传主题检索" />
      </label>
      <label class="filter-item">
        <span>覆盖村组</span>
        <input v-model="filters.village" placeholder="按村组检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)">
          <td>{{ row.code }}</td>
          <td>{{ row.subject || '—' }}</td>
          <td>{{ row.method || '—' }}</td>
          <td>{{ villageText(row) || '—' }}</td>
          <td>{{ row.staff || '—' }}</td>
          <td>{{ row.date || '—' }}</td>
          <td>{{ audienceOf(row) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action.name"
              class="link"
              type="button"
              :disabled="issues.length > 0"
              @click="runAction(action.name, row)"
            >
              {{ action.label }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火宣传数据，可导入宣传名册</td>
        </tr>
      </tbody>
    </table>

    <section class="panel">
      <h3>覆盖统计（按村组现算，已取消活动不计）</h3>
      <p class="panel-hint">
        本月活动 {{ coverage.monthCount }} 场 · 已完成 {{ coverage.completedCount }} 场 ·
        已取消 {{ coverage.cancelledCount }} 场 · 覆盖人次合计 {{ coverage.totalAudience }}
      </p>
      <table class="data-table">
        <thead>
          <tr><th>村组</th><th>覆盖活动数</th><th>累计受众人次</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in coverage.villageCoverage" :key="item.village">
            <td>{{ item.label }}</td>
            <td>{{ item.activities }}</td>
            <td>{{ item.audience }}</td>
          </tr>
          <tr v-if="!coverage.villageCoverage.length">
            <td colspan="3" class="empty-state">暂无有效覆盖数据</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3>宣传名册导入</h3>
      <p class="panel-hint">
        CSV 列：活动编号、宣传主题、宣传方式、覆盖村组、执行人员、活动日期、受众人数。
        历史名册按「活动编号 + 原活动日期」归并；同活动重复村组合并受众；同一名册重复导入整行跳过；原活动日期保持原样。
      </p>
      <div class="import-row">
        <input ref="fileInput" type="file" accept=".csv,text/csv" @change="onFilePicked" />
        <button class="btn" type="button" :disabled="issues.length > 0 || !pendingFile" @click="doImport">
          导入名册
        </button>
        <span v-if="importSummary" class="import-summary">{{ importSummary }}</span>
      </div>

      <div v-if="failures.length" class="failure-box">
        <h4>导入失败项（{{ failures.length }} 条，已保留原因，可修正后继续处理）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>行号</th><th>活动编号</th><th>活动日期</th><th>覆盖村组</th><th>受众人数</th><th>失败原因</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in failures" :key="failureKey(item)">
              <td>{{ item.row }}</td>
              <td><input v-model="item.raw.code" placeholder="活动编号" /></td>
              <td><input v-model="item.raw.date" placeholder="YYYY-MM-DD" /></td>
              <td><input v-model="item.raw.village" placeholder="覆盖村组" /></td>
              <td><input v-model="item.raw.audience" placeholder="受众人数" /></td>
              <td class="error-text">{{ item.reason }}</td>
              <td class="row-actions">
                <button class="link" type="button" :disabled="issues.length > 0" @click="retryItem(item)">补录</button>
                <button class="link danger" type="button" @click="discardItem(item)">放弃</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h3>归档记录</h3>
      <table class="data-table">
        <thead>
          <tr><th>活动编号</th><th>宣传主题</th><th>原活动日期</th><th>归档时间</th><th>覆盖村组</th><th>归档受众</th><th>版本</th><th>清单文件</th></tr>
        </thead>
        <tbody>
          <tr v-for="archive in archives" :key="archive.key">
            <td>{{ archive.code }}</td>
            <td>{{ archive.subject || '—' }}</td>
            <td>{{ archive.originDate }}</td>
            <td>{{ formatTime(archive.archivedAt) }}</td>
            <td>{{ archive.villageCount }}</td>
            <td>{{ archive.audience }}</td>
            <td>v{{ archive.version }}</td>
            <td><button class="link" type="button" @click="redownload(archive)">重新下载 {{ archive.filename }}</button></td>
          </tr>
          <tr v-if="!archives.length">
            <td colspan="8" class="empty-state">暂无归档，活动「确认完成」时自动归档并下载清单</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="correcting" class="panel modal-panel">
      <h3>修正覆盖村组：{{ correcting.code }}（{{ correcting.date }}）</h3>
      <p class="panel-hint">直接编辑村组明细，重复村组提交时自动合并、受众累加；活动原日期不变。</p>
      <table class="data-table">
        <thead><tr><th>村组名</th><th>受众人数</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="(group, index) in correctionDraft" :key="index">
            <td><input v-model="group.village" /></td>
            <td><input v-model.number="group.audience" type="number" min="0" step="1" /></td>
            <td><button class="link danger" type="button" @click="correctionDraft.splice(index, 1)">删除</button></td>
          </tr>
        </tbody>
      </table>
      <div class="import-row">
        <button class="btn" type="button" @click="correctionDraft.push({ village: '', audience: 0 })">新增村组</button>
        <button class="btn primary" type="button" @click="saveCorrection">保存修正并重算覆盖</button>
        <button class="btn ghost" type="button" @click="correctingId = null">取消</button>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条防火宣传记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  buildListCsv,
  correctGroups,
  completeActivity,
  discardFailure,
  importRoster,
  itemId,
  loadCampaignState,
  retryFailure,
  startActivity,
  cancelActivity,
  type CampaignState,
} from '@/data/campaign-service'
import type { CampaignArchive, CampaignRecord, ImportFailure } from '@/data/campaign-types'

const columns = ['活动编号', '宣传主题', '宣传方式', '覆盖村组', '执行人员', '活动日期', '受众人数']

const state = ref<CampaignState>({
  records: [],
  archives: [],
  failures: [],
  checks: [],
  coverage: { monthCount: 0, completedCount: 0, totalAudience: 0, cancelledCount: 0, villageCoverage: [] },
  issues: [],
})
const errorMessage = ref('')
const importSummary = ref('')
const filters = ref({ code: '', subject: '', village: '' })
const pendingFile = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const correctingId = ref<number | null>(null)
const correctionDraft = ref<{ village: string; audience: number }[]>([])

const correcting = computed(() =>
  correctingId.value === null
    ? null
    : state.value.records.find((row) => row.id === correctingId.value) ?? null,
)

const issues = computed(() => state.value.issues)
const coverage = computed(() => state.value.coverage)
const archives = computed(() => state.value.archives)
const failures = computed(() => state.value.failures)

const statCards = computed(() => [
  { label: '本月活动数', value: state.value.coverage.monthCount },
  { label: '已完成数', value: state.value.coverage.completedCount },
  { label: '覆盖人次', value: state.value.coverage.totalAudience },
])

const statusSummary = computed(() => {
  const statuses = ['待开展', '进行中', '已完成', '已取消']
  return statuses.map((status) => ({
    status,
    count: state.value.records.filter((row) => row.status === status).length,
  }))
})

const filteredRows = computed(() =>
  state.value.records.filter((row) => {
    if (filters.value.code.trim() && !row.code.includes(filters.value.code.trim())) return false
    if (filters.value.subject.trim() && !row.subject.includes(filters.value.subject.trim())) return false
    if (filters.value.village.trim()) {
      const keyword = filters.value.village.trim()
      if (!row.groups.some((group) => group.label.includes(keyword) || group.village.includes(keyword))) return false
    }
    return true
  }),
)

function audienceOf(row: CampaignRecord): number {
  return row.groups.reduce((sum, group) => sum + group.audience, 0)
}

function villageText(row: CampaignRecord): string {
  return row.groups.map((group) => group.label).join('、')
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function availableActions(row: CampaignRecord): { name: string; label: string }[] {
  const list: { name: string; label: string }[] = []
  if (row.status === '待开展') list.push({ name: '开展活动', label: '开展活动' })
  if (row.status === '进行中') list.push({ name: '确认完成', label: '确认完成并归档' })
  if (row.status === '待开展' || row.status === '进行中') {
    list.push({ name: '取消活动', label: '取消活动' })
    list.push({ name: '村组修正', label: '村组修正' })
  }
  return list
}

function runAction(name: string, row: CampaignRecord): void {
  errorMessage.value = ''
  if (name === '村组修正') {
    correctingId.value = row.id
    correctionDraft.value = row.groups.map((group) => ({ village: group.label, audience: group.audience }))
    return
  }
  let result: { ok: boolean; message: string }
  if (name === '开展活动') result = startActivity(row.id)
  else if (name === '取消活动') result = cancelActivity(row.id)
  else result = completeActivity(row.id, downloadText)
  if (!result.ok) errorMessage.value = result.message
  reload()
}

function saveCorrection(): void {
  if (correctingId.value === null) return
  const result = correctGroups(
    correctingId.value,
    correctionDraft.value.map((group) => ({ village: group.village, audience: Number(group.audience) })),
  )
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  correctingId.value = null
  reload()
}

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement
  pendingFile.value = input.files?.[0] ?? null
}

async function doImport(): Promise<void> {
  errorMessage.value = ''
  importSummary.value = ''
  if (!pendingFile.value) return
  try {
    const text = await pendingFile.value.text()
    const result = importRoster(text)
    importSummary.value = `导入完成：新建活动 ${result.imported} 场，并入门册 ${result.merged} 行，重复跳过 ${result.skipped} 行，失败 ${result.failures.length} 行`
    if (fileInput.value) fileInput.value.value = ''
    pendingFile.value = null
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '名册导入失败'
  }
}

function retryItem(item: ImportFailure): void {
  errorMessage.value = ''
  const result = retryFailure(itemId(item), item.raw)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function discardItem(item: ImportFailure): void {
  discardFailure(itemId(item))
  reload()
}

function failureKey(item: ImportFailure): string {
  return itemId(item)
}

function exportRows(): void {
  downloadText('防火宣传-清单.csv', buildListCsv(state.value.records))
}

function redownload(archive: CampaignArchive): void {
  downloadText(archive.filename, buildListCsv(state.value.records))
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function resetFilters(): void {
  filters.value = { code: '', subject: '', village: '' }
}

function reload(): void {
  state.value = loadCampaignState()
}

onMounted(reload)
</script>

<style scoped>
.panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-top: 16px;
}
.panel h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.panel-hint {
  color: var(--muted);
  font-size: 12px;
  margin: 0 0 10px;
}
.import-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.import-summary {
  font-size: 12px;
  color: var(--brand);
}
.failure-box {
  margin-top: 12px;
}
.failure-box h4 {
  margin: 0 0 8px;
  font-size: 13px;
}
.failure-box input {
  width: 100%;
  padding: 2px 6px;
}
.integrity-banner {
  background: #fef3f2;
  border: 1px solid #f04438;
  color: #b42318;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.integrity-banner ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.link.danger {
  color: #b42318;
}
.link:disabled {
  color: #9aa6b2;
  cursor: not-allowed;
}
.modal-panel {
  border: 2px solid var(--brand);
}
</style>
