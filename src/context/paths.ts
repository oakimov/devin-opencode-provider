import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { trace } from "../debug.js"

export const HOST_PATH_BRIDGE = Symbol.for("opencode.host.path-bridge")
export type OpenCodePathBridge = {
  projectConfigDirs: (workspaceRoot: string) => string[]
  globalConfigDirs: () => string[]
  globalDataDir?: () => string
  globalCacheDir?: () => string
  configFileNames?: string[]
}

function pathBridge(): OpenCodePathBridge | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
  if (!value || typeof value !== "object") return undefined
  const bridge = value as Partial<OpenCodePathBridge>
  return typeof bridge.projectConfigDirs === "function" && typeof bridge.globalConfigDirs === "function"
    ? (bridge as OpenCodePathBridge)
    : undefined
}

function openCodeGlobalDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0) return path.join(env.XDG_DATA_HOME, "opencode")
  return path.join(resolveHome(env), ".local", "share", "opencode")
}

function openCodeGlobalCacheDirInner(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(xdgCacheHome(env), "opencode")
}

function bridgeGlobalDataDir(): string | undefined {
  const value = pathBridge()?.globalDataDir?.()
  return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined
}

function bridgeGlobalCacheDir(): string | undefined {
  const value = pathBridge()?.globalCacheDir?.()
  return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined
}

export function opencodeProjectConfigDirs(workspaceRoot: string): string[] {
  return pathBridge()?.projectConfigDirs(path.resolve(workspaceRoot)) ?? [path.join(path.resolve(workspaceRoot), ".opencode")]
}
export function opencodeGlobalConfigDirs(): string[] {
  return pathBridge()?.globalConfigDirs() ?? [opencodeGlobalConfigDir()]
}
export function opencodeConfigFileNames(): string[] {
  return pathBridge()?.configFileNames?.length ? [...pathBridge()!.configFileNames!] : ["opencode.json", "opencode.jsonc"]
}

let hostCacheDirOverride: string | undefined

function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir()
}
function xdgCacheHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0) return env.XDG_CACHE_HOME
  return path.join(resolveHome(env), ".cache")
}

export function setHostCacheDirOverride(dir: string | undefined): void {
  hostCacheDirOverride = dir && dir.length > 0 ? path.resolve(dir) : undefined
}
export function getHostCacheDirOverride(): string | undefined {
  return hostCacheDirOverride
}
export function resolveHostCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return bridgeGlobalCacheDir() ?? openCodeGlobalCacheDirInner(env)
}
export function opencodeGlobalConfigDir(): string {
  return path.join(resolveHome(), ".config", "opencode")
}
export function opencodeGlobalCacheDir(): string {
  if (hostCacheDirOverride) return hostCacheDirOverride
  return resolveHostCacheDir()
}
export function opencodeGlobalDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return openCodeGlobalDataDir(env)
}
export function hostGlobalDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return bridgeGlobalDataDir() ?? openCodeGlobalDataDir(env)
}
export function hostPlansDir(_workspaceRoot?: string): string {
  return path.join(hostGlobalDataDir(), "plans")
}
export function slugifyWorkspacePath(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot)
  return resolved.replace(/[^a-zA-Z0-9]/g, "-").split("-").filter(Boolean).join("-")
}
export function opencodeProjectDir(workspaceRoot: string): string {
  const projectsRoot = path.join(opencodeGlobalCacheDir(), "projects")
  const slug = slugifyWorkspacePath(workspaceRoot)
  let dir = path.join(projectsRoot, slug)
  if (dir.length > 92) {
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 7)
    dir = `${dir.slice(0, Math.min(84, dir.length))}-${hash}`
  }
  return dir
}
export function ensureOpencodeProjectDir(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot)
  const dir = opencodeProjectDir(resolved)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  trace(`project-dir: workspace=${resolved} slug=${slugifyWorkspacePath(resolved)} dir=${dir}`)
  return dir
}
export function resolveHomeRelative(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2))
  return p
}
