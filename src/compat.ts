/**
 * Back-compat aliases for Windsurf/Cursor naming.
 * Import from "devin-opencode-provider/compat" if you need the old names.
 * The package root now exports only `createDevin` / `DevinPlugin` so
 * pi-bridge's `createXxx` / `*Plugin` auto-detection sees a single
 * factory and plugin (like cursor-opencode-provider).
 */
export { createDevin as createWindsurf, createDevin as createCursor } from "./index.js"
export { DevinPlugin as WindsurfPlugin, DevinPlugin as CursorPlugin } from "./plugin.js"
export { createDevin } from "./index.js"
export { DevinPlugin } from "./plugin.js"
export { default } from "./index.js"
