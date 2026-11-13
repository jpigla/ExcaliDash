import type { Request } from "express";
import { parseCookieHeader } from "../auth/cookies";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";

const sessionAudience = "excalidash:guest-link";
const maxSessionMs = 30 * 24 * 60 * 60 * 1000;

const sessionClaims = z.object({
  shareId: z.string().min(1),
  drawingId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});

export type GuestPrincipal = {
  kind: "guest";
  shareId: string;
  drawingId: string;
  revision: number;
  expiresAt: number;
};

const deriveKey = (secret: string, purpose: string): Buffer =>
  crypto.createHmac("sha256", secret).update(purpose).digest();

export const encryptGuestLinkToken = (
  token: string,
  secret: string,
): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    deriveKey(secret, "guest-link-encryption"),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
};

export const decryptGuestLinkToken = (
  encrypted: string,
  secret: string,
): string => {
  const data = Buffer.from(encrypted, "base64url");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret, "guest-link-encryption"),
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([
    decipher.update(data.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
};

export const isValidGuestPassphrase = (value: string): boolean =>
  value.trim().length >= 8 &&
  Buffer.byteLength(value, "utf8") <= 72 &&
  !value.includes("\0");

export const hashGuestPassphrase = (passphrase: string): Promise<string> =>
  bcrypt.hash(passphrase, 12);

export const verifyGuestPassphrase = (
  passphrase: string,
  hash: string,
): Promise<boolean> =>
  isValidGuestPassphrase(passphrase)
    ? bcrypt.compare(passphrase, hash)
    : Promise.resolve(false);

export const issueGuestSession = (
  share: {
    id: string;
    drawingId: string;
    revision: number;
    expiresAt: Date | null;
  },
  secret: string,
) => {
  const expiryMs = Math.min(
    Date.now() + maxSessionMs,
    share.expiresAt?.getTime() ?? Infinity,
  );
  const exp = Math.ceil(expiryMs / 1000);
  const session = jwt.sign(
    {
      shareId: share.id,
      drawingId: share.drawingId,
      revision: share.revision,
      exp,
      expiresAt: expiryMs,
    },
    deriveKey(secret, "guest-link-cookie-session"),
    { algorithm: "HS256", audience: sessionAudience },
  );
  return { session, expiresAt: new Date(expiryMs).toISOString() };
};

export const readGuestSession = (
  token: unknown,
  secret: string,
): GuestPrincipal | null => {
  if (typeof token !== "string" || token.length > 2048) return null;
  try {
    const claims = sessionClaims.parse(
      jwt.verify(token, deriveKey(secret, "guest-link-cookie-session"), {
        algorithms: ["HS256"],
        audience: sessionAudience,
      }),
    );
    if (claims.expiresAt <= Date.now()) return null;
    return {
      kind: "guest",
      shareId: claims.shareId,
      drawingId: claims.drawingId,
      revision: claims.revision,
      expiresAt: claims.expiresAt,
    };
  } catch {
    return null;
  }
};

const shareIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export const guestSessionCookieName = (shareId: string): string =>
  `excalidash-guest-${shareId}`;

export const getGuestPrincipalFromCookieHeader = (
  cookieHeader: string | undefined,
  shareId: unknown,
  secret: string,
): GuestPrincipal | null => {
  if (typeof shareId !== "string" || !shareIdPattern.test(shareId)) return null;
  const cookie =
    parseCookieHeader(cookieHeader)[guestSessionCookieName(shareId)];
  const principal = readGuestSession(cookie, secret);
  return principal?.shareId === shareId ? principal : null;
};

export const isGuestRequest = (req: Request): boolean =>
  req.headers["x-guest-share"] !== undefined ||
  /^Guest(?:\s|$)/i.test(req.headers.authorization ?? "");

export const readGuestRequest = (
  req: Request,
  secret: string,
): GuestPrincipal | null =>
  getGuestPrincipalFromCookieHeader(
    req.headers.cookie,
    req.headers["x-guest-share"],
    secret,
  );
