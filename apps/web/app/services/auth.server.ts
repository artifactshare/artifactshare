/*
 * better-auth wiring — Cloudflare Workers + D1. The auth instance is built once
 * per isolate (see `createAuth` at the bottom): the `cloudflare:workers` env and
 * its D1 binding are stable for the isolate's lifetime.
 */

import {
  getCurrentAuthContextAsyncLocalStorage,
  getRequestStateAsyncLocalStorage,
} from '@better-auth/core/context'
import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
} from '@better-auth/oauth-provider'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import {
  deviceAuthorization,
  emailOTP,
  jwt,
  lastLoginMethod,
} from 'better-auth/plugins'
import { z } from 'zod'
import { env } from 'cloudflare:workers'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Kysely, sql } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import { nanoid } from 'nanoid'
import { PUBLIC_CACHEABLE_CORS_HEADERS } from '~/lib/agent-surface'
import { decodeBase64Url } from '~/lib/base64url'
import { APEX_HOST } from '~/lib/hosts'
import { mcpResourceUrl } from '~/lib/mcp-metadata'
import { nowIso } from '~/lib/datetime'
import { normalizeLocaleTag } from '~/lib/i18n.server'
import { PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-plan.server'
import { LINK_SHARING_PLAN_DEFAULTS } from '~/lib/link-sharing-policy'
import type { SessionUser } from '~/lib/user'
import { isReservedBotEmailDomain } from '~/lib/bot-account'
import {
  isPublicEmailDomain,
  normalizeEmailDomain,
} from '~/lib/workspace-domains'
import type { DB } from '~/types/db'
import {
  findUserByApiToken,
  isApiToken,
  touchApiTokenLastUsedByHash,
} from './api-tokens.server'
import {
  ensureWorkspaceAdmin,
  ensureActiveWorkspaceMembership,
} from './team-management.server'
import {
  clearWorkspaceCreatedIfMoved,
  insertPendingSignup,
  type SignupMethod,
} from './signup-analytics.server'
import {
  canAutoMoveUserWorkspace,
  ensureDomainClaimWorkspace,
  ensureWorkspaceDomainClaim,
  findWorkspaceIdByDomainClaim,
  maybeMoveUserToClaimedWorkspace,
  moveUserToWorkspaceForOAuth,
} from './workspace-domain-claims.server'
import { CLI_DEVICE_SESSION_USER_AGENT } from './cli-refresh-credentials.server'
import {
  devScreenUserEmail,
  ensureDevScreenState,
  isScreenScenario,
  seedDevScreenState,
} from './dev-screen-state.server'

const GOOGLE_SIGNIN_SCOPES = ['openid', 'email', 'profile']
const BEARER_SCHEME = 'bearer '
const CLI_DEVICE_CLIENT_ID = 'artifactshare-cli'
const UTF8_DECODER = new TextDecoder()
const BETTER_AUTH_COOKIE_CACHE_SECONDS = 5 * 60
const pendingSignupState = new Map<
  string,
  { method: SignupMethod; workspaceCreated: boolean }
>()

interface SessionWorkspaceContext {
  workspaceId: string
  selfUploadEnabled: boolean
  hd: string | null
  msTenantId: string | null
  kind: 'human' | 'bot'
}

interface GoogleProfile {
  sub: string
  email: string
  email_verified?: boolean
  name?: string
  picture?: string
  locale?: string
  hd?: string
}

interface GoogleIdTokenPayload {
  email?: string
  email_verified?: boolean
  hd?: string
}

interface MicrosoftProfile {
  sub: string
  oid: string
  tid: string
  email?: string
  preferred_username: string
  upn?: string
  name?: string
  picture?: string
  given_name?: string
  family_name?: string
  email_verified?: boolean
  xms_edov?: boolean
  verified_primary_email?: string[]
  verified_secondary_email?: string[]
}

interface MicrosoftVerifiedDomain {
  name?: string
  isInitial?: boolean
}

interface MicrosoftOrganization {
  id?: string
  displayName?: string
  verifiedDomains?: MicrosoftVerifiedDomain[]
}

function buildAuth() {
  const dialect = new D1Dialect({ database: env.DB })
  // Reuse the dialect across our Kysely instance + better-auth's, so we don't
  // pay for two D1Dialect constructions per request.
  const db = new Kysely<DB>({ dialect })

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: { dialect, type: 'sqlite' },

    // The jwt plugin's /token endpoint mints a JWT for the current browser
    // session. We only want JWTs minted through the OAuth flow, so disable it.
    disabledPaths: ['/token'],

    // Typed as BetterAuthPlugin[] so the plugins' zod-v4 endpoint schemas don't
    // leak into createAuth's inferred return type (TS2883, non-portable). The
    // OAuth/JWT endpoints are served through `.handler`, not typed `.api`.
    plugins: [
      // Signs OAuth access tokens as JWTs (verifiable via /jwks without a D1
      // read) and stores the signing keys in the `jwks` table.
      jwt(),
      // OAuth 2.1 authorization server. MCP hosts self-register via dynamic
      // client registration (no pre-shared credentials), so unauthenticated
      // registration is on; public clients get PKCE enforced by default.
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Restrict token audiences to the MCP endpoint URL: clients send it as
        // the RFC 8707 `resource`, and the JWT `aud` is verified against it at
        // /mcp. Setting this replaces the default (baseURL) accepted audience.
        validAudiences: [mcpResourceUrl(env.BETTER_AUTH_URL)],
        // The plugin can't see our framework routes, so it warns at init to
        // confirm the RFC 8414 metadata is reachable. It is — served at
        // /.well-known/oauth-authorization-server/api/auth by the splat route
        // (see routes/[.]well-known.oauth-authorization-server.$.ts) — so the
        // warning is a false positive. openid-configuration isn't warned
        // because basePath equals the issuer path (/api/auth).
        silenceWarnings: { oauthAuthServerConfig: true },
      }),
      deviceAuthorization({
        verificationUri: '/device',
        validateClient: (clientId) => clientId === CLI_DEVICE_CLIENT_ID,
        // better-auth declares `schema` as required in the plugin's option
        // validation (still true in 1.6.16); omitting it throws a ZodError at
        // construction. An empty object is a no-op for mergeSchema.
        schema: {},
      }),
      // Passwordless email sign-in for recipients whose tenant blocks both
      // Google and Microsoft SSO. A one-time code (not a magic link) so the
      // login survives corporate email link-scanners pre-fetching URLs and
      // works when the code is read on a different device than the browser.
      // First sign-in auto-creates the user (disableSignUp left false), which
      // runs databaseHooks.user.create.before → a personal workspace; access
      // is then granted by email-matched shares.
      emailOTP({
        otpLength: 6,
        // Corporate mail can be delayed; give the round-trip 10 minutes.
        expiresIn: 600,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp }) => {
          // Defense in depth: the reserved bot domain is unreachable and bot
          // users never sign in, so refuse before sending anything.
          await assertBotSignInAllowedForEmail(db, email)
          await sendOtpEmail(email, otp)
        },
      }),
      // Record the method used on each sign-in in a 30-day cookie
      // (better-auth.last_used_login_method), so the sign-in screen can show a
      // "last used" hint. The default resolver maps OAuth callbacks to the
      // provider id (google / microsoft); our email-code endpoint
      // (/sign-in/email-otp) isn't recognized, so map it to "email" ourselves.
      lastLoginMethod({
        customResolveMethod: (ctx) =>
          ctx.path === '/sign-in/email-otp' ? 'email' : null,
      }),
      ...(import.meta.env.DEV ? [devSignInPlugin(db)] : []),
    ] as BetterAuthPlugin[],

    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              scope: GOOGLE_SIGNIN_SCOPES,
              // Always show Google's account chooser so a user with more than one
              // account can pick which one to sign in / connect with. Without this,
              // Google silently reuses the browser's default account, which makes
              // switching the connected account (e.g. for the MCP connector) impossible.
              prompt: 'select_account',
              mapProfileToUser: (profile: GoogleProfile) => ({
                name: profile.name ?? profile.email,
                image: profile.picture,
                locale: normalizeLocaleTag(profile.locale),
              }),
            },
          }
        : {}),
      ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
        ? {
            microsoft: {
              clientId: env.MICROSOFT_CLIENT_ID,
              clientSecret: env.MICROSOFT_CLIENT_SECRET,
              tenantId: 'organizations',
              prompt: 'select_account',
              // Custom getUserInfo skips Better Auth's built-in Graph photo fetch on
              // every login. Profile photos are still fetched once on account create
              // via databaseHooks.account.create.after.
              disableProfilePhoto: true,
              getUserInfo: getMicrosoftUserInfo,
            },
          }
        : {}),
    },

    advanced: {
      database: {
        generateId: () => nanoid(),
      },
    },

    user: {
      modelName: 'users',
      fields: {
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        emailVerified: 'email_verified',
      },
      additionalFields: {
        workspaceId: {
          type: 'string',
          // Not better-auth-required: it's filled for every create path by
          // databaseHooks.user.create.before and the DB column is NOT NULL, so
          // the guarantee lives there. Marking it required here additionally
          // makes the emailOTP plugin's auto-create fail — it calls
          // parseUserInput before that hook runs, so the field looks missing.
          required: false,
          input: false,
          fieldName: 'workspace_id',
        },
        locale: {
          type: 'string',
          required: false,
          input: false,
          fieldName: 'locale',
        },
      },
    },

    session: {
      modelName: 'sessions',
      fields: {
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
      },
      // Sign session payload into the cookie itself so getSession() can
      // verify without a D1 lookup. Falls back to the DB after maxAge so
      // revocations and user/workspace changes propagate within five minutes.
      cookieCache: {
        enabled: true,
        maxAge: BETTER_AUTH_COOKIE_CACHE_SECONDS,
      },
    },

    account: {
      modelName: 'accounts',
      fields: {
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        accountId: 'account_id',
        idToken: 'id_token',
        providerId: 'provider_id',
        userId: 'user_id',
        // better-auth INSERT に出てくる列。本仕様の方針として書き込まれる値は
        // NULL になるが、列名マッピングが無いと camelCase のまま SQL に出て
        // SQLITE_ERROR になる。
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
      },
      // Identity policy: a verified email is one person. better-auth links a
      // second provider onto an existing user when the incoming email is
      // verified AND the existing row's email is verified (link-account.ts).
      // Google is listed as trusted (its email is always verified, so this is
      // belt-and-suspenders). Microsoft is intentionally NOT trusted: that
      // keeps the verified-email gate in force, so an unverified Microsoft
      // email can't link onto someone else's account (takeover guard). A
      // verified Microsoft email (xms_edov / verified_primary_email) still
      // links — which is what we want. The only blocked case is an unverified
      // Microsoft email colliding with an existing account; that recipient is
      // steered to email-code sign-in (which always lands on the same user).
      accountLinking: {
        trustedProviders: ['google'],
        // When a second provider links, copy its profile (name, image) onto the
        // user. updateUser drops undefined fields, so Microsoft (which returns
        // image: undefined) never blanks an existing photo, while Google (which
        // has a public photo) fills it. Net: a real photo wins. email /
        // emailVerified are never touched, so identity can't be rebound.
        updateUserInfoOnLink: true,
      },
    },

    verification: {
      modelName: 'verifications',
      disableCleanup: true,
      fields: {
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        expiresAt: 'expires_at',
      },
    },

    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            // Invariant backstop: no auth entry point may mint a session for
            // a bot user, whatever route it came through.
            await assertBotSignInAllowedForUserId(
              db,
              (session as { userId?: unknown }).userId,
            )
            return isCliDeviceTokenDatabaseHookContext(context)
              ? {
                  data: {
                    ...session,
                    userAgent: CLI_DEVICE_SESSION_USER_AGENT,
                  },
                }
              : undefined
          },
        },
      },
      user: {
        create: {
          before: async (user, context) => {
            const u = user as typeof user & {
              email: string
              emailVerified?: boolean | null
              kind?: unknown
            }
            // External sign-up paths can never create a bot row or claim an
            // address under the reserved bot email domain (users.email is
            // UNIQUE, so a pre-claimed row would block bot creation).
            if (u.kind === 'bot' || isReservedBotEmailDomain(u.email)) {
              throw botSignInRejectedError()
            }
            const authRoute = authRouteFromDatabaseHookContext(context)
            const creation = workspaceCreationPolicyForAuthRoute(authRoute)
            const emailVerified = u.emailVerified === true
            const { workspaceId, created } = await ensureWorkspace(
              db,
              u.email,
              null,
              null,
              null,
              emailVerified,
              creation,
              authRoute === undefined,
            )
            const method: SignupMethod =
              authRoute === 'oauth-google'
                ? 'google'
                : authRoute === 'oauth-microsoft'
                  ? 'microsoft'
                  : 'email'
            pendingSignupState.set(u.email.toLowerCase(), {
              method,
              workspaceCreated: created,
            })
            return {
              data: {
                ...u,
                email: u.email.toLowerCase(),
                workspaceId,
              },
            }
          },
          after: async (user) => {
            if (!user) return
            // Consume the signup marker first: the unconditional delete avoids
            // a Map leak if a later step throws, and recording the pending row
            // before the membership/admin writes means a failure there does not
            // lose the analytics row (the user row is already committed).
            const key = user.email.toLowerCase()
            const signup = pendingSignupState.get(key)
            pendingSignupState.delete(key)
            if (signup) {
              try {
                await insertPendingSignup(db, {
                  userId: user.id,
                  method: signup.method,
                  workspaceCreated: signup.workspaceCreated,
                  now: nowIso(),
                })
              } catch {
                // Analytics is best-effort (approximately-once): a pending-row
                // write failure must not block the membership/admin provisioning
                // below or fail the sign-up request.
              }
            }
            const row = await db
              .selectFrom('users')
              .select('workspace_id')
              .where('id', '=', user.id)
              .executeTakeFirst()
            const workspaceId = row?.workspace_id
            if (!workspaceId) return
            const now = nowIso()
            await ensureActiveWorkspaceMembership(db, user.id, workspaceId, now)
            await ensureWorkspaceAdmin(db, workspaceId, now)
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            // OAuth account linking must never attach to a bot user.
            await assertBotSignInAllowedForUserId(
              db,
              (account as { userId?: unknown }).userId,
            )
            return undefined
          },
          after: async (account) => {
            if (!account) return
            if (
              account.providerId === 'google' ||
              account.providerId === 'microsoft'
            ) {
              const before = await db
                .selectFrom('users')
                .select('workspace_id')
                .where('id', '=', account.userId)
                .executeTakeFirst()
              const originalWorkspaceId = before?.workspace_id ?? null
              const finalWorkspaceId =
                await resolveOAuthWorkspaceAfterAccountCreate(db, {
                  providerId: account.providerId,
                  userId: account.userId,
                  idToken: account.idToken ?? null,
                })
              // Moved into an existing domain-claimed workspace ⇒ domain-join,
              // not a self-serve creation ⇒ workspace_created must not fire.
              await clearWorkspaceCreatedIfMoved(db, {
                userId: account.userId,
                originalWorkspaceId,
                finalWorkspaceId,
              })
            }
            if (account.providerId !== 'microsoft' || !account.accessToken)
              return
            try {
              const photoResponse = await fetch(
                'https://graph.microsoft.com/v1.0/me/photos/48x48/$value',
                {
                  headers: { Authorization: `Bearer ${account.accessToken}` },
                  // This hook is awaited on the login critical path; cap a slow
                  // or hanging Graph call so it can't stall first sign-in.
                  signal: AbortSignal.timeout(2500),
                },
              )
              if (!photoResponse.ok) return
              const photoBuffer = await photoResponse.arrayBuffer()
              const avatarKey = `avatars/${account.userId}.jpg`
              await env.BUCKET.put(avatarKey, photoBuffer, {
                httpMetadata: { contentType: 'image/jpeg' },
              })
              const avatarUrl = `${env.BETTER_AUTH_URL}/api/avatar/${account.userId}`
              // Only fill an empty avatar: if the user already has a photo
              // (e.g. a linked Google account), don't replace it with the
              // Microsoft one. A real photo, once set, wins.
              await db
                .updateTable('users')
                .set({ image: avatarUrl, updated_at: nowIso() })
                .where('id', '=', account.userId)
                .where('image', 'is', null)
                .execute()
            } catch {
              // A failed (or timed-out) photo fetch must not block login.
            }
          },
        },
      },
    },
  })
}

export async function enableWorkspaceSelfUploadForOAuthAccount(
  db: Kysely<DB>,
  userId: string,
): Promise<void> {
  const workspace = await db
    .selectFrom('users')
    .innerJoin('workspaces', 'workspaces.id', 'users.workspace_id')
    .select([
      'workspaces.id',
      'workspaces.self_upload_enabled',
      'workspaces.storage_quota_bytes',
    ])
    .where('users.id', '=', userId)
    .executeTakeFirst()
  if (!workspace || workspace.self_upload_enabled !== 0) return

  await db
    .updateTable('workspaces')
    .set({
      self_upload_enabled: 1,
      storage_quota_bytes:
        workspace.storage_quota_bytes === 0
          ? PLAN_STORAGE_QUOTA_BYTES.free
          : workspace.storage_quota_bytes,
    })
    .where('id', '=', workspace.id)
    .where('self_upload_enabled', '=', 0)
    .execute()
}

export async function resolveOAuthWorkspaceAfterAccountCreate(
  db: Kysely<DB>,
  input: {
    providerId: string
    userId: string
    idToken: string | null
  },
): Promise<string | null> {
  if (input.providerId !== 'google' && input.providerId !== 'microsoft') {
    return null
  }

  const user = await db
    .selectFrom('users')
    .select(['email', 'email_verified', 'workspace_id'])
    .where('id', '=', input.userId)
    .executeTakeFirst()
  if (!user || user.email_verified !== 1) return null

  const currentWorkspaceId = user.workspace_id
  const targetWorkspaceId = await resolveOAuthTargetWorkspace(db, {
    providerId: input.providerId,
    email: user.email,
    idToken: input.idToken,
    userId: input.userId,
    currentWorkspaceId,
  })

  if (targetWorkspaceId && targetWorkspaceId !== currentWorkspaceId) {
    const movedWorkspaceId = await moveUserToWorkspaceForOAuth(db, {
      userId: input.userId,
      email: user.email,
      currentWorkspaceId,
      targetWorkspaceId,
    })
    if (!movedWorkspaceId) return null
    await ensureWorkspaceAdmin(db, movedWorkspaceId, nowIso())
    return movedWorkspaceId
  }

  if (targetWorkspaceId) {
    await ensureActiveWorkspaceMembership(
      db,
      input.userId,
      targetWorkspaceId,
      nowIso(),
      { reactivateRemoved: true },
    )
    return targetWorkspaceId
  }

  const currentWorkspace = await db
    .selectFrom('users')
    .innerJoin('workspaces', 'workspaces.id', 'users.workspace_id')
    .select(['users.workspace_id', 'workspaces.self_upload_enabled'])
    .where('users.id', '=', input.userId)
    .executeTakeFirst()
  if (
    currentWorkspace?.self_upload_enabled === 0 &&
    !(await canAutoMoveUserWorkspace(db, input.userId, {
      allowCurrentWorkspaceAdmin: currentWorkspaceId,
    }))
  ) {
    return null
  }

  await enableWorkspaceSelfUploadForOAuthAccount(db, input.userId)
  return currentWorkspace?.workspace_id ?? null
}

async function resolveOAuthTargetWorkspace(
  db: Kysely<DB>,
  input: {
    providerId: string
    email: string
    idToken: string | null
    userId: string
    currentWorkspaceId: string
  },
): Promise<string | null> {
  let googlePayload: GoogleIdTokenPayload | null = null
  if (input.providerId === 'google') {
    if (!input.idToken) return null
    try {
      googlePayload = decodeGoogleIdTokenPayload(input.idToken)
    } catch {
      return null
    }
    const tokenEmail = googlePayload.email?.toLowerCase()
    if (
      googlePayload.email_verified === false ||
      (tokenEmail && tokenEmail !== input.email.toLowerCase())
    ) {
      return null
    }
  }

  if (input.providerId === 'google') {
    const domain = normalizeEmailDomain(googlePayload?.hd)
    if (googlePayload?.hd !== undefined) {
      if (
        !domain ||
        isPublicEmailDomain(domain) ||
        googlePayload.email_verified === false
      ) {
        return null
      }
      if (
        !(await canAutoMoveUserWorkspace(db, input.userId, {
          allowCurrentWorkspaceAdmin: input.currentWorkspaceId,
        }))
      ) {
        return null
      }
      return await ensureDomainClaimWorkspace(db, {
        domain,
        source: 'google_hd',
        now: nowIso(),
        creation: workspaceCreationValues(DEFAULT_WORKSPACE_CREATION_POLICY),
      })
    }
  }

  const emailDomain = normalizeEmailDomain(input.email)
  const existingClaim = await findWorkspaceIdByDomainClaim(db, emailDomain)
  if (existingClaim) return existingClaim

  if (!input.idToken) return null
  let tenantId: string
  try {
    tenantId = decodeMicrosoftIdTokenPayload(input.idToken).tid
  } catch {
    return null
  }
  if (!tenantId) return null
  const fallback = await db
    .selectFrom('workspaces')
    .select('id')
    .where('ms_tenant_id', '=', tenantId)
    .executeTakeFirst()
  return fallback?.id ?? null
}

// Safe to build once per isolate: the `cloudflare:workers` env (and its D1
// binding) is stable for the isolate's lifetime, and better-auth resolves
// request context per call. Building per request would reconstruct the OAuth /
// JWT plugin set (dozens of endpoints + schemas) on every request — including
// non-auth pages, which read the session through the root middleware.
/*
 * better-auth resolves AsyncLocalStorage through a dynamic-import promise
 * cached at module scope; if the request that first drives it gets aborted,
 * the promise never settles and poisons the isolate. Pre-seeding the storages
 * from a static import at global scope (no request context, cannot be
 * aborted) makes that lazy path unreachable. The key names are better-auth
 * internals; the seed degrades to a no-op if they change.
 */
const betterAuthGlobalSymbol = Symbol.for('better-auth:global')

function seedBetterAuthAsyncStorage(): void {
  const holder = globalThis as unknown as Record<
    symbol,
    | { version: string; epoch: number; context: Record<string, unknown> }
    | undefined
  >
  const shared = (holder[betterAuthGlobalSymbol] ??= {
    version: 'artifactshare-seed',
    epoch: 0,
    context: {},
  })
  shared.context.requestStateAsyncStorage ??= new AsyncLocalStorage()
  shared.context.endpointContextAsyncStorage ??= new AsyncLocalStorage()
  shared.context.adapterAsyncStorage ??= new AsyncLocalStorage()
}
seedBetterAuthAsyncStorage()

let cachedAuth: ReturnType<typeof buildAuth> | undefined
let lazyInitAnchored = false

/**
 * Anchor better-auth's lazy initialization to the request's waitUntil, once
 * per isolate.
 *
 * better-auth resolves node:async_hooks through a dynamic-import promise
 * cached at module scope, and caches its own init promise on the auth
 * instance. Both are lazily driven by whichever request touches auth first in
 * a fresh isolate. If the client aborts that request mid-initialization, the
 * cached promises never settle and every later auth call in the isolate hangs
 * before reaching D1. waitUntil keeps the initializing request's context
 * alive past a client abort until initialization settles.
 */
export function anchorAuthInit(ctx: ExecutionContext): void {
  if (lazyInitAnchored) return
  lazyInitAnchored = true
  ctx.waitUntil(
    initAuthLazyState().catch(() => {
      // Allow the next request to retry the anchoring; the instance itself is
      // kept so a deterministic init failure stays a cheap cached rejection
      // instead of a per-request rebuild.
      lazyInitAnchored = false
    }),
  )
}

async function initAuthLazyState(): Promise<void> {
  await getCurrentAuthContextAsyncLocalStorage()
  await getRequestStateAsyncLocalStorage()
  const auth = createAuth()
  // Bound the anchor await: if this instance is already poisoned, an
  // unbounded await would keep the anchoring invocation pending forever.
  const ready = await raceHang(
    (auth as unknown as { $context: Promise<unknown> }).$context,
    ANCHOR_HANG_MS,
  )
  if (ready === HANG) {
    // A hung init never recovers; drop the instance so direct auth callers
    // rebuild instead of reusing it. Plain rejections stay cached: they are
    // cheap to re-await and eviction would rebuild on every request.
    if (cachedAuth === auth) cachedAuth = undefined
    throw new Error('auth lazy init hang')
  }
}

export const HANG = Symbol('promise hang')
const ANCHOR_HANG_MS = 10_000
const GET_SESSION_HANG_MS = 3000
const FRESH_GET_SESSION_HANG_MS = 5000
const DIRECT_AUTH_HANG_MS = 3000
const FRESH_DIRECT_AUTH_HANG_MS = 5000
const AUTH_HANDLER_HANG_MS = 30_000

/**
 * Resolve to HANG when `promise` stays pending past `ms`, without cancelling
 * it (better-auth calls expose no abort signal). The loser's eventual
 * rejection is swallowed so an abandoned attempt cannot surface as an
 * unrelated uncaught error.
 */
export async function raceHang<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof HANG> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof HANG>((resolve) => {
    timer = setTimeout(() => resolve(HANG), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
    promise.catch(() => {})
  }
}

/**
 * Read the session for a request. Returns null if unauthenticated.
 *
 * A client abort can leave a lazily-cached promise inside the shared auth
 * instance permanently pending; awaiting it would hang every later call in
 * the isolate. Detect the hang, rebuild the instance once, and fail null
 * rather than hang. The structured log keeps the recovery observable and
 * feeds the Slack alert. Thresholds: a healthy getSession is tens of
 * milliseconds; a D1 tail spike is well under a second. A false positive
 * costs one instance rebuild, not a user-visible error, as long as the
 * second window resolves.
 */
async function getSession(headers: Headers) {
  if (!env.BETTER_AUTH_SECRET) return null
  const auth = createAuth()
  const first = await raceHang(
    auth.api.getSession({ headers }),
    GET_SESSION_HANG_MS,
  )
  if (first !== HANG) return first

  // Only drop the instance we found hanging: a concurrent request may have
  // already rebuilt the cache, and rebuilding again would stampede. Re-arm
  // the anchor so the replacement instance gets anchored too.
  if (cachedAuth === (auth as unknown as ReturnType<typeof buildAuth>)) {
    cachedAuth = undefined
    lazyInitAnchored = false
  }
  // The rebuilt instance initializes inside this request without an anchor;
  // if this request also aborts, the next request detects the hang again and
  // rebuilds once more, so poisoning cannot stick.
  const fresh = createAuth()
  const second = await raceHang(
    fresh.api.getSession({ headers }),
    FRESH_GET_SESSION_HANG_MS,
  )
  logAuthHang('getSession', second !== HANG)
  if (second !== HANG) return second
  if (cachedAuth === fresh) {
    cachedAuth = undefined
    lazyInitAnchored = false
  }
  return null
}

export function createAuth() {
  return (cachedAuth ??= buildAuth())
}

function discardCachedAuthInstance(auth: ReturnType<typeof buildAuth>): void {
  if (cachedAuth !== auth) return
  cachedAuth = undefined
  lazyInitAnchored = false
}

function logAuthHang(route: string, recovered: boolean): void {
  console.warn('artifactshare_auth_hang', {
    route,
    recovered,
  })
}

async function withDirectAuthReadHangDetection<T>(
  route: string,
  read: (auth: ReturnType<typeof buildAuth>) => Promise<T>,
): Promise<T | typeof HANG> {
  const auth = createAuth()
  const first = await raceHang(read(auth), DIRECT_AUTH_HANG_MS)
  if (first !== HANG) return first

  discardCachedAuthInstance(auth)
  const fresh = createAuth()
  const second = await raceHang(read(fresh), FRESH_DIRECT_AUTH_HANG_MS)
  logAuthHang(route, second !== HANG)
  if (second !== HANG) return second

  discardCachedAuthInstance(fresh)
  return HANG
}

export async function authHandlerWithHangDetection(
  request: Request,
): Promise<Response> {
  const auth = createAuth()
  const response = await raceHang(auth.handler(request), AUTH_HANDLER_HANG_MS)
  if (response !== HANG) return response

  discardCachedAuthInstance(auth)
  logAuthHang('auth.handler', false)
  return new Response('Auth temporarily unavailable', { status: 503 })
}

export async function getLocalJwksWithHangDetection(): Promise<unknown> {
  const jwks = await withDirectAuthReadHangDetection('jwks', async (auth) => {
    const api = auth.api as unknown as { getJwks: () => Promise<unknown> }
    return await api.getJwks()
  })
  if (jwks !== HANG) return jwks
  throw new Error('auth jwks hang')
}

/**
 * Root-level `/.well-known/oauth-authorization-server` handler. The plugin
 * serves it under `/api/auth`, but MCP clients look for it at the site root,
 * so this builds the same metadata for a root route. The cast bridges the
 * erased plugin types on `createAuth()`; the method exists at runtime.
 */
export function oauthAuthServerMetadataHandler(
  request: Request,
): Promise<Response> {
  return oauthAuthServerMetadataWithHangDetection(request)
}

async function oauthAuthServerMetadataWithHangDetection(
  request: Request,
): Promise<Response> {
  const response = await withDirectAuthReadHangDetection(
    'oauth.metadata',
    async (auth) => {
      const typedAuth = auth as unknown as {
        api: { getOAuthServerConfig: (...args: unknown[]) => unknown }
      }
      return await oauthProviderAuthServerMetadata(typedAuth, {
        headers: PUBLIC_CACHEABLE_CORS_HEADERS,
      })(request)
    },
  )
  if (response !== HANG) return response
  return new Response('Auth temporarily unavailable', { status: 503 })
}

function tryDecodeBearerToken(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function readBearerSessionToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization')
  if (!authHeader || authHeader.slice(0, 7).toLowerCase() !== BEARER_SCHEME) {
    return null
  }
  const token = authHeader.slice(7).trim()
  if (!token) return null
  return normalizeBearerSessionToken(tryDecodeBearerToken(token))
}

function normalizeBearerSessionToken(token: string): string {
  return token.split('.')[0] ?? token
}

function createSessionDb() {
  return new Kysely<DB>({
    dialect: new D1Dialect({ database: env.DB }),
  })
}

async function resolveSessionUser(
  headers: Headers,
): Promise<SessionUser | null> {
  const session = await getSession(headers).catch(() => null)
  if (!session) return null
  const sessionUser = {
    id: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    locale:
      'locale' in session.user && typeof session.user.locale === 'string'
        ? session.user.locale
        : null,
  }
  let sessionDb: Kysely<DB> | undefined
  const getDb = () => (sessionDb ??= createSessionDb())
  try {
    let context = await loadWorkspaceContextByUserId(getDb(), sessionUser.id)
    if (!context) return null
    // Invariant: cookie-derived session resolution never returns a bot user.
    // Bots authenticate only through bearer CLI sessions with an agent
    // authority; any cookie session that maps onto a bot row is treated as
    // unauthenticated regardless of entry point.
    if (context.kind === 'bot') return null
    const emailDomain = normalizeEmailDomain(sessionUser.email)
    const shouldCheckClaimMove =
      emailDomain &&
      context.selfUploadEnabled &&
      !isPublicEmailDomain(emailDomain) &&
      normalizeEmailDomain(context.hd) !== emailDomain
    const movedWorkspaceId = shouldCheckClaimMove
      ? await maybeMoveUserToClaimedWorkspace(getDb(), {
          userId: sessionUser.id,
          email: sessionUser.email,
          currentWorkspaceId: context.workspaceId,
        })
      : null
    if (movedWorkspaceId) {
      const movedContext = await loadWorkspaceContextByUserId(
        getDb(),
        sessionUser.id,
      )
      if (!movedContext) return null
      context = movedContext
    }
    // The cookie cache can hold a stale emailVerified=false right after an
    // email-code sign-in promotes the DB row (better-auth writes the cookie from
    // the pre-update user). Re-read the fresh flag only in that case, so a
    // just-verified user gets email-grant access immediately; verified sessions
    // keep the no-DB-read fast path.
    const emailVerified = sessionUser.emailVerified
      ? true
      : await readEmailVerified(getDb(), sessionUser.id)
    const image =
      sessionUser.image ??
      (isRecentSessionTimestamp(
        (session.session as { updatedAt?: unknown } | undefined)?.updatedAt,
      )
        ? await readUserImage(getDb(), sessionUser.id)
        : null)
    return { ...sessionUser, ...context, emailVerified, image }
  } finally {
    if (sessionDb) await sessionDb.destroy()
  }
}

type BearerUserRow = {
  id: string
  email: string
  email_verified: number
  name: string | null
  image: string | null
  locale: string | null
}

async function buildSessionUserFromBearerRow(
  db: Kysely<DB>,
  user: BearerUserRow,
): Promise<SessionUser | null> {
  let context = await loadWorkspaceContextByUserId(db, user.id)
  if (!context) return null
  // Domain-claim workspace moves are a human-only mechanism: a bot's
  // workspace_id is its host workspace and must never move.
  if (context.selfUploadEnabled && context.kind === 'human') {
    const movedWorkspaceId = await maybeMoveUserToClaimedWorkspace(db, {
      userId: user.id,
      email: user.email,
      currentWorkspaceId: context.workspaceId,
    })
    if (movedWorkspaceId) {
      context = await loadWorkspaceContextByUserId(db, user.id)
      if (!context) return null
    }
  }
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.email_verified === 1,
    name: user.name,
    image: user.image,
    locale: user.locale,
    ...context,
  }
}

async function loadBearerSessionUser(
  token: string,
): Promise<SessionUser | null> {
  const db = createSessionDb()
  try {
    if (isApiToken(token)) {
      const apiTokenUser = await findUserByApiToken(db, token)
      if (!apiTokenUser) return null

      const sessionUser = await buildSessionUserFromBearerRow(db, apiTokenUser)
      if (!sessionUser) return null

      await touchApiTokenLastUsedByHash(db, apiTokenUser.tokenHash).catch(
        () => {},
      )

      return sessionUser
    }

    const user = await db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select([
        'users.id',
        'users.email',
        'users.email_verified',
        'users.name',
        'users.image',
        'users.locale',
      ])
      .where('sessions.token', '=', token)
      .where('sessions.expires_at', '>', nowIso())
      .executeTakeFirst()

    if (!user) return null
    return await buildSessionUserFromBearerRow(db, user)
  } finally {
    await db.destroy()
  }
}

/**
 * Returns the typed app user, or null if unauthenticated. Centralizes the
 * cast from better-auth's user shape to our `SessionUser`.
 */
export function getSessionUser(request: Request): Promise<SessionUser | null> {
  return resolveSessionUser(request.headers)
}

/**
 * Resolve a CLI bearer session token without enabling bearer auth globally.
 * Only call from explicit CLI / upload API boundaries.
 */
export function getSessionUserFromBearer(
  request: Request,
): Promise<SessionUser | null> {
  const token = readBearerSessionToken(request)
  if (!token) return Promise.resolve(null)
  return loadBearerSessionUser(token)
}

// ── internals ────────────────────────────────────────────────────

async function readEmailVerified(
  db: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('email_verified')
    .where('id', '=', userId)
    .executeTakeFirst()
  return row?.email_verified === 1
}

async function readUserImage(
  db: Kysely<DB>,
  userId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('users')
    .select('image')
    .where('id', '=', userId)
    .executeTakeFirst()
  return row?.image ?? null
}

function isRecentSessionTimestamp(value: unknown): boolean {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string' || typeof value === 'number'
        ? Date.parse(String(value))
        : Number.NaN
  if (!Number.isFinite(timestamp)) return false
  const ageMs = Date.now() - timestamp
  return ageMs >= -60_000 && ageMs <= BETTER_AUTH_COOKIE_CACHE_SECONDS * 1000
}

async function loadWorkspaceContextByUserId(
  db: Kysely<DB>,
  userId: string,
): Promise<SessionWorkspaceContext | null> {
  const row = await db
    .selectFrom('users')
    .innerJoin('workspaces', 'workspaces.id', 'users.workspace_id')
    .leftJoin(
      'workspace_domain_claims',
      'workspace_domain_claims.workspace_id',
      'workspaces.id',
    )
    .select([
      'users.workspace_id',
      'users.kind',
      'workspaces.hd',
      'workspaces.ms_tenant_id',
      'workspaces.self_upload_enabled',
      'workspace_domain_claims.domain as claimed_domain',
    ])
    .where('users.id', '=', userId)
    .executeTakeFirst()
  if (!row) return null
  return {
    workspaceId: row.workspace_id,
    selfUploadEnabled: row.self_upload_enabled === 1,
    hd: row.hd ?? row.claimed_domain ?? null,
    msTenantId: row.ms_tenant_id ?? null,
    kind: row.kind,
  }
}

export type AuthRouteMarker = 'oauth-google' | 'oauth-microsoft'

export function isCliDeviceTokenDatabaseHookContext(context: unknown): boolean {
  return (
    !!context &&
    typeof context === 'object' &&
    (context as { path?: unknown }).path === '/device/token'
  )
}

function authRouteFromDatabaseHookContext(
  context: unknown,
): AuthRouteMarker | undefined {
  if (!context || typeof context !== 'object') return undefined
  const value = context as {
    path?: unknown
    params?: Record<string, unknown>
  }
  if (value.path !== '/callback/:id') return undefined
  if (value.params?.id === 'google') return 'oauth-google'
  if (value.params?.id === 'microsoft') return 'oauth-microsoft'
  return undefined
}

export type WorkspaceCreationPolicy = {
  selfUploadEnabled: boolean
  storageQuotaBytes: number
}

const DEFAULT_WORKSPACE_CREATION_POLICY: WorkspaceCreationPolicy = {
  selfUploadEnabled: true,
  storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.free,
}

export function workspaceCreationPolicyForAuthRoute(
  authRoute: AuthRouteMarker | undefined,
): WorkspaceCreationPolicy {
  if (authRoute === 'oauth-google' || authRoute === 'oauth-microsoft') {
    return DEFAULT_WORKSPACE_CREATION_POLICY
  }
  return { selfUploadEnabled: false, storageQuotaBytes: 0 }
}

function workspaceCreationValues(policy: WorkspaceCreationPolicy): {
  self_upload_enabled: number
  storage_quota_bytes: number
} {
  return {
    self_upload_enabled: policy.selfUploadEnabled ? 1 : 0,
    storage_quota_bytes: policy.storageQuotaBytes,
  }
}

export async function ensureWorkspace(
  db: Kysely<DB>,
  email: string,
  hd: string | null,
  microsoftTid: string | null = null,
  microsoftVerifiedDomain: string | null = null,
  _emailVerified = false,
  creation: WorkspaceCreationPolicy = DEFAULT_WORKSPACE_CREATION_POLICY,
  allowEmailDomainClaim = true,
): Promise<{ workspaceId: string; created: boolean }> {
  const provisioning = workspaceCreationValues(creation)
  const id = nanoid()
  const now = nowIso()
  const emailDomain = normalizeEmailDomain(email)
  const normalizedHd = normalizeEmailDomain(hd)
  const normalizedMicrosoftDomain = normalizeEmailDomain(
    microsoftVerifiedDomain,
  )
  const createsUploadEnabledWorkspace = creation.selfUploadEnabled

  if (
    createsUploadEnabledWorkspace &&
    normalizedHd &&
    !isPublicEmailDomain(normalizedHd)
  ) {
    const claimedWorkspaceId = await findWorkspaceIdByDomainClaim(
      db,
      normalizedHd,
    )
    if (claimedWorkspaceId)
      return { workspaceId: claimedWorkspaceId, created: false }

    const name = normalizedHd
    // ON CONFLICT (hd) DO NOTHING + RETURNING collapses the SELECT-then-INSERT
    // race for the same `hd` (two concurrent first sign-ins from the same
    // workspace would otherwise hit UNIQUE on workspaces.hd and surface as
    // 500). RETURNING is empty when the conflict path fires — fall back to
    // a SELECT to read the now-existing id.
    const inserted = await db
      .insertInto('workspaces')
      .values({
        id,
        hd: normalizedHd,
        name,
        created_at: now,
        email_domain: normalizedHd,
        ...provisioning,
      })
      .onConflict((oc) => oc.column('hd').doNothing())
      .returning('id')
      .executeTakeFirst()
    if (inserted) {
      const workspaceId = await ensureWorkspaceDomainClaim(db, {
        domain: normalizedHd,
        workspaceId: inserted.id,
        source: 'google_hd',
        now,
      })
      if (workspaceId !== inserted.id) {
        await db
          .deleteFrom('workspaces')
          .where('id', '=', inserted.id)
          .execute()
      }
      return { workspaceId, created: workspaceId === inserted.id }
    }
    const existing = await db
      .selectFrom('workspaces')
      .select('id')
      .where('hd', '=', normalizedHd)
      .executeTakeFirstOrThrow()
    const workspaceId = await ensureWorkspaceDomainClaim(db, {
      domain: normalizedHd,
      workspaceId: existing.id,
      source: 'google_hd',
      now,
    })
    return { workspaceId, created: false }
  }

  if (
    createsUploadEnabledWorkspace &&
    normalizedMicrosoftDomain &&
    !isPublicEmailDomain(normalizedMicrosoftDomain)
  ) {
    const workspaceId = await ensureDomainClaimWorkspace(db, {
      domain: normalizedMicrosoftDomain,
      source: 'microsoft_verified_domain',
      providerTenantId: microsoftTid,
      now,
      creation: provisioning,
    })
    // Microsoft verified-domain signup does not reach this path; keep false conservatively.
    if (workspaceId) return { workspaceId, created: false }
  }

  if (!microsoftTid && createsUploadEnabledWorkspace && allowEmailDomainClaim) {
    const claimedWorkspaceId = await findWorkspaceIdByDomainClaim(
      db,
      emailDomain,
    )
    if (claimedWorkspaceId) {
      return { workspaceId: claimedWorkspaceId, created: false }
    }
  }

  if (microsoftTid && createsUploadEnabledWorkspace) {
    const fallbackDomain = emailDomain ?? email.toLowerCase()
    const name = fallbackDomain
    const inserted = await db
      .insertInto('workspaces')
      .values({
        id,
        hd: null,
        ms_tenant_id: microsoftTid,
        name,
        created_at: now,
        email_domain: fallbackDomain,
        ...provisioning,
      })
      .onConflict((oc) => oc.column('ms_tenant_id').doNothing())
      .returning('id')
      .executeTakeFirst()
    if (inserted) return { workspaceId: inserted.id, created: true }
    const existing = await db
      .selectFrom('workspaces')
      .select('id')
      .where('ms_tenant_id', '=', microsoftTid)
      .executeTakeFirstOrThrow()
    return { workspaceId: existing.id, created: false }
  }

  const name = `${email}'s workspace`
  await db
    .insertInto('workspaces')
    .values({
      id,
      hd: null,
      name,
      created_at: now,
      ...provisioning,
    })
    .execute()
  return { workspaceId: id, created: true }
}

function decodeBase64UrlUtf8Json<T>(segment: string): T {
  return JSON.parse(UTF8_DECODER.decode(decodeBase64Url(segment))) as T
}

export function decodeMicrosoftIdTokenPayload(
  idToken: string,
): MicrosoftProfile {
  const payloadSegment = idToken.split('.')[1]
  if (!payloadSegment) {
    throw new Error('Invalid Microsoft ID token')
  }
  return decodeBase64UrlUtf8Json<MicrosoftProfile>(payloadSegment)
}

export function decodeGoogleIdTokenPayload(
  idToken: string,
): GoogleIdTokenPayload {
  const payloadSegment = idToken.split('.')[1]
  if (!payloadSegment) {
    throw new Error('Invalid Google ID token')
  }
  return decodeBase64UrlUtf8Json<GoogleIdTokenPayload>(payloadSegment)
}

export async function persistGoogleHostedDomainClaimForAccount(
  db: Kysely<DB>,
  input: { userId: string; idToken: string | null; now: string },
): Promise<string | null> {
  const user = await db
    .selectFrom('users')
    .select('email')
    .where('id', '=', input.userId)
    .executeTakeFirst()
  if (!user) return null
  return await resolveOAuthWorkspaceAfterAccountCreate(db, {
    providerId: 'google',
    userId: input.userId,
    idToken: input.idToken,
  })
}

export function mapMicrosoftProfileToUser(profile: MicrosoftProfile) {
  if (!profile.tid || !profile.oid) {
    throw new Error('Microsoft profile missing tid or oid')
  }
  const email = resolveMicrosoftEmail(profile)
  if (!email) {
    throw new Error('Microsoft profile missing email')
  }
  const emailVerified = resolveMicrosoftEmailVerified(profile, email)
  return {
    id: `${profile.tid}:${profile.oid}`,
    name:
      profile.name ??
      (`${profile.given_name ?? ''} ${profile.family_name ?? ''}`.trim() ||
        email),
    email,
    emailVerified,
    image: undefined,
  }
}

export async function getMicrosoftUserInfo(token: {
  idToken?: string | null
  accessToken?: string | null
}): Promise<{
  user: ReturnType<typeof mapMicrosoftProfileToUser>
  data: MicrosoftProfile
} | null> {
  if (!token.idToken) return null
  const profile = decodeMicrosoftIdTokenPayload(token.idToken)
  const user = mapMicrosoftProfileToUser(profile)
  const microsoftVerifiedDomain = user.emailVerified
    ? await resolveMicrosoftVerifiedEmailDomain({
        accessToken: token.accessToken ?? null,
        email: user.email,
      })
    : null
  if (microsoftVerifiedDomain) {
    await persistMicrosoftVerifiedDomainClaim({
      domain: microsoftVerifiedDomain,
      tenantId: profile.tid,
    })
  }
  return { user, data: profile }
}

function resolveMicrosoftEmail(profile: MicrosoftProfile): string | null {
  if (profile.email) return profile.email
  if (profile.verified_primary_email?.[0])
    return profile.verified_primary_email[0]
  if (profile.preferred_username?.includes('@'))
    return profile.preferred_username
  return null
}

function resolveMicrosoftEmailVerified(
  profile: MicrosoftProfile,
  resolvedEmail: string,
): boolean {
  if (profile.email_verified === true) return true
  if (profile.xms_edov === true) return true
  // The resolved email may land in either verified list; compare
  // case-insensitively (Microsoft can return mixed case across claims).
  const target = resolvedEmail.toLowerCase()
  const listed = (list: string[] | undefined) =>
    list?.some((entry) => entry.toLowerCase() === target) ?? false
  return (
    listed(profile.verified_primary_email) ||
    listed(profile.verified_secondary_email)
  )
}

async function resolveMicrosoftVerifiedEmailDomain(input: {
  accessToken: string | null
  email: string
}): Promise<string | null> {
  if (!input.accessToken) return null
  const emailDomain = normalizeEmailDomain(input.email)
  if (!emailDomain || isPublicEmailDomain(emailDomain)) return null

  let organization = await fetchMicrosoftOrganization(input.accessToken, true)
  if (!organization?.verifiedDomains) {
    organization = await fetchMicrosoftOrganization(input.accessToken, false)
  }
  const matchingDomain = organization?.verifiedDomains?.find((domain) => {
    const name = normalizeEmailDomain(domain.name)
    return name === emailDomain && domain.isInitial === false
  })
  return normalizeEmailDomain(matchingDomain?.name)
}

async function fetchMicrosoftOrganization(
  accessToken: string,
  selectVerifiedDomains: boolean,
): Promise<MicrosoftOrganization | null> {
  const url = selectVerifiedDomains
    ? 'https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains'
    : 'https://graph.microsoft.com/v1.0/organization'
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { value?: MicrosoftOrganization[] }
    return body.value?.[0] ?? null
  } catch {
    return null
  }
}

async function persistMicrosoftVerifiedDomainClaim(input: {
  domain: string
  tenantId: string
}) {
  if (!(env as { DB?: D1Database }).DB) return
  const db = createSessionDb()
  try {
    await ensureDomainClaimWorkspace(db, {
      domain: input.domain,
      source: 'microsoft_verified_domain',
      providerTenantId: input.tenantId,
      now: nowIso(),
    })
  } finally {
    await db.destroy()
  }
}

export type DevSignInPersona =
  | 'free-owner'
  | 'plus-owner'
  | 'team-owner'
  | 'team-member'

const DEV_SIGN_IN_CONFIG = {
  'free-owner': {
    email: 'dev-free-owner@artifactshare.local',
    name: 'Free owner',
    plan: 'free',
    workspace: 'Artifact Share Local Dev Free',
    role: 'owner',
  },
  'plus-owner': {
    email: 'dev-plus-owner@artifactshare.local',
    name: 'Plus owner',
    plan: 'plus',
    workspace: 'Artifact Share Local Dev Plus',
    role: 'owner',
  },
  'team-owner': {
    email: 'dev-team-owner@artifactshare.local',
    name: 'Team owner',
    plan: 'team',
    workspace: 'Artifact Share Local Dev Team',
    role: 'owner',
  },
  'team-member': {
    email: 'dev-team-member@artifactshare.local',
    name: 'Team member',
    plan: 'team',
    workspace: 'Artifact Share Local Dev Team',
    role: 'member',
  },
} as const

export const DEV_SIGN_IN_WORKSPACE_NAME = 'Artifact Share Local Dev Team'
export const DEV_SIGN_IN_ADMIN_EMAIL = DEV_SIGN_IN_CONFIG['team-owner'].email
export const DEV_SIGN_IN_MEMBER_EMAIL = DEV_SIGN_IN_CONFIG['team-member'].email

export async function ensureDevSignInUser(
  db: Kysely<DB>,
  persona: DevSignInPersona,
  scenario?: string,
): Promise<{
  userId: string
  workspaceId: string
  containerId: string | null
  containerKind: 'inbox' | 'project' | null
}> {
  if (!import.meta.env.DEV) {
    throw new Error('Dev sign-in is only available in Vite dev')
  }

  const now = nowIso()
  const config = DEV_SIGN_IN_CONFIG[persona]
  const workspaceOwnerEmail =
    config.plan === 'team'
      ? DEV_SIGN_IN_CONFIG['team-owner'].email
      : config.email
  const workspaceId = scenario
    ? (await ensureDevScreenState(db, scenario, now, config.plan)).workspaceId
    : await ensureDevSignInWorkspace(
        db,
        config.plan,
        config.workspace,
        workspaceOwnerEmail,
        now,
      )
  const userId = await ensureDevSignInUserRow(
    db,
    persona,
    workspaceId,
    now,
    scenario,
  )
  await ensureDevSignInWorkspaceRole(db, workspaceId, userId, config.role, now)
  if (config.role === 'member') {
    const owner = DEV_SIGN_IN_CONFIG['team-owner']
    const ownerId = await ensureDevSignInUserRow(
      db,
      'team-owner',
      workspaceId,
      now,
      scenario,
    )
    await ensureDevSignInWorkspaceRole(
      db,
      workspaceId,
      ownerId,
      owner.role,
      now,
    )
  }
  const seed = scenario
    ? await seedDevScreenState(db, scenario, workspaceId, userId, now)
    : { containerId: null, containerKind: null }
  return {
    userId,
    workspaceId,
    containerId: seed.containerId,
    containerKind: seed.containerKind,
  }
}

async function ensureDevSignInWorkspace(
  db: Kysely<DB>,
  plan: 'free' | 'plus' | 'team',
  name: string,
  ownerEmail: string,
  now: string,
): Promise<string> {
  const existingUser = await db
    .selectFrom('users')
    .select('workspace_id')
    .where('email', '=', ownerEmail.toLowerCase())
    .executeTakeFirst()
  if (existingUser) return existingUser.workspace_id
  const workspaceId = nanoid()
  const defaults = LINK_SHARING_PLAN_DEFAULTS[plan]
  await db
    .insertInto('workspaces')
    .values({
      id: workspaceId,
      hd: null,
      name,
      created_at: now,
      plan,
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES[plan],
      link_sharing_enabled: defaults.linkSharingEnabled ? 1 : 0,
      external_posting_enabled: defaults.externalPostingEnabled ? 1 : 0,
      link_expiry_default_days: defaults.linkExpiryDefaultDays,
      link_expiry_max_days: defaults.linkExpiryMaxDays,
    })
    .execute()
  return workspaceId
}

async function ensureDevSignInUserRow(
  db: Kysely<DB>,
  persona: DevSignInPersona,
  workspaceId: string,
  now: string,
  scenario?: string,
): Promise<string> {
  const config = DEV_SIGN_IN_CONFIG[persona]
  const email = (
    scenario ? devScreenUserEmail(persona, scenario) : config.email
  ).toLowerCase()
  const name = scenario ? `${config.name} · ${scenario}` : config.name
  const existing = await db
    .selectFrom('users')
    .select(['id', 'workspace_id'])
    .where('email', '=', email)
    .executeTakeFirst()

  if (existing) {
    if (existing.workspace_id !== workspaceId) {
      await db
        .updateTable('users')
        .set({ workspace_id: workspaceId, updated_at: now })
        .where('id', '=', existing.id)
        .execute()
    }
    await ensureActiveWorkspaceMembership(db, existing.id, workspaceId, now)
    return existing.id
  }

  const userId = nanoid()
  await db
    .insertInto('users')
    .values({
      id: userId,
      email,
      email_verified: 1,
      name,
      image: null,
      created_at: now,
      updated_at: now,
      workspace_id: workspaceId,
      locale: null,
    })
    .execute()
  await ensureActiveWorkspaceMembership(db, userId, workspaceId, now)
  return userId
}

async function ensureDevSignInWorkspaceRole(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  role: 'owner' | 'member',
  now: string,
): Promise<void> {
  if (role === 'member') {
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: workspaceId,
        user_id: userId,
        role,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(['workspace_id', 'user_id'])
          .doUpdateSet({ role, status: 'active', updated_at: now }),
      )
      .execute()
    return
  }
  const adminRow = await db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('role', '=', 'owner')
    .executeTakeFirst()

  if (!adminRow) {
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: workspaceId,
        user_id: userId,
        role: 'owner',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(['workspace_id', 'user_id'])
          .doUpdateSet({ role: 'owner', status: 'active', updated_at: now }),
      )
      .execute()
    return
  }

  if (adminRow.user_id === userId) return
  await db
    .updateTable('workspace_members')
    .set({ role: 'member', updated_at: now })
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', adminRow.user_id)
    .where('role', '=', 'owner')
    .execute()
  await db
    .updateTable('workspace_members')
    .set({ role: 'owner', updated_at: now })
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .execute()
}

function devSignInPlugin(db: Kysely<DB>): BetterAuthPlugin {
  const devSignIn = createAuthEndpoint(
    '/dev/sign-in',
    {
      method: 'POST',
      body: z.object({
        persona: z.enum([
          'free-owner',
          'plus-owner',
          'team-owner',
          'team-member',
        ]),
        scenario: z.string().optional(),
      }),
    },
    async (ctx) => {
      if (ctx.body.scenario && !isScreenScenario(ctx.body.scenario)) {
        throw new APIError('BAD_REQUEST', {
          message: 'Unknown screen scenario',
        })
      }
      const signIn = await ensureDevSignInUser(
        db,
        ctx.body.persona,
        ctx.body.scenario,
      )
      const user = await ctx.context.internalAdapter.findUserById(signIn.userId)
      if (!user) {
        throw new APIError('INTERNAL_SERVER_ERROR', {
          message: 'Dev user not found',
        })
      }
      // Dev sign-in is still a sign-in entry point: never mint a browser
      // session for a bot user.
      await assertBotSignInAllowedForUserId(db, signIn.userId)

      const session = await ctx.context.internalAdapter.createSession(
        signIn.userId,
      )
      if (!session) {
        throw new APIError('INTERNAL_SERVER_ERROR', {
          message: 'Failed to create session',
        })
      }

      await setSessionCookie(ctx, { session, user })
      return ctx.json({ ok: true as const, ...signIn })
    },
  )

  return {
    id: 'dev-sign-in',
    endpoints: { devSignIn },
  }
}

async function sendOtpEmail(to: string, otp: string): Promise<void> {
  // The OTP IS the login mechanism, so let a send failure throw rather than
  // swallow it. Note: better-auth invokes this via runInBackgroundOrAwait,
  // which awaits then logs-and-swallows the rejection and still returns success
  // to the client (anti-enumeration). So the throw surfaces only in the server
  // log, not on the sign-in screen; the user's recovery is the resend button.
  // Only the dev case (no EMAIL binding) returns silently.
  const email: SendEmail | undefined = env.EMAIL
  if (!email) return
  const subject = `ログインコード: ${otp} / Artifact Share sign-in code`
  const text = [
    `Artifact Share のログインコード: ${otp}`,
    'サインイン画面にこのコードを入力してください。10 分で期限切れになります。',
    '心当たりがない場合は、このメールを無視してください。',
    '',
    '---',
    '',
    `Your Artifact Share sign-in code: ${otp}`,
    'Enter this code on the sign-in screen. It expires in 10 minutes.',
    "If you didn't request this, you can ignore this email.",
  ].join('\n')
  await email.send({
    to,
    from: `noreply@${APEX_HOST}`,
    subject,
    text,
  })
}

// ── bot sign-in rejection ────────────────────────────────────

/**
 * 403 error used by every human auth entry point that detects a bot user or
 * the reserved bot email domain.
 */
export function botSignInRejectedError(): APIError {
  return new APIError('FORBIDDEN', {
    message: 'Bot accounts cannot sign in.',
    code: 'bot-sign-in-rejected',
  })
}

/**
 * Throws when the address sits under the reserved bot email domain or already
 * belongs to a bot user. Used by OTP send/verify and other email-first entry
 * points; the session/user create hooks remain the authoritative invariant.
 */
export async function assertBotSignInAllowedForEmail(
  db: Kysely<DB>,
  email: string,
): Promise<void> {
  if (isReservedBotEmailDomain(email)) throw botSignInRejectedError()
  const row = await db
    .selectFrom('users')
    .select('kind')
    .where(sql<boolean>`lower(email) = ${email.toLowerCase()}`)
    .executeTakeFirst()
  if (row?.kind === 'bot') throw botSignInRejectedError()
}

/** Throws when the user id resolves to a bot user. */
export async function assertBotSignInAllowedForUserId(
  db: Kysely<DB>,
  userId: unknown,
): Promise<void> {
  if (typeof userId !== 'string' || !userId) return
  const row = await db
    .selectFrom('users')
    .select('kind')
    .where('id', '=', userId)
    .executeTakeFirst()
  if (row?.kind === 'bot') throw botSignInRejectedError()
}
