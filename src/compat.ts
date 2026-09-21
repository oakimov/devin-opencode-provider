/**
 * Back-compat aliases for Windsurf naming.
 * Import from "devin-opencode-provider/compat" if you need the old names.
 * The package root now exports only `createDevin` / `DevinPlugin` so
 * generic plugin loaders see a single factory and plugin.
 */
export { createDevin as createWindsurf } from "./index.js"
export { DevinPlugin as WindsurfPlugin } from "./plugin.js"
export { createDevin } from "./index.js"
export { DevinPlugin } from "./plugin.js"
export { default } from "./index.js"
