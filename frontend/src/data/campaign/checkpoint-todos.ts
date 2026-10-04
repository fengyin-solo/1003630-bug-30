import { MODULE_BY_KEY } from '../modules'
import { allRows, readCollection, writeCollection } from '../local-store'
import type { EntryRow } from '../types'

const TODO_KEY = 'checkTodos'

export type CheckTodo = {
  /** 幂等键：来源模块 + 记录 id，重复同步不会再生成一条。 */
  key: string
  来源模块: string
  来源编号: string
  核查事项: string
  关联位置: string
  产生时间: string
  状态: '待核查' | '已核查'
}

/**
 * 其他模块（宣传以外）里处于待办状态的记录，同步生成检查站核查项。
 * 同步是幂等的：
 *  - 已生成过的待办沿用原状态，不重复生成；
 *  - 来源记录已不再是待办的，对应核查项自动置为「已核查」，不丢记录。
 */
export function syncCheckTodos(): { created: number; resolved: number; todos: CheckTodo[] } {
  const previous = readCollection<CheckTodo>(TODO_KEY)
  const byKey = new Map(previous.map((todo) => [todo.key, todo]))
  const activeKeys = new Set<string>()

  let created = 0
  for (const meta of MODULE_BY_KEY.values()) {
    if (meta.key === 'checkpoint') {
      continue
    }
    const rows: EntryRow[] = allRows()[meta.key] ?? []
    for (const row of rows) {
      if (!row.pending) {
        continue
      }
      const key = `${meta.key}:${row.id}`
      activeKeys.add(key)
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          来源模块: meta.name,
          来源编号: String(row[meta.fields[0]] ?? row.id),
          核查事项: describeTodo(meta.key, row),
          关联位置: locate(meta.key, row),
          产生时间: new Date().toISOString(),
          状态: '待核查',
        })
        created += 1
      }
    }
  }

  let resolved = 0
  byKey.forEach((todo) => {
    if (!activeKeys.has(todo.key) && todo.状态 === '待核查') {
      todo.状态 = '已核查'
      resolved += 1
    }
  })

  const todos = [...byKey.values()].sort((a, b) => b.产生时间.localeCompare(a.产生时间))
  writeCollection(TODO_KEY, todos)
  return { created, resolved, todos }
}

export function listCheckTodos(): CheckTodo[] {
  return readCollection<CheckTodo>(TODO_KEY)
}

/** 检查站面板手工核查：标记为已核查。来源仍为待办时，下一次同步会重新纳入待核查。 */
export function markChecked(key: string): void {
  const todos = readCollection<CheckTodo>(TODO_KEY).map((todo) =>
    todo.key === key ? { ...todo, 状态: '已核查' as const } : todo,
  )
  writeCollection(TODO_KEY, todos)
}

function describeTodo(key: string, row: EntryRow): string {
  const code = String(row[firstField(key)] ?? row.id)
  const map: Record<string, string> = {
    patrol: `巡护任务 ${code} 尚未完成，检查站需核查进山人员登记`,
    firewatch: `监测点 ${code} 处于预警状态，检查站需提升火种查控`,
    lookout: `瞭望台 ${code} 非正常值守，检查站需补位瞭望联动`,
    firebreak: `隔离带 ${code} 待维护，检查站需核查周边可燃物`,
    fireteam: `扑火队伍 ${code} 不在营待命，检查站需确认应急联络`,
    equipment: `装备 ${code} 不可用，检查站需清点现场备用装备`,
    weather: `气象记录 ${code} 待处理，检查站需关注火险天气提示`,
    firereport: `火情报告 ${code} 未闭环，检查站需核查周边进出车辆`,
    drone: `无人机任务 ${code} 未完成，检查站需配合地面核查`,
    campaign: `宣传活动 ${code} 未闭环，检查站需核查宣传覆盖村组`,
    duty: `值勤排班 ${code} 待确认，检查站需核对到岗交接`,
    supply: `防火物资 ${code} 库存异常，检查站需核对现场物资`,
    forestroad: `林区道路 ${code} 通行异常，检查站需引导车辆绕行`,
    firebelt: `防火林带 ${code} 待养护，检查站需核查林缘火源`,
    drill: `应急演练 ${code} 未完成，检查站需配合演练路线`,
    burnpermit: `用火审批 ${code} 未闭环，检查站需核实用火现场`,
    treegrowth: `林木生长记录 ${code} 待处理，检查站无需额外拦停`,
  }
  return map[key] ?? `${code} 有待办事项，检查站需跟进核查`
}

function locate(key: string, row: EntryRow): string {
  const candidates: Record<string, string> = {
    patrol: '巡护区域',
    firewatch: '监测区域',
    lookout: '所在山头',
    firebreak: '所属林区',
    firereport: '起火地点',
    drone: '飞行区域',
    campaign: '覆盖村组',
    checkpoint: '站点位置',
    forestroad: '道路名称',
    firebelt: '林带名称',
    drill: '演练主题',
    burnpermit: '用火地点',
  }
  const field = candidates[key]
  return field ? String(row[field] ?? '—') : '—'
}

function firstField(key: string): string {
  return MODULE_BY_KEY.get(key)?.fields[0] ?? ''
}
