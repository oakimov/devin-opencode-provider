import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

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
      else if (extensions.some(ext => file.endsWith(ext))) out.push(file)
    }
  }
  walk(root)
  return out
}

function violations(files: readonly string[], pattern: RegExp): string[] {
  const found: string[] = []
  for (const file of files) {
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      pattern.lastIndex = 0
      if (pattern.test(line)) found.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`)
    })
  }
  return found
}

const SOURCE_FILES = filesUnder("src", [".ts", ".d.ts"])
const TEST_FILES = filesUnder("test", [".ts"])
  .filter(file => path.basename(file) !== "architecture.test.ts")
const PACKAGE_FILES = ["package.json", "bun.lock"].map(name => path.join(ROOT, name))
const DIST_FILES = filesUnder("dist", [".js", ".d.ts", ".json"])

const FOREIGN_RUNTIME =
  /@opencode-compat\/|opencode-plugin-compat|MIMOCODE(?:_[A-Z_]+)?|KILO(?:_[A-Z_]+)?|PI_CODING_AGENT_DIR|PI_CONFIG_DIR|\bactor_id\b|\bhashline\b|xd:\/\/|\bMiMo\b|\bKilo\b|\boh-my-pi\b|\bOMP\b|\bDSH\b|DeepSeek Harness|deepseek-harness|cursor-opencode-provider|cursor_mock|\bCursorPlugin\b|\bcreateCursor\b|cursor_plan_stage|cursor_image_save/

describe("provider / compatibility-layer architecture", () => {
  test("provider source, tests, package metadata, and build contain no foreign runtime knowledge", () => {
    expect(violations(
      [...SOURCE_FILES, ...TEST_FILES, ...PACKAGE_FILES, ...DIST_FILES],
      FOREIGN_RUNTIME,
    )).toEqual([])
  })

  test("published dist contains no compatibility-layer artifacts", () => {
    expect(
      DIST_FILES
        .map(file => path.relative(ROOT, file))
        .filter(file => /(?:^|[/.-])ocp(?:[/.-]|$)|opencode-compat/i.test(file)),
    ).toEqual([])
  })

  test("the structural path capability uses only the neutral OpenCode symbol", () => {
    const source = readFileSync(path.join(ROOT, "src/context/paths.ts"), "utf8")
    expect(source).toContain('Symbol.for("opencode.host.path-bridge")')
    expect(source).not.toContain("opencode.compat.path-bridge")
  })
})
