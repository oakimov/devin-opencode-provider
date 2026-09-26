#!/usr/bin/env bun
/**
 * Check that known Devin model ids resolve to pricing (or are intentionally unpriced),
 * and that every entry in `DEVIN_MODEL_COSTS` is a valid OpenCode cost object.
 *
 * Pricing data is still stubbed (`DEVIN_MODEL_COSTS` may be empty). Grow
 * `test/fixtures/devin-pricing-models.txt` as real rates land in `pricing-data.ts`.
 *
 *   bun run check:pricing
 *   bun run check:pricing -- --models-file test/fixtures/devin-pricing-models.txt
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  DEVIN_UNPRICED_MODEL_IDS,
  checkDevinPricingCoverage,
  validateOpenCodeModelCost,
} from "../src/pricing.js"
import { DEVIN_MODEL_COSTS, DEVIN_PRICING_SOURCE } from "../src/pricing-data.js"

type Options = {
  modelsFile?: string
  json: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--models-file" && argv[i + 1]) {
      options.modelsFile = argv[++i]
    } else if (arg === "--json") {
      options.json = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function loadModelIds(options: Options): string[] {
  const file =
    options.modelsFile ??
    fileURLToPath(new URL("../test/fixtures/devin-pricing-models.txt", import.meta.url))
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
}

function validateCostTable(): string[] {
  const errors: string[] = []
  for (const [id, cost] of Object.entries(DEVIN_MODEL_COSTS as Record<string, unknown>)) {
    const result = validateOpenCodeModelCost(cost, `DEVIN_MODEL_COSTS[${JSON.stringify(id)}]`)
    if (!result.valid) errors.push(...result.errors)
  }
  return errors
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const modelIds = loadModelIds(options)
  const coverage = checkDevinPricingCoverage(modelIds)
  const invalidCosts = validateCostTable()
  const failed = coverage.missing.length > 0 || invalidCosts.length > 0

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          source: DEVIN_PRICING_SOURCE,
          modelCount: modelIds.length,
          costEntries: Object.keys(DEVIN_MODEL_COSTS).length,
          intentionallyUnpriced: DEVIN_UNPRICED_MODEL_IDS,
          coverage,
          invalidCosts,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(`Pricing source: ${DEVIN_PRICING_SOURCE || "(stub — no public Devin pricing feed yet)"}`)
    console.log(`Cost table entries: ${Object.keys(DEVIN_MODEL_COSTS).length}`)
    console.log(`Models checked: ${modelIds.length}`)
    console.log(`Covered: ${coverage.priced.length}`)
    console.log(`Missing: ${coverage.missing.length}`)
    console.log(`Intentionally unpriced: ${DEVIN_UNPRICED_MODEL_IDS.join(", ") || "(none)"}`)
    if (coverage.missing.length > 0) {
      console.log("Missing pricing:")
      for (const id of coverage.missing) console.log(`  ${id}`)
    }
    if (invalidCosts.length > 0) {
      console.log("Invalid cost entries:")
      for (const error of invalidCosts) console.log(`  ${error}`)
    }
  }

  if (failed) process.exit(1)
}

main()
