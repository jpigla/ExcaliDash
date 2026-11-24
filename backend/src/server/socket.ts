import { Server } from "socket.io";
import { getGuestPrincipalFromCookieHeader } from "../authz/guestLinkSecurity";
import { scopeGuestScene } from "../routes/dashboard/drawingGuestResponse";
import { createGuestSocketPacketGuard } from "./guestSocketEvents";
import { PrismaClient } from "../generated/client";
import { AuthModeService } from "../auth/authMode";
import { ACCESS_TOKEN_COOKIE_NAME, parseCookieHeader } from "../auth/cookies";
import { BOOTSTRAP_USER_ID } from "../auth/authMode";
import {
  getDrawingAccess,
  getDrawingAccessDetails,
  canEditDrawing,
  canViewDrawing,
} from "../authz/sharing";
import {
  disconnectInvalidApiKey,
  pruneExpiredRoomSockets,
  removeSocketFromRooms,
  revalidateRoomSockets,
  type PresenceUser,
  type RevalidatableSocket,
  type SocketState,
} from "./socketAccess";
import { isSceneBounds } from "./sceneBounds";
import { createSocketAuthResolver, revalidateSocketApiKey } from "./socketAuth";

const ROOM_ACCESS_TTL_MS = 2_000;

type RegisterSocketHandlersDeps = {
  io: Server;
  prisma: PrismaClient;
  authModeService: AuthModeService;
  jwtSecret: string;
  isAllowedOrigin: (origin: string | undefined) => boolean;
};

export type SocketHandlers = {
  // Re-check access for every socket currently in a drawing's room; used by the
  // sharing routes to kick collaborators the moment their access is revoked.
  revalidateDrawingAccess: (drawingId: string) => Promise<void>;
  emitDrawingScene: (
    drawingId: string,
    payload: unknown,
    senderId?: string,
  ) => Promise<void>;
  emitDrawingServerUpdate: (drawingId: string) => Promise<void>;
  revalidateCollectionAccess: (collectionId: string) => Promise<void>;
  disconnectRevokedApiKey: (apiKeyId: string) => void;
};

export const registerSocketHandlers = ({
  io,
  prisma,
  authModeService,
  jwtSecret,
  isAllowedOrigin,
}: RegisterSocketHandlersDeps): SocketHandlers => {
  const roomUsers = new Map<string, PresenceUser[]>();
  const roomChecks = new Map<
    string,
    { until: number; pending?: Promise<void> }
  >();

  const getState = (socket: { data: unknown }): SocketState => {
    const data = socket.data as Partial<SocketState>;
    if (!data.access) data.access = new Map();
    if (!data.joinedRooms) data.joinedRooms = new Set();
    if (data.principal === undefined) data.principal = null;
    if (data.apiKeyScopes === undefined) data.apiKeyScopes = null;
    if (data.apiKeyId === undefined) data.apiKeyId = null;
    return data as SocketState;
  };

  const toPresenceName = (value: unknown): string => {
    if (typeof value !== "string") return "User";
    const trimmed = value.trim().slice(0, 120);
    return trimmed.length > 0 ? trimmed : "User";
  };

  const toPresenceInitials = (name: string): string => {
    // Keep consistent with frontend `getInitialsFromName`.
    const trimmed = name.trim();
    if (!trimmed) return "U";
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
  };

  const toPresenceColor = (value: unknown): string => {
    if (typeof value !== "string") return "#4f46e5";
    const trimmed = value.trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
      return trimmed;
    }
    return "#4f46e5";
  };

  const resolveSocketAuth = createSocketAuthResolver({
    prisma,
    authModeService,
    jwtSecret,
  });

  const socketsForDrawing = (drawingId: string, guestsOnly: boolean) => {
    const roomId = `drawing_${drawingId}`;
    return [...(io.sockets.adapter.rooms.get(roomId) ?? [])]
      .map((id) => io.sockets.sockets.get(id))
      .filter(
        (socket) =>
          socket &&
          (!guestsOnly || getState(socket).principal?.kind === "guest"),
      );
  };

  const emitPresence = (roomId: string): void => {
    const drawingId = roomId.slice("drawing_".length);
    pruneExpiredRoomSockets(drawingId, roomUsers, getRoomSockets(roomId));
    const users = roomUsers.get(roomId);
    if (!users) roomChecks.delete(drawingId);
    const presence = users ?? [];
    const guestIds = socketsForDrawing(
      roomId.slice("drawing_".length),
      true,
    ).flatMap((socket) => (socket ? [socket.id] : []));
    if (!guestIds.length) {
      io.to(roomId).emit("presence-update", presence);
      return;
    }
    io.to(roomId).except(guestIds).emit("presence-update", presence);
    io.to(guestIds).emit(
      "presence-update",
      presence.map(({ avatarVersion: _avatarVersion, ...user }) => user),
    );
  };

  const emitDrawingScene = async (
    drawingId: string,
    payload: unknown,
    senderId?: string,
  ): Promise<void> => {
    const roomId = `drawing_${drawingId}`;
    const guests = socketsForDrawing(drawingId, true);
    const sender = senderId ? io.sockets.sockets.get(senderId) : undefined;
    const guestSender = sender && getState(sender).principal?.kind === "guest";
    let guestPayload = payload;
    if (guests.length && payload && typeof payload === "object") {
      const scene = payload as {
        elements?: unknown;
        files?: Record<string, unknown>;
        persisted?: boolean;
        appState?: unknown;
      };
      const { appState: _appState, ...guestScene } = scene;
      if (scene.persisted === true) {
        const storedFiles = await prisma.drawingFile.findMany({
          where: { drawingId },
          select: { fileId: true },
        });
        guestPayload = {
          ...guestScene,
          ...scopeGuestScene(
            drawingId,
            scene.elements,
            scene.files ?? {},
            storedFiles,
          ),
        };
      } else {
        const scoped = scopeGuestScene(
          drawingId,
          scene.elements,
          guestSender ? (scene.files ?? {}) : {},
          [],
        );
        guestPayload = { ...guestScene, ...scoped };
      }
    }
    // Send only to guests in the checked snapshot. A socket joining while the
    // DB checks are pending receives the saved scene on its next HTTP catchup.
    if (guests.length) await revalidateDrawingAccess(drawingId);
    // A write may be revoked while the recipient checks are in flight.
    if (guestSender && sender) {
      const principal = getState(sender).principal;
      if (
        !canEditDrawing(
          await getDrawingAccess({ prisma, principal, drawingId }),
        )
      )
        return;
    }
    if (senderId && !io.sockets.sockets.has(senderId)) return;
    for (const guest of guests) {
      if (guest.id !== senderId && guest.connected && guest.rooms.has(roomId)) {
        guest.emit("element-update", guestPayload);
      }
    }
    // Resolve guest membership at emit time so a new join cannot receive
    // the unscoped account payload containing storage URLs.
    const exclude = socketsForDrawing(drawingId, true).map(
      (socket) => socket.id,
    );
    if (senderId) exclude.push(senderId);
    io.to(roomId).except(exclude).emit("element-update", payload);
  };

  io.use(async (socket, next) => {
    try {
      const state = getState(socket);
      if (Object.hasOwn(socket.handshake.auth, "guestShareId")) {
        if (!isAllowedOrigin(socket.handshake.headers.origin)) {
          return next(new Error("Authentication failed"));
        }
        const guest = getGuestPrincipalFromCookieHeader(
          socket.handshake.headers.cookie,
          socket.handshake.auth.guestShareId,
          jwtSecret,
        );
        if (
          !guest ||
          !canViewDrawing(
            await getDrawingAccess({
              prisma,
              principal: guest,
              drawingId: guest.drawingId,
            }),
          )
        ) {
          return next(new Error("GUEST_ACCESS_ENDED"));
        }
        state.principal = guest;
        return next();
      }

      if (Object.hasOwn(socket.handshake.auth, "guestSession")) {
        return next(new Error("GUEST_ACCESS_ENDED"));
      }
      const rawAuthToken: unknown = socket.handshake.auth?.token;
      const tokenFromAuth =
        typeof rawAuthToken === "string" && rawAuthToken.length > 0
          ? rawAuthToken
          : undefined;
      const tokenFromCookie = (() => {
        const cookies = parseCookieHeader(socket.handshake.headers.cookie);
        const value = cookies[ACCESS_TOKEN_COOKIE_NAME];
        return typeof value === "string" && value.trim().length > 0
          ? value
          : undefined;
      })();
      // API keys are only honoured when sent explicitly in the handshake auth
      // payload (never from the query string or a cookie), matching REST,
      // where they are only accepted as a Bearer header.
      const auth = tokenFromAuth
        ? await resolveSocketAuth(tokenFromAuth)
        : await resolveSocketAuth(tokenFromCookie, { allowApiKey: false });

      if (auth) {
        state.principal = {
          kind: "user",
          userId: auth.userId,
          instanceAdmin: auth.instanceAdmin,
        };
        state.apiKeyScopes = auth.apiKeyScopes;
        state.apiKeyId = auth.apiKeyId;
        return next();
      }

      return next(new Error("Authentication required"));
    } catch {
      next(new Error("Authentication failed"));
    }
  });

  const getRoomSockets = (roomId: string): RevalidatableSocket[] => {
    const sockets: RevalidatableSocket[] = [];
    for (const socketId of io.sockets.adapter.rooms.get(roomId) ?? []) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) sockets.push(socket);
    }
    return sockets;
  };

  const checkRoomAccess = async (
    drawingId: string,
    fresh: boolean,
  ): Promise<void> => {
    const roomId = `drawing_${drawingId}`;
    for (;;) {
      if (!io.sockets.adapter.rooms.get(roomId)?.size) {
        roomChecks.delete(drawingId);
        return;
      }

      let check = roomChecks.get(drawingId);
      if (!check?.pending && (fresh || !check || check.until <= Date.now())) {
        const next = {
          until: 0,
          pending: undefined as Promise<void> | undefined,
        };
        roomChecks.set(drawingId, next);
        next.pending = revalidateRoomSockets({
          prisma,
          drawingId,
          roomUsers,
          sockets: getRoomSockets(roomId),
          isCurrent: () => roomChecks.get(drawingId) === next,
          emitPresence,
        })
          .then(() => {
            next.until = Date.now() + ROOM_ACCESS_TTL_MS;
          })
          .finally(() => {
            next.pending = undefined;
          });
        check = next;
      }

      if (check?.pending) await check.pending;
      if (roomChecks.get(drawingId) !== check) {
        fresh = false;
        continue;
      }
      if (
        pruneExpiredRoomSockets(drawingId, roomUsers, getRoomSockets(roomId))
      ) {
        emitPresence(roomId);
      }
      return;
    }
  };

  const revalidateDrawingAccess = (drawingId: string): Promise<void> => {
    roomChecks.delete(drawingId);
    return checkRoomAccess(drawingId, true);
  };

  const revalidateCollectionAccess = async (
    collectionId: string,
  ): Promise<void> => {
    roomChecks.clear();
    const drawingIds = [...roomUsers.keys()].map((roomId) =>
      roomId.slice("drawing_".length),
    );
    if (!drawingIds.length) return;
    const drawings = await prisma.drawing.findMany({
      where: { id: { in: drawingIds }, collectionId },
      select: { id: true },
    });
    await Promise.all(drawings.map(({ id }) => revalidateDrawingAccess(id)));
  };

  const disconnectRevokedApiKey = (apiKeyId: string): void => {
    const changedRooms = new Set<string>();
    for (const socket of io.sockets.sockets.values()) {
      const state = getState(socket);
      if (state.apiKeyId !== apiKeyId) continue;
      for (const roomId of state.joinedRooms) {
        roomChecks.delete(roomId.slice("drawing_".length));
      }
      for (const roomId of disconnectInvalidApiKey(socket, roomUsers)) {
        changedRooms.add(roomId);
      }
    }
    for (const roomId of changedRooms) emitPresence(roomId);
  };

  io.on("connection", (socket) => {
    const state = getState(socket);
    const principal = state.principal;

    if (principal?.kind === "guest") {
      const guard = createGuestSocketPacketGuard(principal.drawingId);
      socket.use((packet, next) => {
        const validated = guard(packet);
        // Dropped packets are not dispatched. A later valid update or the
        // existing HTTP snapshot path can still synchronize the scene.
        if (!validated) return;
        packet.splice(0, packet.length, ...validated);
        next();
      });
    }
    let guestExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleGuestExpiry = (expiresAt: number) => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        socket.emit("error", {
          code: "GUEST_ACCESS_ENDED",
          message: "Your guest access to this drawing has ended",
        });
        socket.disconnect(true);
        return;
      }
      // Node timers accept at most 2^31-1 ms; a guest session can last longer.
      guestExpiryTimer = setTimeout(
        () => scheduleGuestExpiry(expiresAt),
        Math.min(remaining, 2_147_483_647),
      ).unref();
    };

    const getRoomAccess = async (drawingId: string, fresh = false) => {
      if (!state.joinedRooms.has(`drawing_${drawingId}`)) return;
      try {
        await checkRoomAccess(drawingId, fresh || principal?.kind === "guest");
        return state.access.get(drawingId)?.access;
      } catch (error) {
        console.error("Failed to revalidate live drawing access:", error);
      }
    };

    socket.on(
      "join-room",
      async (
        data: {
          drawingId?: unknown;
          user?: Partial<PresenceUser>;
        } | null,
        ack?: (payload: {
          user: Omit<PresenceUser, "socketId" | "isActive">;
        }) => void,
      ) => {
        try {
          const drawingId = data?.drawingId;
          if (typeof drawingId !== "string") return;
          const user = data?.user;
          if (state.apiKeyId) {
            const scopes = await revalidateSocketApiKey(prisma, state.apiKeyId);
            if (!scopes) {
              for (const roomId of disconnectInvalidApiKey(socket, roomUsers)) {
                emitPresence(roomId);
              }
              return;
            }
            state.apiKeyScopes = scopes;
          }
          let trustedUserId =
            typeof user?.id === "string" && user.id.trim().length > 0
              ? user.id.trim().slice(0, 200)
              : socket.id;
          let trustedName = toPresenceName(user?.name);
          let avatarVersion: string | undefined;

          if (!principal) {
            // Never trust client-provided ids for anonymous/share-link sessions; prevent spoofing/collisions.
            trustedUserId = `anon:${socket.id}`.slice(0, 200);
          } else if (
            principal?.kind === "user" &&
            principal.userId !== BOOTSTRAP_USER_ID
          ) {
            const account = await prisma.user.findUnique({
              where: { id: principal.userId },
              select: {
                id: true,
                name: true,
                avatar: { select: { version: true } },
              },
            });
            if (account) {
              trustedUserId = account.id;
              trustedName = toPresenceName(account.name);
              avatarVersion = account.avatar?.version;
            } else {
              // Lookup failed mid-session: fall back to a server-derived id
              // rather than echoing the client-supplied one.
              trustedUserId = `anon:${socket.id}`.slice(0, 200);
            }
          } else {
            // Bootstrap (auth disabled) sessions are server-derived too.
            trustedUserId = `anon:${socket.id}`.slice(0, 200);
          }

          const details = await getDrawingAccessDetails({
            prisma,
            principal,
            drawingId,
          });
          if (!canViewDrawing(details.access)) {
            socket.emit("error", {
              message: "You do not have access to this drawing",
            });
            return;
          }
          if (socket.disconnected) return;
          const roomId = `drawing_${drawingId}`;
          socket.join(roomId);
          state.joinedRooms.add(roomId);
          state.access.set(drawingId, details);

          const newUser: PresenceUser = {
            id: trustedUserId,
            name: trustedName,
            initials: toPresenceInitials(trustedName),
            color: toPresenceColor(user?.color),
            socketId: socket.id,
            isActive: true,
            avatarVersion,
          };

          // Presence is keyed per-SOCKET, not per-user id: two tabs of the
          // same account are two independent participants. Filtering by id
          // here would orphan the first tab's socket inside the room — its
          // events silently dropped and its disconnect never announced.
          const currentUsers = roomUsers.get(roomId) || [];
          const filteredUsers = currentUsers.filter(
            (u) => u.socketId !== socket.id,
          );
          filteredUsers.push(newUser);
          roomUsers.set(roomId, filteredUsers);

          await revalidateDrawingAccess(drawingId);
          if (!state.joinedRooms.has(roomId)) return;
          emitPresence(roomId);
          if (!state.joinedRooms.has(roomId)) return;
          // Let the client know what the server will use as its canonical presence identity.
          if (typeof ack === "function") {
            ack({
              user: {
                id: newUser.id,
                name: newUser.name,
                initials: newUser.initials,
                color: newUser.color,
              },
            });
          }
        } catch (err) {
          console.error("Error in join-room handler:", err);
          socket.emit("error", { message: "Failed to join room" });
        }
      },
    );

    socket.on("cursor-move", async (data) => {
      const drawingId =
        typeof data?.drawingId === "string" ? data.drawingId : null;
      if (!drawingId || !(await getRoomAccess(drawingId))) return;
      const roomId = `drawing_${drawingId}`;
      // Don't trust client-provided identity fields; use the server-side presence user.
      const users = roomUsers.get(roomId) || [];
      const self = users.find((u) => u.socketId === socket.id);
      if (!self) return;
      socket.volatile.to(roomId).emit("cursor-move", {
        ...data,
        drawingId,
        userId: self.id,
        username: self.name,
        color: self.color,
      });
    });

    socket.on("visible-bounds", async (data) => {
      const drawingId =
        typeof data?.drawingId === "string" ? data.drawingId : null;
      if (!drawingId || !isSceneBounds(data?.bounds)) return;
      if (!(await getRoomAccess(drawingId))) return;
      const roomId = `drawing_${drawingId}`;
      const users = roomUsers.get(roomId) || [];
      const self = users.find((u) => u.socketId === socket.id);
      if (!self) return;
      // Everyone in the room gets every viewport; whether to follow one is
      // decided client-side, so the server keeps no follower state.
      socket.volatile.to(roomId).emit("visible-bounds", {
        drawingId,
        userId: self.id,
        bounds: data.bounds,
        // Only an id present in this drawing; clients ignore others anyway.
        following: users.some((u) => u.id === data.following)
          ? data.following
          : null,
      });
    });

    socket.on("element-update", async (data) => {
      const drawingId =
        typeof data?.drawingId === "string" ? data.drawingId : null;
      if (!drawingId) return;
      const joinedAccess = await getRoomAccess(drawingId, true);
      if (!joinedAccess) return;
      if (!canEditDrawing(joinedAccess)) {
        socket.emit("error", {
          message: "Read-only access: cannot edit this drawing",
        });
        return;
      }
      if (
        state.apiKeyScopes &&
        !state.apiKeyScopes.includes("drawings:write")
      ) {
        socket.emit("error", {
          message: "API key is not authorized to edit drawings",
        });
        return;
      }

      const roomId = `drawing_${drawingId}`;
      const self = roomUsers
        .get(roomId)
        ?.find((user) => user.socketId === socket.id);
      if (!self) return;
      try {
        await emitDrawingScene(
          drawingId,
          {
            drawingId,
            elements: data.elements,
            files: data.files,
            elementOrder: data.elementOrder,
            userId: self.id,
          },
          socket.id,
        );
      } catch (error) {
        console.error("Failed to broadcast drawing update:", error);
      }
    });

    socket.on(
      "user-activity",
      async ({
        drawingId,
        isActive,
      }: {
        drawingId: string;
        isActive: boolean;
      }) => {
        if (
          typeof drawingId !== "string" ||
          !(await getRoomAccess(drawingId, true))
        ) {
          return;
        }
        const roomId = `drawing_${drawingId}`;
        const users = roomUsers.get(roomId);
        if (users) {
          const user = users.find((u) => u.socketId === socket.id);
          if (user) {
            user.isActive = isActive;
            emitPresence(roomId);
          }
        }
      },
    );

    socket.on("disconnect", () => {
      clearTimeout(guestExpiryTimer);
      // Only scan the rooms this socket actually joined instead of every room.
      const changed = removeSocketFromRooms(
        roomUsers,
        [...state.joinedRooms],
        socket.id,
      );
      for (const roomId of changed) {
        emitPresence(roomId);
      }
      state.joinedRooms.clear();
      state.access.clear();
    });
    if (principal?.kind === "guest") scheduleGuestExpiry(principal.expiresAt);
  });

  return {
    revalidateDrawingAccess,
    emitDrawingScene,
    emitDrawingServerUpdate: async (drawingId) => {
      await revalidateDrawingAccess(drawingId);
      io.to(`drawing_${drawingId}`).emit("drawing-server-update", {
        drawingId,
      });
    },
    revalidateCollectionAccess,
    disconnectRevokedApiKey,
  };
};
