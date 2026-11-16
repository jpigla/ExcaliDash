import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { CaptureUpdateAction, isElementLink } from "@excalidraw/excalidraw";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { EditorStartView } from "../../api";

type Viewport = { x: number; y: number; zoom: AppState["zoom"]["value"] };
const SAVE_DELAY = 250;

function readViewport(key: string): Viewport | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      Number.isFinite(value?.x) &&
      Number.isFinite(value?.y) &&
      Number.isFinite(value?.zoom) &&
      value.zoom >= 0.01 &&
      value.zoom <= 30
    ) {
      return value;
    }
  } catch {
    // Missing or inaccessible storage falls back to fitting the drawing.
  }
  return null;
}

export function useEditorViewport(
  apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>,
  drawingId: string | undefined,
  account: string,
  startView: EditorStartView,
) {
  const storageKey = drawingId
    ? `excalidash-viewport:${account}:${drawingId}`
    : null;
  const initializedApi = useRef<ExcalidrawImperativeAPI | null>(null);
  const initializeFrame = useRef<number | null>(null);
  const lastViewport = useRef<Viewport | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingViewport = useRef<{ key: string; viewport: Viewport } | null>(
    null,
  );

  const flushViewport = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const pending = pendingViewport.current;
    if (pending) {
      try {
        localStorage.setItem(pending.key, JSON.stringify(pending.viewport));
      } catch {
        // The drawing can still be used when storage is unavailable.
      }
      pendingViewport.current = null;
    }
  }, []);

  useEffect(() => {
    window.addEventListener("pagehide", flushViewport);
    return () => {
      window.removeEventListener("pagehide", flushViewport);
      if (initializeFrame.current !== null) {
        window.cancelAnimationFrame(initializeFrame.current);
        initializeFrame.current = null;
      }
      flushViewport();
    };
  }, [flushViewport]);

  return useCallback(
    (state: AppState) => {
      const api = apiRef.current;
      if (!api || state.isLoading || state.width <= 0 || state.height <= 0) {
        return;
      }
      if (initializedApi.current !== api) {
        if (initializeFrame.current === null) {
          // Excalidraw can emit changes while its mount and initial sizing
          // updates are still queued. Use the settled scene and dimensions.
          initializeFrame.current = window.requestAnimationFrame(() => {
            initializeFrame.current = null;
            if (apiRef.current !== api) return;
            const { isLoading, width, height } = api.getAppState();
            if (isLoading || width <= 0 || height <= 0) return;
            flushViewport();
            initializedApi.current = api;
            lastViewport.current = null;
            if (isElementLink(window.location.href)) return;

            const saved =
              startView === "last" && storageKey && readViewport(storageKey);
            if (saved) {
              lastViewport.current = saved;
              api.updateScene({
                appState: {
                  scrollX: width / (2 * saved.zoom) - saved.x,
                  scrollY: height / (2 * saved.zoom) - saved.y,
                  zoom: { value: saved.zoom },
                },
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            } else if (api.getSceneElements().length > 0) {
              api.scrollToContent(undefined, {
                fitToViewport: true,
                viewportZoomFactor: 0.9,
                maxZoom: 1,
                animate: false,
              });
            }
          });
        }
        return;
      }
      if (!storageKey || state.userToFollow) return;
      const zoom = state.zoom.value;
      const x = state.width / (2 * zoom) - state.scrollX;
      const y = state.height / (2 * zoom) - state.scrollY;
      const previous = lastViewport.current;
      if (previous?.zoom === zoom && previous.x === x && previous.y === y)
        return;
      lastViewport.current = { x, y, zoom };
      pendingViewport.current = {
        key: storageKey,
        viewport: lastViewport.current,
      };
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flushViewport, SAVE_DELAY);
    },
    [apiRef, flushViewport, startView, storageKey],
  );
}
