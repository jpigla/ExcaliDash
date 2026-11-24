import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { isFileUploadSupported, uploadDrawingFile } from "../../api";
import { toast } from "sonner";
import { dataUrlToBlob } from "../../utils/dataUrls";
import { compressExcalidrawFiles } from "../../utils/imageCompression";
import type { UploadedFileRefs } from "./shared";
import {
  classifyUploadError,
  getUploadErrorStatus,
  getUploadRetryDelayMs,
} from "./uploadRetryPolicy";

// How often (ms) we sweep the live file set for freshly inserted images that
// still need uploading. A short interval keeps the first metadata-only scene
// save close behind the insert; the addFiles patch also calls scanNow directly
// for programmatic/drag inserts so uploads usually start before the poll ticks.
const SCAN_INTERVAL_MS = 800;
const UPLOAD_CONCURRENCY = 3;

type UseEditorFileUploadsParams = {
  canEdit: boolean;
  drawingId: string | undefined;
  guestShareId?: string;
  onGuestAccessEnded?: () => void;
  isReady: boolean;
  excalidrawAPI: MutableRefObject<any>;
  latestFiles: MutableRefObject<any>;
  uploadedRefs: MutableRefObject<UploadedFileRefs>;
};

/**
 * Watches the drawing's file set and uploads each newly inserted image to the
 * per-file endpoint (compressing first, exactly as the save path does, so the
 * stored bytes match). Successful uploads are recorded in `uploadedRefs`, which
 * the persistence / broadcast / keepalive paths use to swap the inline dataURL
 * for a small `/api/files/...` ref. Uploads are idempotent and content-keyed,
 * so a duplicate scan is a cheap no-op. Against an older backend the capability
 * flag flips off after the first 404/501 and this hook becomes inert.
 *
 * A failed upload is never retried from a tight loop: 401/403 stop uploads for
 * the drawing (the caller, e.g. a link-share editor without an account, can't
 * use the endpoint; the scene save still carries the inline bytes), other
 * non-retryable 4xx stop retrying that file, and retryable failures (network,
 * 408/429/5xx) back off exponentially up to a cap. See `uploadRetryPolicy.ts`.
 */
export const useEditorFileUploads = ({
  canEdit,
  drawingId,
  guestShareId,
  onGuestAccessEnded,
  isReady,
  excalidrawAPI,
  latestFiles,
  uploadedRefs,
}: UseEditorFileUploadsParams) => {
  const inFlightRef = useRef<Set<string>>(new Set());
  // Per-file consecutive failure count and earliest next attempt (ms epoch).
  const retryStateRef = useRef<
    Map<string, { failures: number; retryAt: number }>
  >(new Map());
  // Files that failed with a non-retryable error; never retried this session.
  const blockedIdsRef = useRef<Set<string>>(new Set());
  // Set on 401/403: the caller can't upload, so stop for this drawing session.
  const uploadsBlockedRef = useRef(false);
  const canEditRef = useRef(canEdit);
  const drawingSessionRef = useRef({ drawingId, guestShareId });
  useLayoutEffect(() => {
    if (
      drawingSessionRef.current.drawingId !== drawingId ||
      drawingSessionRef.current.guestShareId !== guestShareId
    ) {
      drawingSessionRef.current = { drawingId, guestShareId };
      inFlightRef.current = new Set();
      retryStateRef.current = new Map();
      blockedIdsRef.current = new Set();
      uploadsBlockedRef.current = false;
      uploadedRefs.current = {};
    }
  }, [drawingId, guestShareId, uploadedRefs]);
  useLayoutEffect(() => {
    canEditRef.current = canEdit;
    // A change in edit permission (e.g. the guest signs in) may lift a 401/403.
    uploadsBlockedRef.current = false;
  }, [canEdit]);

  const scanNow = useCallback(async () => {
    if (
      !canEditRef.current ||
      !drawingId ||
      (!guestShareId && !isFileUploadSupported())
    )
      return;
    if (
      uploadsBlockedRef.current ||
      inFlightRef.current.size >= UPLOAD_CONCURRENCY
    )
      return;
    const editor = excalidrawAPI.current;
    const session = drawingSessionRef.current;
    const inFlight = inFlightRef.current;
    const retryState = retryStateRef.current;
    const blockedIds = blockedIdsRef.current;
    const isCurrent = () =>
      drawingSessionRef.current === session &&
      session.drawingId === drawingId &&
      session.guestShareId === guestShareId &&
      excalidrawAPI.current === editor;
    if (!isCurrent()) return;
    const files = (editor?.getFiles?.() || latestFiles.current || {}) as Record<
      string,
      any
    >;

    const now = Date.now();
    const candidates: Record<string, any> = Object.create(null);
    for (const id in files) {
      if (!Object.hasOwn(files, id)) continue;
      if (blockedIds.has(id) || inFlight.has(id) || uploadedRefs.current[id])
        continue;
      const retryAt = retryState.get(id)?.retryAt;
      if (retryAt !== undefined && retryAt > now) continue;
      const file = files[id];
      if (
        typeof file?.dataURL !== "string" ||
        !file.dataURL.startsWith("data:")
      )
        continue;
      candidates[id] = file;
      inFlight.add(id);
      if (inFlight.size >= UPLOAD_CONCURRENCY) break;
    }
    const candidateIds = Object.keys(candidates);
    if (candidateIds.length === 0) return;

    const uploadOne = async (id: string, file: any): Promise<void> => {
      try {
        if (!canEditRef.current || !isCurrent() || uploadsBlockedRef.current)
          return;
        const body = await dataUrlToBlob(file.dataURL);
        if (!canEditRef.current || !isCurrent() || uploadsBlockedRef.current)
          return;
        if (!body) {
          blockedIds.add(id);
          return;
        }
        const result = await uploadDrawingFile(
          drawingId,
          id,
          body,
          (typeof file.mimeType === "string" && file.mimeType) || body.type,
          guestShareId,
        );
        // null => backend lacks the endpoint; stop trying for the session.
        if (isCurrent()) {
          if (result) uploadedRefs.current[id] = result.url;
          retryState.delete(id);
        }
      } catch (error) {
        // Ignore failures from a drawing/editor we've since moved away from.
        if (isCurrent()) {
          const kind = classifyUploadError(error);
          const status = guestShareId ? getUploadErrorStatus(error) : undefined;
          if (kind === "auth" || (guestShareId && status === 404)) {
            const wasBlocked = uploadsBlockedRef.current;
            uploadsBlockedRef.current = true;
            if (!wasBlocked && guestShareId) onGuestAccessEnded?.();
          } else if (kind === "permanent") {
            blockedIds.add(id);
            if (guestShareId && status === 415) {
              toast.error(
                "Guests can upload PNG, JPEG, GIF, WebP, AVIF, or BMP images.",
                { id: "guest-image-format" },
              );
            } else if (guestShareId && status === 413) {
              toast.error("This image is too large to upload.", {
                id: "guest-image-size",
              });
            }
          } else {
            const failures = (retryState.get(id)?.failures ?? 0) + 1;
            retryState.set(id, {
              failures,
              retryAt: Date.now() + getUploadRetryDelayMs(failures, error),
            });
          }
        }
      } finally {
        // The server interns inline bytes on scene save meanwhile.
        inFlight.delete(id);
      }
    };

    // Share the encoded bytes with autosave without re-adding files already
    // held by Excalidraw. The batch encodes sequentially to limit canvas memory.
    const compressed = await compressExcalidrawFiles(candidates).catch(
      () => null,
    );
    await Promise.all(
      candidateIds.map((id) =>
        uploadOne(id, compressed?.files[id] ?? candidates[id]),
      ),
    );
  }, [
    drawingId,
    excalidrawAPI,
    guestShareId,
    latestFiles,
    onGuestAccessEnded,
    uploadedRefs,
  ]);

  useEffect(() => {
    if (!canEdit || !drawingId || !isReady) return;
    const interval = window.setInterval(() => {
      void scanNow();
    }, SCAN_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [canEdit, drawingId, isReady, scanNow]);

  return { scanNow };
};
