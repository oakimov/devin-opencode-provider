import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const ROOT = path.resolve(import.meta.dir, "..")

function filesUnder(relative: string, extensions: readonly string[]): string[] {
  const root = path.join(ROOT, relative)
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      const stat = statSync(file)
      if (stat.isDirectory()) walk(file)
      else if (extensions.length === 0 || extensions.some(ext => file.endsWith(ext))) out.push(file)
    }
  }
  walk(root)
  return out
}

function source(file: string): string {
  return readFileSync(file, "utf8")
}

function relative(file: string): string {
  return path.relative(ROOT, file)
}

function violations(files: readonly string[], pattern: RegExp): string[] {
  const found: string[] = []
  for (const file of files) {
    source(file).split(/\r?\n/).forEach((line, index) => {
      pattern.lastIndex = 0
      if (pattern.test(line)) found.push(`${relative(file)}:${index + 1}: ${line.trim()}`)
    })
  }
  return found
}

/** Parse declarations so newlines and comments cannot hide a static import. */
function staticImports(text: string, packageName: string, allowTypeOnly = false): number[] {
  const parsed = ts.createSourceFile("module.ts", text, ts.ScriptTarget.Latest, true)
  return parsed.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
    const name = statement.moduleSpecifier.text
    if (name !== packageName && !name.startsWith(`${packageName}/`)) return []
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    const typeOnly = clause?.isTypeOnly || (
      !clause?.name && bindings && ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)
    )
    if (allowTypeOnly && typeOnly) return []
    return [parsed.getLineAndCharacterOfPosition(statement.getStart(parsed)).line + 1]
  })
}

function staticImportViolations(files: readonly string[], packageName: string, allowTypeOnly = false): string[] {
  return files.flatMap(file => staticImports(source(file), packageName, allowTypeOnly)
    .map(line => `${relative(file)}:${line}: static import of ${packageName}`))
}

const SOURCE_FILES = filesUnder("src", [".ts", ".d.ts"])
const TEST_FILES = filesUnder("test", [".ts"])
  .filter(file => path.basename(file) !== "architecture.test.ts")
const PACKAGE_FILES = ["package.json", "bun.lock"].map(name => path.join(ROOT, name))
// `package.json#files` publishes the whole directory, not only compiler output.
// Include metadata so a stale host-specific build artifact cannot cross the
// provider / compatibility-layer boundary unnoticed.
const DIST_PATHS = filesUnder("dist", [])
const DIST_FILES = DIST_PATHS.filter(file => [".js", ".d.ts", ".json"].some(ext => file.endsWith(ext)))

const COMPAT_PACKAGES = /@opencode-compat\/|opencode-plugin-compat/
const FORK_VOCABULARY =
  /MIMOCODE(?:_[A-Z_]+)?|KILO(?:_[A-Z_]+)?|PI_CODING_AGENT_DIR|PI_CONFIG_DIR|\bactor_id\b|\bhashline\b|xd:\/\/|\bMiMo\b|\bKilo\b|\boh-my-pi\b|\bOMP\b|\bDSH\b|DeepSeek Harness|deepseek-harness|exit_plan_mode|ask_user_question|cursor-opencode-provider|cursor_mock|\bCursorPlugin\b|\bcreateCursor\b|cursor_plan_stage|cursor_image_save/
const FOREIGN_RUNTIME = new RegExp(`${COMPAT_PACKAGES.source}|${FORK_VOCABULARY.source}`)
const FOREIGN_IDENTITY_FILES = [...SOURCE_FILES, ...TEST_FILES, ...PACKAGE_FILES, ...DIST_FILES]

describe("provider / compatibility-layer architecture", () => {
  test("provider package and executable surfaces never depend on compatibility packages", () => {
    expect(violations(
      [...SOURCE_FILES, ...TEST_FILES, ...PACKAGE_FILES, ...DIST_FILES],
      COMPAT_PACKAGES,
    )).toEqual([])
  })

  test("all provider surfaces contain no fork identities or fork-only vocabulary", () => {
    expect(violations(
      FOREIGN_IDENTITY_FILES,
      FORK_VOCABULARY,
    )).toEqual([])
  })

  test("published dist contains no compatibility-layer artifacts", () => {
    expect(
      DIST_PATHS
        .map(file => relative(file))
        .filter(file => /(?:^|[/.-])ocp(?:[/.-]|$)|opencode-compat/i.test(file)),
    ).toEqual([])
  })

  test("the structural host path contract uses only the neutral symbol", () => {
    const paths = source(path.join(ROOT, "src/context/paths.ts"))
    expect(paths).toContain('Symbol.for("opencode.host.path-bridge")')
    expect(paths).not.toContain("opencode.compat.path-bridge")
    expect((paths.match(/Symbol\.for\("opencode\.host\.path-bridge"\)/g) ?? []).length).toBe(1)
  })

  test("runtime modules do not statically import @opencode-ai/plugin", () => {
    const targets = [
      "src/plugin.ts",
      "src/plugin-v2.ts",
      "src/web-search-tool.ts",
    ].map(file => path.join(ROOT, file))
    expect(staticImportViolations(
      targets,
      "@opencode-ai/plugin",
      true,
    )).toEqual([])
  })

  test("OpenCode 2.0 plugin does not depend on the host SDK package", () => {
    expect(staticImportViolations(
      [...SOURCE_FILES, ...DIST_FILES],
      "@opencode/plugin",
    )).toEqual([])
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      scripts?: Record<string, string>
    }
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    }
    expect(deps["@opencode/plugin"]).toBeUndefined()
    expect(pkg.scripts?.typecheck).toContain("tsconfig.test.json")
  })

  test("built output preserves the boundary after build", () => {
    if (DIST_FILES.length === 0) return
    expect(violations(
      DIST_FILES,
      FOREIGN_RUNTIME,
    )).toEqual([])
    expect(staticImportViolations(
      DIST_FILES.filter(file => /(?:plugin(?:-v2|-opencode2)?|web-search-tool)\.js$/.test(file)),
      "@opencode-ai/plugin",
    )).toEqual([])
  })

  test("foreign identity coverage includes package metadata and the lockfile", () => {
    for (const file of PACKAGE_FILES) expect(FOREIGN_IDENTITY_FILES).toContain(file)
    for (const identity of ["cursor-opencode-provider", "MiMo", "Kilo", "OMP", "DSH", "DeepSeek Harness", "PI_CONFIG_DIR"]) {
      expect(FORK_VOCABULARY.test(JSON.stringify({ dependencies: { [identity]: "1.0.0" } }))).toBe(true)
    }
  })

  test("static imports are detected across newlines, comments, and subpaths", () => {
    for (const name of ["@opencode-ai/plugin", "@opencode/plugin"]) {
      for (const declaration of [
        `import {\n  tool,\n} from "${name}"`,
        `import /* comment */ { tool }\nfrom\n"${name}/v2/promise"`,
        `import "${name}"`,
        `import * as sdk from "${name}"`,
        `import { type Plugin, tool } from "${name}"`,
      ]) expect(staticImports(declaration, name, true)).toEqual([1])
      expect(staticImports(`import type { Plugin } from "${name}"`, name, true)).toEqual([])
      expect(staticImports(`import { type Plugin } from "${name}"`, name, true)).toEqual([])
      expect(staticImports(`import type { Plugin } from "${name}"`, name)).toEqual([1])
      expect(staticImports(`const lazy = import("${name}")`, name)).toEqual([])
      expect(staticImports(`// import { tool } from "${name}"`, name)).toEqual([])
    }
  })
})
