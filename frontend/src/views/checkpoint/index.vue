<template>
  <section class="page" data-module="checkpoint">
    <header class="page-head">
      <div>
        <h2>防火检查站管理</h2>
        <p class="page-desc">维护防火检查站，围绕站点编号、站点位置、值守人员、检查项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火检查站</button>
        <button class="btn" type="button" @click="exportRows">导出防火检查站清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
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
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火检查站数据，可先登记防火检查站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火检查站记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="todo-panel">
      <header class="todo-head">
        <div>
          <h3>跨模块核查待办</h3>
          <p class="page-desc">由其他模块（含防火宣传）处于待办状态的记录同步生成，作为检查站核查项；重复同步不会重复生成。</p>
        </div>
        <button class="btn primary" type="button" @click="syncTodos">同步生成核查项</button>
      </header>
      <p v-if="syncNotice" class="notice-text">{{ syncNotice }}</p>
      <table class="data-table">
        <thead>
          <tr><th>来源模块</th><th>来源编号</th><th>核查事项</th><th>关联位置</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.key">
            <td>{{ todo.来源模块 }}</td>
            <td>{{ todo.来源编号 }}</td>
            <td>{{ todo.核查事项 }}</td>
            <td>{{ todo.关联位置 }}</td>
            <td>
              <span :class="todo.状态 === '待核查' ? 'badge pending' : 'badge done'">{{ todo.状态 }}</span>
            </td>
            <td class="row-actions">
              <button
                v-if="todo.状态 === '待核查'"
                class="link"
                type="button"
                @click="checkTodo(todo.key)"
              >
                完成核查
              </button>
              <span v-else class="page-desc">已核查</span>
            </td>
          </tr>
          <tr v-if="!todos.length">
            <td colspan="6" class="empty-state">暂无核查待办，点击「同步生成核查项」拉取其他模块待办</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  listCheckTodos,
  markChecked,
  syncCheckTodos,
  type CheckTodo,
} from '@/data/campaign/checkpoint-todos'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('checkpoint')
const columns = ["站点编号", "站点位置", "值守人员", "检查项目", "通行车辆数", "收缴火种数", "值班日期", "运行状态"]
const actions = ["升级检查", "关闭站点", "安排换岗"]
const statuses = ["正常检查", "临时关闭", "升级检查", "等待换岗"]
const stats = ref([{ label: "站点总数", value: 0 }, { label: "正常检查数", value: 0 }, { label: "收缴火种数", value: 0 }, { label: "待核查项", value: 0 }])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const syncNotice = ref('')
const todos = ref<CheckTodo[]>([])
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火检查站登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function numberSum(field: string): number {
  return rows.value.reduce((sum, row) => {
    const value = Number(row[field])
    return sum + (Number.isFinite(value) ? value : 0)
  }, 0)
}

function syncTodos() {
  const result = syncCheckTodos()
  todos.value = result.todos
  syncNotice.value = `同步完成：新增 ${result.created} 项，自动核销 ${result.resolved} 项`
  refreshStats()
}

function checkTodo(key: string) {
  markChecked(key)
  todos.value = listCheckTodos()
  refreshStats()
}

function refreshStats() {
  const pendingTodos = todos.value.filter((todo) => todo.状态 === '待核查').length
  stats.value = [
    { label: "站点总数", value: total.value },
    { label: "正常检查数", value: rows.value.filter((row) => String(row.status) === '正常检查').length },
    { label: "收缴火种数", value: numberSum('收缴火种数') },
    { label: "待核查项", value: pendingTodos },
  ]
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todos.value = listCheckTodos()
    refreshStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火检查站列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.todo-panel { margin-top: 20px; }
.todo-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.notice-text { color: #176634; font-size: 13px; }
.badge { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.badge.pending { background: #fef3e2; color: #b5520a; }
.badge.done { background: #e7f6ec; color: #176634; }
</style>
