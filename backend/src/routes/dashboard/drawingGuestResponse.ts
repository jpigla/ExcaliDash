import type { Drawing, DrawingFile } from "../../generated/client";
import type { DrawingPermission } from "../../authz/sharing";

type SceneElement = { type?: string; isDeleted?: boolean; fileId?: unknown };

export const guestSceneFileIds = (elements: unknown): Set<string> =>
  new Set(
    Array.isArray(elements)
      ? elements.flatMap((element: SceneElement | null) =>
          element &&
          element.type === "image" &&
          element.isDeleted !== true &&
          typeof element.fileId === "string" &&
          /^[\w-]{1,200}$/.test(element.fileId) &&
          !["__proto__", "constructor", "prototype"].includes(element.fileId)
            ? [element.fileId]
            : [],
        )
      : [],
  );

export const scopeGuestDrawingFiles = (
  drawingId: string,
  files: Record<string, unknown>,
  storedFiles: Pick<DrawingFile, "fileId">[],
) => {
  const scopedFiles = { ...files };
  for (const { fileId } of storedFiles) {
    const file = scopedFiles[fileId];
    if (!file || typeof file !== "object") continue;
    scopedFiles[fileId] = {
      ...file,
      dataURL: `/api/files/${drawingId}/${fileId}`,
    };
  }
  return scopedFiles;
};

export const scopeGuestScene = (
  drawingId: string,
  elements: unknown,
  files: Record<string, unknown>,
  storedFiles: Pick<DrawingFile, "fileId">[],
) => {
  const activeElements = Array.isArray(elements)
    ? elements.filter((element) => element && element.isDeleted !== true)
    : [];
  const visibleIds = guestSceneFileIds(activeElements);
  const storedIds = new Set(storedFiles.map(({ fileId }) => fileId));
  const visibleFiles = Object.fromEntries(
    Object.entries(files ?? {}).filter(([fileId]) => visibleIds.has(fileId)),
  );
  // Raw image uploads can precede scene file metadata. Return a reference for
  // any visible image whose bytes are already stored on this drawing.
  for (const fileId of visibleIds) {
    if (storedIds.has(fileId) && !Object.hasOwn(visibleFiles, fileId)) {
      visibleFiles[fileId] = { id: fileId, created: 0 };
    }
  }
  return {
    elements: Array.isArray(elements)
      ? elements.filter(Boolean).map((element) =>
          element.isDeleted === true
            ? {
                id: element.id,
                version: element.version,
                versionNonce: element.versionNonce,
                isDeleted: true,
              }
            : element,
        )
      : [],
    files: scopeGuestDrawingFiles(drawingId, visibleFiles, storedFiles),
  };
};

export const guestDrawingResponse = (
  drawing: Drawing,
  accessLevel: DrawingPermission,
  parseJsonField: <T>(raw: string | null | undefined, fallback: T) => T,
  storedFiles: Pick<DrawingFile, "fileId">[],
) => ({
  id: drawing.id,
  name: drawing.name,
  collectionId: null,
  createdAt: drawing.createdAt,
  updatedAt: drawing.updatedAt,
  version: drawing.version,
  ...scopeGuestScene(
    drawing.id,
    parseJsonField(drawing.elements, []),
    parseJsonField<Record<string, unknown>>(drawing.files, {}),
    storedFiles,
  ),
  appState: parseJsonField(drawing.appState, {}),
  accessLevel,
});
