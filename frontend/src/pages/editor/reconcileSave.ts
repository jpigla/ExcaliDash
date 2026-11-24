import type { MutableRefObject } from "react";
import * as api from "../../api";
import { reconcileElements } from "../../utils/sync";
import { expandGuestElementTombstone, isInlineImageFile } from "./shared";
import {
  filesNeedRehydration,
  rehydrateFilesFromUrls,
} from "../../utils/rehydrateFiles";

type ReconcileRefs = {
  currentDrawingVersion: MutableRefObject<number | null>;
  excalidrawAPI: MutableRefObject<any>;
  isSyncing: MutableRefObject<boolean>;
  latestElements: MutableRefObject<readonly any[]>;
  latestFiles: MutableRefObject<any>;
  lastSyncedFiles: MutableRefObject<Record<string, any>>;
};

/**
 * On a save version conflict, reload the authoritative server scene and merge
 * it with the local edits (reconcileElements + a files union) rather than
 * blindly re-sending stale state over a newer version — the old blind retry
 * could clobber another client's concurrent work. The merged scene is pushed
 * back into the live editor so what the user sees matches what gets saved.
 */
export const reloadAndReconcile = async (
  refs: ReconcileRefs,
  drawingId: string,
  localElements: readonly any[],
  localFiles: Record<string, any>,
  isCurrent: () => boolean = () => true,
  guestShareId?: string,
): Promise<{
  elements: readonly any[];
  files: Record<string, any>;
  appState: Record<string, any>;
} | null> => {
  if (!isCurrent()) return null;
  const remote = await api.getDrawing(drawingId, {
    omitPreview: true,
    ...(guestShareId ? { guestShareId } : {}),
  });
  if (!isCurrent()) return null;
  const storedRemoteFiles =
    (remote.files as Record<string, any> | undefined) || {};
  const remoteFiles = filesNeedRehydration(storedRemoteFiles)
    ? await rehydrateFilesFromUrls(
        storedRemoteFiles,
        undefined,
        undefined,
        guestShareId ? { drawingId, guestShareId } : undefined,
      )
    : storedRemoteFiles;
  if (!isCurrent()) return null;
  const editor = refs.excalidrawAPI.current;
  const liveElements =
    editor?.getSceneElementsIncludingDeleted?.() ?? refs.latestElements.current;
  const mergedLocal = reconcileElements(localElements, liveElements);
  let remoteElements = Array.isArray(remote.elements) ? remote.elements : [];
  if (guestShareId) {
    const localById = new Map(
      mergedLocal.map((element) => [element.id, element]),
    );
    remoteElements = remoteElements
      .map((element: any) =>
        expandGuestElementTombstone(element, localById.get(element.id)),
      )
      .filter(Boolean);
  }
  const mergedElements = reconcileElements(
    mergedLocal,
    remoteElements,
    editor?.getAppState?.(),
    true,
  );
  const mergedFiles = {
    ...remoteFiles,
    ...localFiles,
    ...refs.latestFiles.current,
    ...editor?.getFiles?.(),
  };
  const remoteAppState =
    remote.appState && typeof remote.appState === "object"
      ? (remote.appState as Record<string, any>)
      : {};
  const syncedAppState: Record<string, any> = {};
  for (const key of ["viewBackgroundColor", "gridSize", "gridModeEnabled"]) {
    if (key in remoteAppState) {
      syncedAppState[key] = remoteAppState[key];
    }
  }
  const mergedAppState = {
    ...(editor?.getAppState?.() || {}),
    ...syncedAppState,
  };
  refs.currentDrawingVersion.current = remote.version;
  if (editor) {
    refs.isSyncing.current = true;
    try {
      if (typeof editor.addFiles === "function") {
        editor.addFiles(
          guestShareId
            ? Object.values(mergedFiles).filter(isInlineImageFile)
            : Object.values(mergedFiles),
        );
      }
      if (typeof editor.updateScene === "function") {
        editor.updateScene({
          elements: mergedElements,
          ...(Object.keys(syncedAppState).length > 0
            ? { appState: syncedAppState }
            : {}),
          captureUpdate: "NEVER",
        });
      }
    } finally {
      refs.isSyncing.current = false;
    }
  }
  refs.latestElements.current = mergedElements;
  refs.latestFiles.current = mergedFiles;
  refs.lastSyncedFiles.current = mergedFiles;
  return {
    elements: mergedElements,
    files: mergedFiles,
    appState: mergedAppState,
  };
};
