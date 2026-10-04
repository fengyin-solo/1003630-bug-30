import { CURRENT_SCHEMA_VERSION, migrate } from './migrations'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
const META_KEY = '__meta__'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoreShape = Record<string, unknown>

function freshSeed(): StoreShape {
  return clone(SEED_ROWS as StoreShape)
}

function readStorage(): StoreShape {
  const seed = freshSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return seed
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  let parsed: StoreShape
  try {
    parsed = JSON.parse(raw) as StoreShape
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  // 版本号必须取自原始存档：老存档没有 __meta__，若先与种子合并会被种子的新版本号掩盖，导致迁移被跳过。
  const fromVersion = readVersion(parsed)
  // 老存档里缺少的模块（以及新引入的宣传领域集合）用种子补齐。
  const merged: StoreShape = { ...seed, ...parsed }
  if (fromVersion < CURRENT_SCHEMA_VERSION) {
    const migrated = migrate(merged, fromVersion, parsed)
    writeMeta(migrated, CURRENT_SCHEMA_VERSION)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    return migrated
  }
  writeMeta(merged, fromVersion)
  return merged
}

function readVersion(store: StoreShape): number {
  const meta = store[META_KEY]
  if (meta && typeof meta === 'object' && typeof (meta as { schemaVersion?: unknown }).schemaVersion === 'number') {
    return (meta as { schemaVersion: number }).schemaVersion
  }
  return 1
}

function writeMeta(store: StoreShape, version: number): void {
  store[META_KEY] = { schemaVersion: version }
}

let cache: StoreShape | null = null

function all(): StoreShape {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all()))
  }
}

export function allRows(): Record<string, EntryRow[]> {
  return all() as Record<string, EntryRow[]>
}

export function listRows(key: string): EntryRow[] {
  return (all()[key] as EntryRow[] | undefined) ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  all()[key] = rows
  persist()
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone((SEED_ROWS[key] as EntryRow[] | undefined) ?? [])
  saveRows(key, rows)
  return rows
}

/** 读取宣传领域使用的泛型集合（名册、归档、失败项、核查待办）。 */
export function readCollection<T>(key: string): T[] {
  return (all()[key] as T[] | undefined) ?? []
}

/** 整体写回一个泛型集合。 */
export function writeCollection<T>(key: string, rows: T[]): void {
  all()[key] = rows
  persist()
}

export function storageKey(): string {
  return STORAGE_KEY
}
