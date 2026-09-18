/**
 * Map Devin-emitted tool names/args onto the advertised OpenCode catalog.
 *
 * OpenCode 1.x uses `bash` + `filePath` + `task`.
 * OpenCode 2.0 uses `shell` + `path` + `subagent`.
 * File-path keys live in `file-tool-args.ts`; this module covers shell and
 * task/subagent identity (and the task argument shape).
 */

export type HostShellTool = "bash" | "shell"
export type HostTaskTool = "task" | "subagent"

export function advertisedToolNames(
  tools: readonly { name?: string }[],
): Set<string> {
  return new Set(
    tools.map((tool) => tool.name).filter((name): name is string => typeof name === "string"),
  )
}

/** Host shell tool id. Prefer `shell` only when `bash` is absent. */
export function hostShellTool(names: Iterable<string>): HostShellTool {
  const set = names instanceof Set ? names : new Set(names)
  return set.has("shell") && !set.has("bash") ? "shell" : "bash"
}

/** Host task executor. Prefer `task` when both are advertised (OpenCode 1.x). */
export function hostTaskTool(names: Iterable<string>): HostTaskTool | undefined {
  const set = names instanceof Set ? names : new Set(names)
  if (set.has("task")) return "task"
  if (set.has("subagent")) return "subagent"
  return undefined
}

export function remapHostToolName(name: string, advertised: Set<string>): string {
  if (name === "bash" || name === "shell" || name === "execute") {
    if (advertised.has(name)) return name
    if (name === "bash" && advertised.has("shell")) return "shell"
    if (name === "shell" && advertised.has("bash")) return "bash"
    if (name === "execute" && advertised.has("shell")) return "shell"
    if (name === "execute" && advertised.has("bash")) return "bash"
    return hostShellTool(advertised)
  }
  if (name === "task" || name === "subagent") {
    return hostTaskTool(advertised) ?? name
  }
  return name
}

/** Remap a Devin-emitted tool name/args onto the advertised host catalog. */
export function remapEmittedToolCall(
  toolName: string,
  parsed: unknown,
  advertised: Set<string>,
): { toolName: string; args: unknown } {
  return remapTaskToolCall(remapHostToolName(toolName, advertised), parsed, advertised)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/**
 * Rewrite native `task` / `subagent` argument maps onto the advertised host
 * executor. OpenCode 2 `subagent` uses `agent` / `sessionID`; 1.x `task` uses
 * `subagent_type` / `task_id`.
 */
export function remapTaskToolCall(
  toolName: string,
  parsed: unknown,
  advertised: Set<string>,
): { toolName: string; args: unknown } {
  if (toolName !== "task" && toolName !== "subagent") {
    return { toolName, args: parsed }
  }
  const target = hostTaskTool(advertised)
  if (!target) return { toolName, args: parsed }

  const obj = asRecord(parsed)
  if (!obj) return { toolName: target, args: parsed }

  const description = str(obj.description) ?? ""
  const prompt = str(obj.prompt) ?? ""
  const agent = str(obj.agent) ?? str(obj.subagent_type) ?? ""
  const resume = str(obj.sessionID) ?? str(obj.task_id)
  const background = obj.background === true

  if (target === "subagent") {
    return {
      toolName: "subagent",
      args: {
        ...(agent ? { agent } : {}),
        description,
        prompt,
        ...(resume ? { sessionID: resume } : {}),
        ...(background ? { background: true } : {}),
      },
    }
  }

  return {
    toolName: "task",
    args: {
      description,
      prompt,
      ...(agent ? { subagent_type: agent } : {}),
      ...(resume ? { task_id: resume } : {}),
      ...(background ? { background: true } : {}),
    },
  }
}
