import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { hashTokenForStorage } from "../auth/tokenSecurity";
import { getTestPrisma, setupTestDb } from "./testUtils";

const provider = vi.hoisted(() => ({
  groups: ["workspace-admins"] as string[],
  emailInIdToken: true,
}));

vi.mock("../auth/oidcClient", () => ({
  createOidcClientFactory: () => ({
    getOidcClient: async () => ({
      issuer: { issuer: "https://idp.example.test" },
      authorizationUrl: () => "https://idp.example.test/authorize",
      callbackParams: () => ({}),
      callback: async () => ({
        claims: () => ({
          sub: "oidc-user",
          ...(provider.emailInIdToken && { email: "oidc@example.test" }),
          email_verified: true,
          ...(provider.emailInIdToken && { groups: provider.groups }),
        }),
      }),
      userinfo: async () => ({
        email: "oidc@example.test",
        groups: ["workspace-admins"],
      }),
    }),
  }),
}));

describe("OIDC group-based admin roles", () => {
  let prisma: ReturnType<typeof getTestPrisma>;
  let app: Awaited<typeof import("../index")>["app"];
  let config: (typeof import("../config"))["config"];

  let cookies: typeof import("../auth/cookies");

  beforeAll(async () => {
    vi.stubEnv("AUTH_MODE", "hybrid");
    vi.stubEnv("OIDC_ISSUER_URL", "https://idp.example.test");
    vi.stubEnv("OIDC_CLIENT_ID", "excalidash");
    vi.stubEnv(
      "OIDC_REDIRECT_URI",
      "http://localhost:6767/api/auth/oidc/callback",
    );
    vi.stubEnv("OIDC_ADMIN_GROUPS", "workspace-admins");
    vi.stubEnv("OIDC_JIT_PROVISIONING", "true");
    vi.stubEnv("ENABLE_REFRESH_TOKEN_ROTATION", "true");
    setupTestDb();
    prisma = getTestPrisma();
    ({ config } = await import("../config"));
    cookies = await import("../auth/cookies");
    ({ app } = await import("../index"));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    vi.unstubAllEnvs();
  });

  const signIn = async () => {
    const browser = request.agent(app);
    await browser.get("/auth/oidc/start").expect(302);
    const response = await browser.get("/auth/oidc/callback").expect(302);
    expect(response.headers.location).toBe("/");
    return { browser, response };
  };

  const accessCookie = (response: request.Response) => {
    const values = response.headers["set-cookie"] as unknown as string[];
    return values
      .find((cookie) =>
        cookie.startsWith(`${cookies.ACCESS_TOKEN_COOKIE_NAME}=`),
      )!
      .split(";")[0];
  };

  it("applies fresh provider groups and never restores admin using a stale access token", async () => {
    const { browser, response } = await signIn();
    await browser.get("/auth/users").expect(200);
    const originalCookie = accessCookie(response);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: "oidc@example.test" },
    });
    const staleAccessToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        type: "access",
        authProvider: "oidc",
        oidcGroups: ["workspace-admins"],
      },
      config.jwtSecret,
    );

    provider.groups = [];
    const { browser: demoted } = await signIn();
    await demoted.get("/auth/users").expect(403);
    await request(app)
      .get("/auth/users")
      .set("Cookie", originalCookie)
      .expect(403);
    await request(app)
      .get("/auth/users")
      .set("Authorization", `Bearer ${staleAccessToken}`)
      .expect(403);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role,
    ).toBe("USER");

    provider.groups = ["workspace-admins"];
    provider.emailInIdToken = false;
    try {
      const { browser: unsignedGroups } = await signIn();
      await unsignedGroups.get("/auth/users").expect(403);
    } finally {
      provider.emailInIdToken = true;
    }
    const { browser: promoted } = await signIn();
    await promoted.get("/auth/users").expect(200);
  });

  it.each([
    ["oidc", 401],
    [undefined, 401],
    ["local", 200],
  ] as const)(
    "refreshes a %s session with status %s under OIDC group mapping",
    async (authProvider, status) => {
      await signIn();
      const browser = request.agent(app);
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: "oidc@example.test" },
      });
      const token = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          type: "refresh",
          authProvider,
          oidcGroups: ["workspace-admins"],
        },
        config.jwtSecret,
      );
      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          token: hashTokenForStorage(token),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const csrf = await browser.get("/csrf-token").expect(200);
      const res = await browser
        .post("/auth/refresh")
        .set("Cookie", `${cookies.REFRESH_TOKEN_COOKIE_NAME}=${token}`)
        .set(csrf.body.header, csrf.body.token)
        .expect(status);
      if (status === 401) {
        expect(res.body.message).toBe(
          "Sign in again with your identity provider",
        );
      } else {
        expect(jwt.decode(accessCookie(res).split("=")[1])).not.toHaveProperty(
          "oidcGroups",
        );
      }
    },
  );
});
