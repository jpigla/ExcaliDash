import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const httpsUrl = z.url({ protocol: /^https$/ }).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash && !url.search;
});
const resourceUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    !url.search &&
    url.pathname === "/api/mcp" &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
});
const expires = z.iso.datetime({ offset: true });
const grant = z.strictObject({
  boardId: id,
  mode: z.enum(["read", "edit"]),
  frameId: id.optional(),
  expiresAt: expires.optional(),
});
const agent = z.strictObject({
  id,
  userId: id,
  credential: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("token"), sha256: digest }),
    z.strictObject({
      type: z.literal("oauth"),
      subject: z.string().min(1).max(512),
      clientId: z.string().min(1).max(512),
    }),
  ]),
  expiresAt: expires,
  draftCollectionId: id.optional(),
  managedByUserId: id.optional(),
  boards: z.array(grant).max(200).default([]),
  readCollections: z.array(id).max(100).default([]),
  approvedChanges: z
    .array(z.strictObject({ digest, expiresAt: expires }))
    .max(100)
    .default([]),
});

const schema = z
  .strictObject({
    resource: resourceUrl,
    oauth: z
      .strictObject({
        issuer: httpsUrl,
        jwksUri: httpsUrl,
      })
      .optional(),
    agents: z.array(agent).max(100),
  })
  .superRefine((policy, ctx) => {
    const identities = new Set<string>();
    const credentials = new Set<string>();
    const managers = new Set<string>();
    for (const entry of policy.agents) {
      const credential = JSON.stringify(entry.credential);
      if (identities.has(entry.id) || credentials.has(credential)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate agent ID or credential",
        });
      }
      identities.add(entry.id);
      credentials.add(credential);
      if (entry.managedByUserId) {
        if (
          entry.managedByUserId === entry.userId ||
          managers.has(entry.managedByUserId) ||
          entry.boards.length ||
          entry.readCollections.length
        ) {
          ctx.addIssue({
            code: "custom",
            message:
              "Managed MCP access requires one separate agent per owner and no static board grants",
          });
        }
        managers.add(entry.managedByUserId);
      }
      if (entry.credential.type === "oauth" && !policy.oauth) {
        ctx.addIssue({
          code: "custom",
          message: "OAuth agent requires OAuth configuration",
        });
      }
    }
  });

export type Policy = z.infer<typeof schema>;
export type Agent = z.infer<typeof agent>;
export function managedGrantScope(agent: Agent, ownerId: string) {
  return { agentId: agent.id, agentUserId: agent.userId, ownerId };
}
export const oauthScope = "excalidash:mcp";
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const active = (expiry?: string) =>
  expiry === undefined || Date.parse(expiry) > Date.now();

export function createPolicyLoader(path: string) {
  return async () => {
    // Atomic replacement allows granting and revoking access without a restart.
    const raw = await readFile(path);
    if (raw.byteLength > 256 * 1024) throw new Error("MCP policy is too large");
    return schema.parse(JSON.parse(raw.toString("utf8")));
  };
}

export function createAuthenticator() {
  let jwksUrl: string | undefined;
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  return async (policy: Policy, header?: string) => {
    const token = header?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/i)?.[1];
    if (!token) return undefined;
    if (token.startsWith("exdm_")) {
      if (!/^exdm_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      const hash = Buffer.from(sha256(token), "hex");
      return policy.agents.find(
        ({ credential, expiresAt }) =>
          credential.type === "token" &&
          active(expiresAt) &&
          timingSafeEqual(hash, Buffer.from(credential.sha256, "hex")),
      );
    }
    if (!policy.oauth) return undefined;
    if (!jwks || jwksUrl !== policy.oauth.jwksUri) {
      jwksUrl = policy.oauth.jwksUri;
      jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 3000 });
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: policy.oauth.issuer,
        audience: policy.resource,
        requiredClaims: ["exp", "sub", "iat"],
        maxTokenAge: "1h",
        algorithms: ["RS256", "ES256", "EdDSA"],
      });
      if (
        typeof payload.scope !== "string" ||
        !payload.scope.split(/\s+/).includes(oauthScope)
      )
        return undefined;
      if (payload.azp && payload.client_id && payload.azp !== payload.client_id)
        return undefined;
      const clientId = payload.client_id ?? payload.azp;
      return policy.agents.find(
        ({ credential, expiresAt }) =>
          credential.type === "oauth" &&
          active(expiresAt) &&
          credential.subject === payload.sub &&
          credential.clientId === clientId,
      );
    } catch {
      return undefined;
    }
  };
}
