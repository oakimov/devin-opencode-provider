export const WINDSURF_API_HOST = "server.codeium.com"
export const WINDSURF_WEBSITE_HOST = "windsurf.com"
export const DEVIN_WEBSITE_HOST = "app.devin.ai"
export const DEVIN_API_HOST = "api.devin.ai"
export const DEVIN_AUTH_HOST = "api.devin.ai"
export const WINDSURF_REGISTER_HOST = "register.windsurf.com"
export const WINDSURF_OAUTH_CLIENT_ID = "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u"
export const FALLBACK_CLIENT_VERSION = "windsurf-1.0.0"

// Latest endpoints verified against Devin IDE 3.7.25 decompiled:
// - Auth authorize: https://app.devin.ai/auth/cli/continue (PKCE S256)
// - Auth token exchange: https://api.devin.ai/auth/cli/token
// - API (chat, GetUserStatus, GetUserJwt): https://server.codeium.com
// - Alt inference: https://api.codeium.com (legacy, not used for chat)

export const DEVIN_PROVIDER_ID = "devin"
export const WINDSURF_PROVIDER_ID = "windsurf"
export const PRIMARY_PROVIDER_ID = DEVIN_PROVIDER_ID

/** Keep alias for backwards compat — Windsurf rebranded to Devin Desktop */
export const COMPATIBLE_PROVIDER_IDS = [DEVIN_PROVIDER_ID, WINDSURF_PROVIDER_ID, "cognition"]

export const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage"
export const USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus"
export const USER_JWT_PATH = "/exa.auth_pb.AuthService/GetUserJwt"

export const MODEL_CACHE_FILE = "devin-models.json"
export const MODEL_CACHE_SCHEMA_VERSION = 2
export const MODEL_CACHE_TTL_MS = 86_400_000
export const VERSION_CACHE_FILE = "devin-client-version.json"

export const CONTENT_TYPE_CONNECT_PROTO = "application/connect+proto"
export const CONNECT_PROTOCOL_VERSION = "1"

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max"
