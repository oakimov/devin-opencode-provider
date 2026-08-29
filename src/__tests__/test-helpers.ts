// Test utilities for auth tests
export function createMockToken(expirySeconds = 3600): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = btoa(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expirySeconds,
    iat: Math.floor(Date.now() / 1000)
  }))
  const signature = btoa("mock_signature")
  return `${header}.${payload}.${signature}`
}

export function createExpiredToken(): string {
  return createMockToken(-3600)
}