/**
 * Compile-time guard that this plugin's OpenCode 2.0 calls and payloads still
 * fit the host contract in `opencode2-host-contract.ts`.
 *
 * No runtime assertions; not part of `bun test`. Checked by
 * `tsc -p tsconfig.test.json`, wired into `bun run typecheck`.
 */

import plugin from "../src/plugin-opencode2.js"
import {
  applyDevinProviderInventory,
  DEVIN_AISDK_PACKAGE,
  modelsToCatalogModelMap,
} from "../src/opencode2/catalog.js"
import { applyDevinIntegration } from "../src/opencode2/integration.js"
import { registerTodoTools } from "../src/opencode2/todo-tools.js"
import type { HostModelInfo, HostPluginContext, HostProviderEditor, HostProviderInfo } from "./opencode2-host-contract.js"

declare const ctx: HostPluginContext
declare const editor: HostProviderEditor

const _id: string = plugin.id
void _id
void (() => plugin.setup(ctx))

void (() =>
  ctx.provider.transform((hostEditor) => {
    applyDevinProviderInventory(hostEditor, [])
  }))
void (() => ctx.provider.reload())

void (() => applyDevinProviderInventory(editor, []))

const publishedInfo: HostProviderInfo = {
  id: "devin",
  name: "Devin",
  activation: "enabled",
  package: DEVIN_AISDK_PACKAGE,
  integrationID: "devin",
}
const publishedModels: readonly HostModelInfo[] = Object.values(
  modelsToCatalogModelMap([
    {
      id: "claude-sonnet-4-5",
      displayName: "Sonnet 4.5",
      supportsAgent: true,
      variants: [],
    },
  ]),
)
void editor.add({
  info: publishedInfo,
  models: publishedModels,
  sourceConnection: { type: "env", name: "DEVIN_API_KEY" },
})

void (() =>
  ctx.aisdk.hook("sdk", (event) => {
    const pkg: string = event.package
    const provider: string = event.model.providerID
    const options: Record<string, unknown> = event.options
    event.sdk = {}
    void [pkg, provider, options]
  }))

void (() =>
  ctx.aisdk.hook("language", (event) => {
    const wire: string = event.model.modelID
    const id: string = event.model.id
    void [wire, id, event.sdk]
  }))

void (() => ctx.integration.transform(applyDevinIntegration))
void (() => ctx.tool.transform((hostEditor) => registerTodoTools(hostEditor)))

void (async () => {
  const connection = await ctx.integration.connection.active("devin")
  if (connection) await ctx.integration.connection.resolve(connection)
})

void (() =>
  ctx.tool.hook("execute.before", (event) => {
    const tool: string = event.tool
    const id: string = event.id ?? event.callID
    event.input = {}
    void [tool, id]
  }))

void (() =>
  ctx.tool.hook("execute.after", (event) => {
    const id: string = event.id ?? event.callID
    if (event.status === "completed") void event.result
    void id
  }))

void (() =>
  ctx.session.hook("context", (event) => {
    const sessionID: string = event.sessionID
    const agent: string = event.agent
    event.options = { ...(event.options ?? {}), flagged: true }
    void [sessionID, agent]
  }))

void (() =>
  ctx.session.hook("compaction", (event) => {
    event.options = { ...(event.options ?? {}), compact: true }
    void event.sessionID
  }))

void (() => ctx.session.hook("generate", (event) => void event.sessionID))
void (() => ctx.session.hook("title", (event) => void event.sessionID))

void (async () => {
  const info = await ctx.session.get({ sessionID: "s" })
  const directory: string = info.location.directory
  const loc: string = ctx.location.directory
  await ctx.session.switchAgent({ sessionID: "s", agent: "build" })
  await ctx.session.synthetic({ sessionID: "s", text: "go" })
  await ctx.session.prompt({ sessionID: "s", text: "go" })
  void [directory, loc]
})

void (() =>
  ctx.shell.hook("create.before", (event) => {
    event.env = { ...event.env, DEVIN: "1" }
    void event.command
  }))

void (() =>
  ctx.websearch.transform((hostEditor) => {
    hostEditor.add({
      id: "devin-exa",
      name: "Exa",
      execute: async () => [],
    })
  }))
