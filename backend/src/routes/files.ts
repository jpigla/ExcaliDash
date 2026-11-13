/**
 * File routes:
 *   GET  /files/config                    – report whether S3 is configured
 *   PUT  /drawings/:drawingId/files/:fileId – upload raw image bytes (edit access)
 *   GET  /files/:drawingId/:fileId        – serve an image:
 *                                            db-mode → stream bytes (ETag/304)
 *                                            s3-mode → 302 to a presigned URL
 */
import express from "express";
import { PrismaClient, type Prisma } from "../generated/client";
import { pipeline } from "node:stream/promises";
import {
  isS3Enabled,
  generatePresignedDownloadUrl,
  uploadBuffer,
  buildS3Key,
  downloadDrawingFileStream,
} from "../s3";
import {
  MIME_TO_EXT,
  cleanupUnusedS3Upload,
  isGuestImageType,
} from "../fileProcessing";
import { randomUUID } from "node:crypto";
import {
  hasDrawingFileContent,
  storeDrawingFileOnce,
} from "../drawingFileStore";
import { config } from "../config";
import {
  canViewDrawing,
  canEditDrawing,
  getDrawingAccess,
  type DrawingPrincipal,
} from "../authz/sharing";
import { isGuestRequest, readGuestRequest } from "../authz/guestLinkSecurity";
import {
  admitGuestUpload,
  checkGuestUploadQuota,
  guestUploadMetadata,
  GuestUploadLimitError,
  discardGuestS3Upload,
} from "../guestUploadPolicy";
import { guestAccessEnded } from "./dashboard/drawingGuestLock";
import { guestSceneFileIds } from "./dashboard/drawingGuestResponse";
import { lockDrawingForGuestAccess } from "./dashboard/drawingGuestLock";

const DOWNLOAD_EXPIRES_IN = 3600; // 1 hour   – cached by browser

/** Loose guard: drawingId / fileId must be safe, path-traversal-free identifiers. */
const isValidIdSegment = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,200}$/.test(value);

export type FileRouteDeps = {
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
  optionalAuth: express.RequestHandler;
  asyncHandler: <T = void>(
    fn: (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => Promise<T>,
  ) => express.RequestHandler;
};

export const registerFileRoutes = (
  app: express.Express,
  deps: FileRouteDeps,
): void => {
  const { prisma, requireAuth, optionalAuth, asyncHandler } = deps;
  const getPrincipal = (req: express.Request): DrawingPrincipal | null => {
    if (isGuestRequest(req)) {
      return readGuestRequest(req, config.jwtSecret);
    }
    return req.user?.id ? { kind: "user", userId: req.user.id } : null;
  };

  const authenticateFileRequest =
    (accountAuth: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => {
      if (isGuestRequest(req)) {
        res.setHeader("Cache-Control", "no-store");
        return next();
      }
      return accountAuth(req, res, next);
    };

  const checkUploadAccess = asyncHandler(async (req, res, next) => {
    const { drawingId, fileId } = req.params;
    if (!isValidIdSegment(drawingId) || !isValidIdSegment(fileId)) {
      return res.status(400).json({ error: "Invalid id segment" });
    }

    const principal = getPrincipal(req);
    if (
      !canEditDrawing(await getDrawingAccess({ prisma, principal, drawingId }))
    ) {
      return res.status(404).json({ error: "Drawing not found" });
    }
    if (principal?.kind === "guest") {
      try {
        await admitGuestUpload(prisma, principal);
      } catch (error) {
        if (error instanceof GuestUploadLimitError) {
          return res
            .status(error.status)
            .json({ error: error.message, code: error.code });
        }
        if (error === guestAccessEnded)
          return res.status(404).json({ error: "Drawing not found" });
        throw error;
      }
    }
    next();
  });

  // Raw body parser mounted ONLY on the upload route. The global
  // express.json parser ignores non-JSON content types, so the raw image
  // bytes reach here untouched. `FILE_UPLOAD_MAX_MB` is the single per-image
  // ceiling — it does not touch BODY_LIMIT_MB.
  const rawUpload = express.raw({
    type: "*/*",
    limit: config.fileUploadMaxBytes,
  });

  // Convert express.raw's PayloadTooLargeError into an actionable 413 JSON
  // response regardless of NODE_ENV (the global error handler would mask the
  // message in production).
  const handleUploadPayloadError: express.ErrorRequestHandler = (
    err,
    _req,
    res,
    next,
  ) => {
    if (
      err &&
      (err.type === "entity.too.large" ||
        err.status === 413 ||
        err.statusCode === 413)
    ) {
      res.status(413).json({
        error: "File too large",
        message: `Uploaded file exceeds the ${config.fileUploadMaxMb}MB limit. Raise FILE_UPLOAD_MAX_MB to accept larger images.`,
      });
      return;
    }
    next(err);
  };

  // ------------------------------------------------------------------
  // GET /files/config
  // Returns whether S3 is enabled so the frontend can decide whether to
  // show storage management features.
  // ------------------------------------------------------------------
  app.get(
    "/files/config",
    requireAuth,
    asyncHandler(async (_req, res) => {
      return res.json({ s3Enabled: isS3Enabled() });
    }),
  );

  // ------------------------------------------------------------------
  // PUT /drawings/:drawingId/files/:fileId
  // Uploads the raw bytes of a single image. Idempotent: (drawingId,fileId)
  // is content-addressed, so an existing row with content is a 200 no-op.
  // ------------------------------------------------------------------
  app.put(
    "/drawings/:drawingId/files/:fileId",
    // Verify the edit grant before buffering the raw upload body.
    authenticateFileRequest(requireAuth),
    checkUploadAccess,
    rawUpload,
    handleUploadPayloadError,
    asyncHandler(async (req, res) => {
      const { drawingId, fileId } = req.params as {
        drawingId: string;
        fileId: string;
      };
      const principal = getPrincipal(req);
      if (!principal)
        return res.status(404).json({ error: "Drawing not found" });
      // A guest grant may have ended while the request body was uploading.
      if (
        principal.kind === "guest" &&
        !canEditDrawing(
          await getDrawingAccess({ prisma, principal, drawingId }),
        )
      ) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const persistFile = (content: Prisma.DrawingFileCreateInput) => {
        if (principal.kind !== "guest")
          return storeDrawingFileOnce(prisma, content);
        return prisma.$transaction(async (tx) => {
          await lockDrawingForGuestAccess(tx, drawingId);
          if (
            !canEditDrawing(
              await getDrawingAccess({ prisma: tx, principal, drawingId }),
            )
          ) {
            return null;
          }
          await checkGuestUploadQuota(
            tx,
            principal,
            drawingId,
            fileId,
            content.sizeBytes ?? 0,
          );
          return storeDrawingFileOnce(tx, {
            ...content,
            ...guestUploadMetadata(principal.shareId),
          });
        });
      };

      const mimeType = (req.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (
        !Object.hasOwn(MIME_TO_EXT, mimeType) ||
        (principal.kind === "guest" && !isGuestImageType(mimeType))
      ) {
        return res.status(415).json({
          error: "Unsupported media type",
          message:
            principal.kind === "guest"
              ? "Guests can upload raster images only"
              : `Content-Type must be one of: ${Object.keys(MIME_TO_EXT).join(", ")}`,
        });
      }

      const body = req.body;
      if (
        typeof body !== "object" ||
        body === null ||
        !Buffer.isBuffer(body) ||
        body.length === 0
      ) {
        return res.status(400).json({
          error: "Empty request body",
          message: "Send the raw image bytes as the request body.",
        });
      }

      const responseUrl = `/api/files/${drawingId}/${fileId}`;

      // Idempotent: an existing row that already carries content is a no-op.
      const existing = await prisma.drawingFile.findUnique({
        where: { drawingId_fileId: { drawingId, fileId } },
      });
      if (hasDrawingFileContent(existing)) {
        return res.status(200).json({ url: responseUrl, fileId });
      }

      try {
        if (isS3Enabled()) {
          if (principal.kind === "guest") {
            await checkGuestUploadQuota(
              prisma,
              principal,
              drawingId,
              fileId,
              body.length,
            );
          }
          // Collaborators may upload, but storage listing and drawing cleanup
          // use the drawing owner's namespace, just like inline scene files.
          const drawing = await prisma.drawing.findUnique({
            where: { id: drawingId },
            select: { userId: true },
          });
          if (!drawing) {
            return res.status(404).json({ error: "Drawing not found" });
          }
          const ext = MIME_TO_EXT[mimeType] ?? "bin";
          const s3Key = buildS3Key(
            drawing.userId,
            drawingId,
            fileId,
            ext,
            randomUUID(),
          );
          await uploadBuffer(s3Key, body, mimeType);
          const stored = await persistFile({
            drawingId,
            fileId,
            mimeType,
            sizeBytes: body.length,
            storage: "s3",
            s3Key,
            data: null,
          }).catch(async (error) => {
            if (
              error instanceof GuestUploadLimitError ||
              error === guestAccessEnded
            ) {
              await discardGuestS3Upload(prisma, {
                drawingId,
                s3Key,
                sizeBytes: body.length,
              });
            }
            throw error;
          });
          if (principal.kind === "guest") {
            if (stored?.s3Key !== s3Key) {
              await discardGuestS3Upload(prisma, {
                drawingId,
                s3Key,
                sizeBytes: body.length,
              });
            }
          } else {
            await cleanupUnusedS3Upload(
              s3Key,
              stored ?? { storage: "none", s3Key: null },
            );
          }
          if (!stored)
            return res.status(404).json({ error: "Drawing not found" });
          return res.status(200).json({ url: responseUrl, fileId });
        }

        // Database-bytes mode: persist the raw bytes inline.
        const stored = await persistFile({
          drawingId,
          fileId,
          mimeType,
          sizeBytes: body.length,
          storage: "db",
          s3Key: null,
          data: body,
        });
        if (!stored)
          return res.status(404).json({ error: "Drawing not found" });
        return res.status(200).json({ url: responseUrl, fileId });
      } catch (error) {
        if (error instanceof GuestUploadLimitError) {
          return res
            .status(error.status)
            .json({ error: error.message, code: error.code });
        }
        if (error === guestAccessEnded)
          return res.status(404).json({ error: "Drawing not found" });
        throw error;
      }
    }),
  );

  // ------------------------------------------------------------------
  // GET /files/:drawingId/:fileId
  // Serves the image. In db-mode the bytes are streamed directly with an
  // immutable cache policy and an ETag (honoring If-None-Match → 304). In
  // s3-mode a presigned GET URL is issued and the browser is redirected.
  // ------------------------------------------------------------------
  app.get(
    "/files/:drawingId/:fileId",
    authenticateFileRequest(optionalAuth),
    asyncHandler(async (req, res) => {
      const { drawingId, fileId } = req.params;
      if (!isValidIdSegment(drawingId) || !isValidIdSegment(fileId)) {
        return res.status(400).json({ error: "Invalid id segment" });
      }

      // Drawing access decides authorization; fall back to 404 on
      // miss so we don't leak existence of a (drawing, fileId) pair.
      const principal = getPrincipal(req);
      const access = await getDrawingAccess({ prisma, principal, drawingId });
      if (!canViewDrawing(access)) {
        return res.status(404).json({ error: "File not found" });
      }

      const fileRecord = await prisma.drawingFile.findUnique({
        where: { drawingId_fileId: { drawingId, fileId } },
      });
      if (!fileRecord) {
        return res.status(404).json({ error: "File not found" });
      }

      const canReadGuestFile = async () => {
        if (principal?.kind !== "guest") return false;
        const drawing = await prisma.drawing.findUnique({
          where: { id: drawingId },
          select: { elements: true },
        });
        let visible = false;
        try {
          visible = guestSceneFileIds(
            JSON.parse(drawing?.elements ?? "[]"),
          ).has(fileId);
        } catch {
          // Treat an invalid stored scene as having no visible attachments.
        }
        return (
          visible &&
          canViewDrawing(
            await getDrawingAccess({ prisma, principal, drawingId }),
          )
        );
      };

      const isScriptableType = !isGuestImageType(fileRecord.mimeType);
      const setFileHeaders = () => {
        res.setHeader("Content-Type", fileRecord.mimeType);
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (isScriptableType)
          res.setHeader("Content-Disposition", "attachment");
      };
      if (principal?.kind === "guest") {
        // Do not hand guests a presigned URL that would outlive their access.
        // Stream via the app so each request checks the share again.
        if (fileRecord.storage === "db" && fileRecord.data) {
          if (!(await canReadGuestFile())) {
            return res.status(404).json({ error: "File not found" });
          }
          setFileHeaders();
          return res.status(200).end(Buffer.from(fileRecord.data));
        }
        if (
          fileRecord.storage !== "s3" ||
          !isS3Enabled() ||
          !fileRecord.s3Key
        ) {
          return res.status(404).json({ error: "File not found" });
        }
        if (!(await canReadGuestFile())) {
          return res.status(404).json({ error: "File not found" });
        }
        const stream = await downloadDrawingFileStream(fileRecord.s3Key);
        if (!(await canReadGuestFile())) {
          stream.destroy();
          return res.status(404).json({ error: "File not found" });
        }
        setFileHeaders();
        await pipeline(stream, res);
        return;
      }

      if (fileRecord.storage === "db") {
        if (!fileRecord.data) {
          return res.status(404).json({ error: "File not found" });
        }
        // fileIds are content hashes, so the object is immutable — a strong
        // ETag equal to the fileId lets revisits short-circuit to 304.
        const etag = `"${fileId}"`;
        res.setHeader("ETag", etag);
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        if (req.headers["if-none-match"] === etag) {
          return res.status(304).end();
        }
        const buffer = Buffer.isBuffer(fileRecord.data)
          ? fileRecord.data
          : Buffer.from(fileRecord.data as Uint8Array);
        setFileHeaders();
        res.setHeader("Content-Length", buffer.length);
        return res.status(200).end(buffer);
      }

      // storage === "s3": presigned redirect (private-bucket mode).
      if (!isS3Enabled() || !fileRecord.s3Key) {
        return res.status(404).json({ error: "File not found" });
      }

      // The redirect bypasses the app's CSP/nosniff headers, so pin the
      // content type to the stored (whitelisted) value and force scriptable
      // types — SVG can carry <script> — to download instead of render.
      const downloadUrl = await generatePresignedDownloadUrl(
        fileRecord.s3Key,
        DOWNLOAD_EXPIRES_IN,
        {
          contentType: fileRecord.mimeType,
          contentDisposition: isScriptableType
            ? "attachment"
            : `inline; filename="${fileId}"`,
        },
      );

      return res.redirect(302, downloadUrl);
    }),
  );
};
