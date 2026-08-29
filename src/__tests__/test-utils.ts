/**
 * Test utilities for devin-opencode-provider tests
 * Provides helper functions and mocks for testing without external dependencies
 */

export function createMockAuth() {
  return {
    type: "api" as const,
    key: "mock-api-key-12345",
  }
}

export function createMockOAuthAuth() {
  return {
    type: "oauth" as const,
    access: "mock-jwt-token",
    refresh: "mock-refresh-token",
  }
}

export function createMockModelInfo(id: string, displayName?: string) {
  return {
    id,
    displayName: displayName || id,
    variants: [],
    supportsThinking: false,
    supportsAgent: true,
    supportsImages: false,
    maxContext: 200000,
    maxOutput: 32000,
  }
}

export function createMockModelInfoWithVariants(id: string, displayName: string) {
  return {
    id,
    displayName,
    variants: [
      {
        key: "default",
        parameterValues: [],
        displayName: "Default",
        isDefaultNonMax: true,
        isDefaultMax: false,
      },
      {
        key: "low",
        parameterValues: [{ id: "effort", value: "low" }],
        displayName: "Low",
        isDefaultNonMax: false,
        isDefaultMax: false,
      },
      {
        key: "max",
        parameterValues: [{ id: "effort", value: "max" }],
        displayName: "Max",
        isDefaultNonMax: false,
        isDefaultMax: true,
      },
    ],
    supportsThinking: false,
    supportsAgent: true,
    supportsImages: false,
    maxContext: 200000,
    maxOutput: 32000,
  }
}

export function createMockCacheDir() {
  return "/tmp/test-devin-cache"
}

export async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createMockAbortSignal(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}