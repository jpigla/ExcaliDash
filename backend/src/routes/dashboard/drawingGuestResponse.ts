import type { Drawing, DrawingFile } from "../../generated/client";
import type { DrawingPermission } from "../../authz/sharing";

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

export const guestDrawingResponse = (
  drawing: Drawing,
  accessLevel: DrawingPermission,
  parseJsonField: <T>(raw: string | null | undefined, fallback: T) => T,
  storedFiles: Pick<DrawingFile, "fileId">[],
) => {
  const files = scopeGuestDrawingFiles(
    drawing.id,
    parseJsonField<Record<string, unknown>>(drawing.files, {}),
    storedFiles,
  );

  return {
    id: drawing.id,
    name: drawing.name,
    collectionId: null,
    createdAt: drawing.createdAt,
    updatedAt: drawing.updatedAt,
    version: drawing.version,
    elements: parseJsonField(drawing.elements, []),
    appState: parseJsonField(drawing.appState, {}),
    files,
    accessLevel,
  };
};
