/**
 * Per-session todo list used when the host does not ship `todowrite` /
 * `todoread` (OpenCode 2 dropped those builtins; OpenCode 1.x still has
 * `todowrite`).
 *
 * In-memory only, and only for this process:
 * - not written to disk
 * - not shown in a host checklist or TUI
 * - cleared on restart, on plugin unload, and when the session is deleted
 * - not shared with other OpenCode processes or projects except by session id
 *   inside this process
 *
 * A read before the first write, or after any of those clears, returns [].
 */

export const TODOWRITE_TOOL = "todowrite"
export const TODOREAD_TOOL = "todoread"

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export const TODO_PRIORITIES = ["high", "medium", "low"] as const
export type TodoPriority = (typeof TODO_PRIORITIES)[number]

export type SessionTodo = {
  id: string
  content: string
  status: TodoStatus
  priority: TodoPriority
}

const lists = new Map<string, SessionTodo[]>()
const MAX_TRACKED_SESSIONS = 256

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value)
}

function isPriority(value: unknown): value is TodoPriority {
  return typeof value === "string" && (TODO_PRIORITIES as readonly string[]).includes(value)
}

/** Normalize one host todo item. Drops entries with empty content. */
export function normalizeSessionTodo(value: unknown, index: number): SessionTodo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const content = typeof record.content === "string" ? record.content : ""
  if (!content.trim()) return undefined
  const id =
    typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : String(index + 1)
  return {
    id,
    content,
    status: isStatus(record.status) ? record.status : "pending",
    priority: isPriority(record.priority) ? record.priority : "medium",
  }
}

export function normalizeSessionTodos(value: unknown): SessionTodo[] {
  if (!Array.isArray(value)) return []
  const out: SessionTodo[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const todo = normalizeSessionTodo(item, out.length)
    if (!todo) continue
    let id = todo.id
    if (seen.has(id)) id = `${id}-${out.length + 1}`
    seen.add(id)
    out.push(id === todo.id ? todo : { ...todo, id })
  }
  return out
}

export function getSessionTodos(sessionID: string): SessionTodo[] {
  return lists.get(sessionID)?.map((todo) => ({ ...todo })) ?? []
}

export function setSessionTodos(sessionID: string, todos: unknown): SessionTodo[] {
  const normalized = normalizeSessionTodos(todos)
  lists.delete(sessionID)
  lists.set(sessionID, normalized.map((todo) => ({ ...todo })))
  while (lists.size > MAX_TRACKED_SESSIONS) {
    const oldest = lists.keys().next().value as string | undefined
    if (oldest === undefined) break
    lists.delete(oldest)
  }
  return getSessionTodos(sessionID)
}

export function clearSessionTodos(sessionID: string): void {
  lists.delete(sessionID)
}

/** Test-only: drop every session list. */
export function clearAllSessionTodos(): void {
  lists.clear()
}
