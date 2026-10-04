<template>
  <section class="page" data-module="campaign">
    <header class="page-head">
      <div>
        <h2>防火宣传管理</h2>
        <p class="page-desc">活动、名册、覆盖统计与归档共用同一条取数链路；历史名册按原活动日期统计，重复村组合并受众。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="goTab('list')">刷新活动清单</button>
        <button class="btn" type="button" @click="exportList">下载活动清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statsCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        @click="goTab(tab.key)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <p v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</p>

    <!-- 活动列表 -->
    <div v-show="activeTab === 'list'">
      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>
      <form class="filter-bar" @submit.prevent="reload">
        <label class="filter-item">
          <span>宣传主题</span>
          <input v-model="filters['宣传主题']" placeholder="按宣传主题检索" />
        </label>
        <label class="filter-item">
          <span>宣传方式</span>
          <input v-model="filters['宣传方式']" placeholder="按宣传方式检索" />
        </label>
        <label class="filter-item">
          <span>覆盖村组</span>
          <input v-model="filters['覆盖村组']" placeholder="按村组检索" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>版本</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in view.items" :key="String(row.id)">
            <td>{{ row.活动编号 }}</td>
            <td>{{ row.宣传主题 }}</td>
            <td>{{ row.宣传方式 }}</td>
            <td>
              <button class="link" type="button" @click="openCorrect(row)">修正村组</button>
              <div class="cell-sub">{{ row.覆盖村组文本 || '—' }}</div>
            </td>
            <td>{{ row.执行人员 }}</td>
            <td>{{ row.活动日期 }}</td>
            <td>{{ row.活动状态 === '已取消' ? 0 : row.受众人数 }}</td>
            <td>{{ row.活动状态 }}</td>
            <td>{{ row.status }}</td>
            <td>v{{ row.版本 }}{{ row.已归档 ? ' · 已归档' : '' }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="runAction('开展活动', row)">开展活动</button>
              <button class="link" type="button" @click="runAction('确认完成', row)">确认完成</button>
              <button class="link danger" type="button" @click="runAction('取消活动', row)">取消活动</button>
            </td>
          </tr>
          <tr v-if="!view.items.length">
            <td :colspan="columns.length + 3" class="empty-state">暂无符合条件的防火宣传活动</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>共 {{ view.total }} 条活动记录 · 覆盖 {{ view.coveredAudience }} 人次（已取消不计）</span>
      </footer>
    </div>

    <!-- 覆盖统计 -->
    <div v-show="activeTab === 'coverage'">
      <h3>村组覆盖统计</h3>
      <p class="page-desc">按名册原始活动日期聚合；已取消活动的受众不计入覆盖。</p>
      <table class="data-table">
        <thead>
          <tr><th>村组</th><th>覆盖活动场次</th><th>覆盖受众人次</th></tr>
        </thead>
        <tbody>
          <tr v-for="village in view.villages" :key="village.村组">
            <td>{{ village.村组 }}</td>
            <td>{{ village.活动场次 }}</td>
            <td>{{ village.受众人次 }}</td>
          </tr>
          <tr v-if="!view.villages.length">
            <td colspan="3" class="empty-state">暂无覆盖数据</td>
          </tr>
        </tbody>
        <tfoot>
          <tr><td>合计</td><td>—</td><td>{{ view.coveredAudience }}</td></tr>
        </tfoot>
      </table>
    </div>

    <!-- 名册导入 -->
    <div v-show="activeTab === 'import'">
      <h3>宣传名册导入</h3>
      <p class="page-desc">
        每行一条，格式：活动编号,村组,受众人数,活动日期(YYYY-MM-DD，可留空沿用主表日期)。
        重复活动与重复村组自动合并（受众累加，日期取较早）；历史明细保留原活动日期。
      </p>
      <textarea
        v-model="importText"
        class="import-box"
        rows="8"
        placeholder="CAMP-0001,青松村一组,30,2026-10-02&#10;CAMP-0002,白桦村三组,15,2026-10-03"
      ></textarea>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="previewImport">解析预览</button>
        <button class="btn ghost" type="button" @click="importText = ''">清空</button>
      </div>

      <div v-if="preview" class="import-result">
        <h4>待合并（{{ preview.accepted.length }} 条）</h4>
        <table class="data-table">
          <thead><tr><th>活动编号</th><th>村组</th><th>受众人数</th><th>原活动日期</th></tr></thead>
          <tbody>
            <tr v-for="row in preview.accepted" :key="row.key">
              <td>{{ row.活动编号 }}</td><td>{{ row.村组 }}</td><td>{{ row.受众人数 }}</td><td>{{ row.原始活动日期 || '—' }}</td>
            </tr>
            <tr v-if="!preview.accepted.length"><td colspan="4" class="empty-state">没有可合并的合法行</td></tr>
          </tbody>
        </table>

        <h4>失败项（{{ preview.failures.length }} 条，保留原因，可修正后继续处理）</h4>
        <table class="data-table">
          <thead><tr><th>活动编号</th><th>村组</th><th>受众人数</th><th>活动日期</th><th>失败原因</th></tr></thead>
          <tbody>
            <tr v-for="row in preview.failures" :key="row.key">
              <td>{{ row.活动编号 }}</td><td>{{ row.村组 }}</td><td>{{ row.受众人数 }}</td><td>{{ row.活动日期 }}</td>
              <td class="error-text">{{ row.原因 }}</td>
            </tr>
            <tr v-if="!preview.failures.length"><td colspan="5" class="empty-state">无失败项</td></tr>
          </tbody>
        </table>

        <div class="page-actions">
          <button class="btn primary" type="button" :disabled="!preview.accepted.length" @click="confirmImport">
            确认合并{{ preview.accepted.length ? ` ${preview.accepted.length} 条` : '' }}
          </button>
          <span class="page-desc">合法项先入库，失败项保留在下方待修正。</span>
        </div>
      </div>

      <h4>历史失败项（{{ failures.length }}）</h4>
      <table class="data-table">
        <thead><tr><th>活动编号</th><th>村组</th><th>受众人数</th><th>活动日期</th><th>原因</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="row in failures" :key="row.key">
            <td><input v-model="row.活动编号" class="mini-input" /></td>
            <td><input v-model="row.村组" class="mini-input" /></td>
            <td><input v-model="row.受众人数" class="mini-input" /></td>
            <td><input v-model="row.活动日期" class="mini-input" /></td>
            <td class="error-text">{{ row.原因 }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="handleRetry(row)">修正重试</button>
              <button class="link danger" type="button" @click="dropFailure(row)">放弃</button>
            </td>
          </tr>
          <tr v-if="!failures.length"><td colspan="6" class="empty-state">没有遗留失败项</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 归档 -->
    <div v-show="activeTab === 'archive'">
      <h3>活动归档</h3>
      <div class="integrity" :class="integrity.ok ? 'ok' : 'bad'">
        <strong>归档完整性：</strong>{{ integrity.message }}
      </div>
      <p class="page-desc" v-if="integrity.ok">并发归档以版本为乐观锁：确认时若活动已被改动或已归档，只接受一个版本，其余请求拒绝。</p>

      <table class="data-table">
        <thead><tr><th>活动编号</th><th>宣传主题</th><th>状态</th><th>版本</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="row in view.items" :key="row.id">
            <td>{{ row.活动编号 }}</td>
            <td>{{ row.宣传主题 }}</td>
            <td>{{ row.活动状态 }}</td>
            <td>v{{ row.版本 }}</td>
            <td class="row-actions">
              <button
                v-if="row.活动状态 === '已完成'"
                class="link"
                type="button"
                :disabled="!integrity.ok"
                @click="confirmArchive(row)"
              >
                {{ row.已归档 ? '按新版本重新归档' : '归档' }}
              </button>
              <span v-else class="page-desc">仅已完成可归档</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h4>归档记录（{{ view.archives.length }}）</h4>
      <table class="data-table">
        <thead><tr><th>活动编号</th><th>宣传主题</th><th>覆盖村组</th><th>受众合计</th><th>归档版本</th><th>归档时间</th><th>归档人</th></tr></thead>
        <tbody>
          <tr v-for="record in view.archives" :key="record.id">
            <td>{{ record.活动编号 }}</td>
            <td>{{ record.宣传主题 }}</td>
            <td>{{ record.覆盖村组.join('、') }}</td>
            <td>{{ record.受众合计 }}</td>
            <td>v{{ record.版本 }}</td>
            <td>{{ formatTime(record.归档时间) }}</td>
            <td>{{ record.归档人 }}</td>
          </tr>
          <tr v-if="!view.archives.length"><td colspan="7" class="empty-state">暂无归档记录</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 村组修正弹层 -->
    <div v-if="correctTarget" class="modal-mask" @click.self="correctTarget = null">
      <div class="modal">
        <h4>修正覆盖村组：{{ correctTarget.活动编号 }}</h4>
        <p class="page-desc">用顿号/逗号分隔填写修正后的完整村组列表，保存后名册与覆盖统计按新口径合并，旧汇总清除。活动日期保持原样。</p>
        <textarea v-model="correctText" class="import-box" rows="3"></textarea>
        <div class="page-actions">
          <button class="btn primary" type="button" @click="saveCorrect">保存修正</button>
          <button class="btn ghost" type="button" @click="correctTarget = null">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  archiveCampaign,
  buildCampaignCsv,
  buildView,
  commitImport,
  correctVillages,
  campaignAction,
  discardFailure,
  listFailures,
  parseRosterText,
  queryCampaigns,
  retryFailure,
  verifyArchiveIntegrity,
  type ImportPreview,
} from '@/data/campaign/services'
import type { CampaignViewItem, ImportFailure } from '@/data/campaign/types'
import { downloadTextFile } from '@/utils/download'

type TabKey = 'list' | 'coverage' | 'import' | 'archive'
const tabs = [
  { key: 'list' as TabKey, label: '活动列表' },
  { key: 'coverage' as TabKey, label: '覆盖统计' },
  { key: 'import' as TabKey, label: '名册导入' },
  { key: 'archive' as TabKey, label: '归档管理' },
]

const columns = ['活动编号', '宣传主题', '宣传方式', '覆盖村组', '执行人员', '活动日期', '受众人数', '活动状态']
const statusOrder = ['待开展', '进行中', '已完成', '已取消']

const activeTab = ref<TabKey>('list')
const view = ref(buildView())
const filters = ref<Record<string, string>>({})
const errorMessage = ref('')
const noticeMessage = ref('')
const importText = ref('')
const preview = ref<ImportPreview | null>(null)
const failures = ref<ImportFailure[]>([])
const integrity = ref(verifyArchiveIntegrity())
const correctTarget = ref<CampaignViewItem | null>(null)
const correctText = ref('')

const statsCards = computed(() => [
  { label: `本月活动数（${new Date().toISOString().slice(0, 7)}）`, value: view.value.monthCount },
  { label: '已完成数', value: view.value.completedCount },
  { label: '覆盖人次（不含已取消）', value: view.value.coveredAudience },
  { label: '归档记录数', value: view.value.archives.length },
])

const statusSummary = computed(() =>
  statusOrder.map((status) => ({
    status,
    count: view.value.items.filter((row) => row.活动状态 === status).length,
  })),
)

function flash(message: string, isError = false): void {
  if (isError) {
    errorMessage.value = message
    noticeMessage.value = ''
  } else {
    noticeMessage.value = message
    errorMessage.value = ''
  }
}

/** 统一刷新：任何处理后都回到这里重新聚合，保证列表、覆盖、归档口径一致。 */
function reload(): void {
  view.value = queryCampaigns(filters.value)
  failures.value = listFailures()
  integrity.value = verifyArchiveIntegrity()
}

function goTab(tab: TabKey): void {
  activeTab.value = tab
  reload()
}

function resetFilters(): void {
  filters.value = {}
  reload()
}

function runAction(action: string, row: CampaignViewItem): void {
  const result = campaignAction(row.id, action)
  if (!result.ok) {
    flash(result.message, true)
    return
  }
  reload()
  flash(result.message)
  // 取消/完成后受众与覆盖立即变化，回列表确认。
  if (action === '取消活动') {
    activeTab.value = 'list'
  }
}

function openCorrect(row: CampaignViewItem): void {
  correctTarget.value = row
  correctText.value = row.覆盖村组文本
}

function saveCorrect(): void {
  if (!correctTarget.value) {
    return
  }
  const result = correctVillages(correctTarget.value.id, correctText.value)
  if (!result.ok) {
    flash(result.message, true)
    return
  }
  correctTarget.value = null
  reload()
  flash(result.message)
}

function previewImport(): void {
  errorMessage.value = ''
  if (!importText.value.trim()) {
    flash('请先粘贴名册内容', true)
    return
  }
  preview.value = parseRosterText(importText.value)
}

function confirmImport(): void {
  if (!preview.value) {
    return
  }
  const result = commitImport(preview.value)
  if (!result.ok) {
    flash(result.message, true)
    return
  }
  preview.value = null
  importText.value = ''
  reload()
  // 处理后返回列表确认，并生成可下载的活动清单文件。
  activeTab.value = 'list'
  exportList()
  flash(`${result.message}；活动清单已生成下载。`)
}

function handleRetry(row: ImportFailure): void {
  const result = retryFailure(row.key, {
    活动编号: row.活动编号,
    村组: row.村组,
    受众人数: row.受众人数,
    活动日期: row.活动日期,
  })
  reload()
  flash(result.message, !result.ok)
}

function dropFailure(row: ImportFailure): void {
  discardFailure(row.key)
  reload()
}

function confirmArchive(row: CampaignViewItem): void {
  // 打开确认时记录当前版本；真实并发下另一请求先归档会使版本不匹配从而被拒绝。
  const expected = row.版本
  const result = archiveCampaign(row.id, expected, '当前值班员')
  if (!result.ok) {
    flash(result.message, true)
  } else {
    flash(result.message)
    exportList()
  }
  reload()
  // 归档后回列表确认状态与归档标记。
  activeTab.value = 'list'
}

function exportList(): void {
  const { filename, content } = buildCampaignCsv()
  downloadTextFile(filename, content)
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

onMounted(reload)
</script>

<style scoped>
.tabs { display: flex; gap: 8px; margin: 8px 0 12px; }
.tab { border: 1px solid var(--border); background: #fff; border-radius: 6px 6px 0 0; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.tab.active { background: var(--brand); color: #fff; border-color: var(--brand); }
.notice-text { color: #176634; font-size: 13px; }
.cell-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.link.danger { color: #b42318; }
.import-box { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-size: 13px; font-family: inherit; }
.import-result { margin: 12px 0; }
.import-result h4 { margin: 12px 0 6px; }
.mini-input { width: 100%; border: 1px solid var(--border); border-radius: 4px; padding: 3px 5px; font-size: 12px; }
.integrity { border-radius: 6px; padding: 8px 10px; margin: 8px 0; font-size: 13px; }
.integrity.ok { background: #e7f6ec; color: #176634; border: 1px solid #b7e0c4; }
.integrity.bad { background: #fdeceb; color: #b42318; border: 1px solid #f3b8b2; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal { background: #fff; border-radius: 8px; padding: 16px 18px; width: 520px; max-width: 92vw; }
.modal h4 { margin: 0 0 8px; }
</style>
