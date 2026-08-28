import { DEVIN_API_HOST, DEVIN_WEBSITE_HOST } from "../shared.js"
import { devinApiBaseURL } from "../plugin-core.js"
import {
  buildDevinLoginUrl,
  createLoopbackServer,
  decodeJwtExpiryMs,
  generatePkceChallenge,
  generatePkceParams,
  isExpiringSoon,
  pollForDevinTokens,
} from "../auth.js"
import { DEVIN_INTEGRATION_ID } from "./catalog.js"
import type {
  CredentialOAuth,
  CredentialValue,
  IntegrationDomain,
  IntegrationDraft,
} from "./types.js"

/**
 * Integration registration for the OpenCode 2.0 plugin — the replacement for the
 * classic plugin's `auth` hook (`methods` + `loader`).
 *
 * Mirrors `cursor-opencode-provider/src/opencode2/integration.ts` structure
 * but uses Devin's PKCE loopback (`app.devin.ai` + `api.devin.ai`) instead
 * of Cursor's `/auth/poll` endpoint. Unlike Cursor's `crsr_` exchange,
 * Devin API keys are passed through to `GetUserJwt` (no `exchangeApiKey`).
 */

export const DEVIN_OAUTH_METHOD_ID = "oauth"

/** Env vars that can supply a Devin API key without running /connect. */
export const DEVIN_ENV_NAMES = ["DEVIN_API_KEY", "WINDSURF_API_KEY"]

function websiteURL(): string {
  return process.env.DEVIN_WEBSITE_URL ?? `https://${DEVIN_WEBSITE_HOST}`
}

function apiBaseURL(): string {
  return process.env.DEVIN_API_BASE_URL ?? `https://${DEVIN_API_HOST}`
}

/** Browser (PKCE) login: open loopback, poll until Devin hands back a session token. */
async function authorizeOAuth(): Promise<{
  url: string
  instructions: string
  mode: "auto"
  callback: Promise<CredentialOAuth>
}> {
  const pkce = generatePkceParams()
  const challenge = await generatePkceChallenge(pkce.verifier)
  const server = await createLoopbackServer()
  const redirectUri = `http://127.0.0.1:${server.port}/callback`
  const state = pkce.uuid
  const url = buildDevinLoginUrl({ state, codeChallenge: challenge, redirectUri, websiteUrl: websiteURL() })

  const callback = pollForDevinTokens({
    state,
    server,
    codeVerifier: pkce.verifier,
    apiBaseUrl: apiBaseURL(),
  })
    .then(({ token }): CredentialOAuth => {
      const jwt = token.includes("$") ? (token.split("$").pop() ?? token) : token
      const expires = decodeJwtExpiryMs(jwt) ?? Date.now() + 3_600_000
      return {
        type: "oauth",
        methodID: DEVIN_OAUTH_METHOD_ID,
        access: token,
        refresh: token,
        expires,
      }
    })
    .finally(() => server.close())

  return {
    url,
    instructions: "Open this URL in a browser to sign in to Devin",
    mode: "auto" as const,
    callback,
  }
}

/**
 * Renew an expiring Devin JWT.
 * Devin's PKCE token is a single `devin-session-token$JWT` without a server
 * refresh endpoint; the host calls this lazily when the stored credential is
 * close to expiry. Return the existing token if still valid, otherwise fall
 * through to a re-login.
 */
async function refreshOAuth(credential: CredentialOAuth): Promise<CredentialOAuth> {
  const jwt = credential.access.includes("$") ? (credential.access.split("$").pop() ?? credential.access) : credential.access
  const expires = decodeJwtExpiryMs(jwt)
  if (expires !== null && expires - Date.now() > 300_000) {
    return credential
  }
  // No server-side refresh for Devin session tokens — surface the existing
  // credential; the next chat will surface expiry and trigger re-auth.
  return {
    type: "oauth",
    methodID: credential.methodID || DEVIN_OAUTH_METHOD_ID,
    access: credential.access,
    refresh: credential.refresh,
    expires: expires ?? credential.expires,
    ...(credential.metadata === undefined ? {} : { metadata: credential.metadata }),
  }
}

/** Register the Devin integration and its three connection methods. */
export function applyDevinIntegration(draft: IntegrationDraft): void {
  draft.update(DEVIN_INTEGRATION_ID, (integration) => {
    integration.id = DEVIN_INTEGRATION_ID
    integration.name = "Devin"
  })

  draft.method.update({
    integrationID: DEVIN_INTEGRATION_ID,
    method: {
      id: DEVIN_OAUTH_METHOD_ID,
      type: "oauth",
      label: "Devin account (browser login)",
    },
    authorize: authorizeOAuth,
    refresh: refreshOAuth,
  })

  draft.method.update({
    integrationID: DEVIN_INTEGRATION_ID,
    method: { type: "key", label: "API key (devin.com/settings)" },
  })

  draft.method.update({
    integrationID: DEVIN_INTEGRATION_ID,
    method: { type: "env", names: DEVIN_ENV_NAMES },
  })
}

/**
 * Turn a stored credential into a Devin access token.
 *
 * OAuth credentials already hold a session token (or JWT). A `key` credential
 * is the raw API key (`sk-ws-01-...`, `cog_...`, `devin-session-token$...`)
 * which is used as-is — the chat layer mints `GetUserJwt` per-request via
 * `getCachedUserJwt`, mirroring the classic plugin's behavior.
 */
export async function accessTokenFromCredential(
  credential: CredentialValue | undefined,
): Promise<string | undefined> {
  if (!credential) return undefined

  if (credential.type === "oauth") {
    const jwt = credential.access.includes("$") ? (credential.access.split("$").pop() ?? credential.access) : credential.access
    if (credential.access && jwt && !isExpiringSoon(jwt)) return credential.access
    if (!credential.refresh) return credential.access || undefined
    try {
      return (await refreshOAuth(credential)).access
    } catch {
      // Fall back to the existing token; the call may still succeed.
      return credential.access || undefined
    }
  }

  if (credential.type === "key") {
    // Devin keys are long-lived bearer tokens; return verbatim for GetUserJwt.
    // No `crsr_`-style exchange.
    void devinApiBaseURL
    return credential.key || undefined
  }

  return undefined
}

/** Resolve the active Devin connection into an access token, if any. */
export async function resolveDevinAccessToken(
  integration: IntegrationDomain,
): Promise<string | undefined> {
  try {
    const connection = await integration.connection.active(DEVIN_INTEGRATION_ID)
    if (!connection) return undefined
    return await accessTokenFromCredential(await integration.connection.resolve(connection))
  } catch {
    return undefined
  }
}
