import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  createDrawing,
  deleteDrawing,
  getDrawing,
  updateDrawing,
} from "./helpers/api";
import {
  injectImageElementThenFile,
  waitForElementPresent,
  waitForFileInEditor,
} from "./helpers/editorImages";

/**
 * Regression tests for:
 * - Issue #25: pasted image doesn't load in other tabs
 * - Follow-up: deleting the image in one tab should remove it from all tabs
 *
 * NOTE:
 * We drive the editor via Excalidraw's API (exposed in dev/test builds) to make
 * the test deterministic and to specifically model the async "element first,
 * file data later" behavior seen with paste/import.
 */

const openEditorTab = async (context: BrowserContext, drawingId: string) => {
  const page = await context.newPage();
  await page.goto(`/editor/${drawingId}`);
  await page.waitForSelector("[class*='excalidraw'], canvas", {
    timeout: 15000,
  });
  await page.waitForFunction(() => {
    return !!(window as any).__EXCALIDASH_EXCALIDRAW_API__;
  });
  await page.waitForFunction(() => {
    return (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true;
  });
  return page;
};

const waitForElementDeletedEverywhere = async (
  page: Page,
  elementId: string,
) => {
  await page.waitForFunction(
    (id) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const els = api?.getSceneElementsIncludingDeleted?.() || [];
      const el = els.find((e: any) => e?.id === id);
      return !!el && el.isDeleted === true;
    },
    elementId,
    { timeout: 15000 },
  );
};

test.describe("Issue #25 - image sync + deletion across tabs", () => {
  const createdDrawingIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdDrawingIds) {
      try {
        await deleteDrawing(request, id);
      } catch {}
    }
    createdDrawingIds.length = 0;
  });

  test("image added in tab1 appears in tab2 and tab3; deletion propagates to all tabs", async ({
    browser,
    request,
  }) => {
    test.setTimeout(120000);
    const drawing = await createDrawing(request, {
      name: `Issue25_ImageCollab_${Date.now()}`,
      elements: [],
      files: {},
    });
    createdDrawingIds.push(drawing.id);

    const context = await browser.newContext();
    const page1 = await openEditorTab(context, drawing.id);
    const page2 = await openEditorTab(context, drawing.id);

    const { fileId, elementId } = await injectImageElementThenFile(page1);

    await waitForElementPresent(page2, elementId);
    await waitForFileInEditor(page2, fileId);

    const snapshot = await page1.evaluate(() => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const elements = api.getSceneElementsIncludingDeleted();
      const files = api.getFiles?.() || {};
      const appState = api.getAppState?.() || {};
      return {
        elements,
        files,
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor ?? "#ffffff",
          gridSize: appState.gridSize ?? null,
        },
      };
    });
    await updateDrawing(request, drawing.id, snapshot);

    const page3 = await openEditorTab(context, drawing.id);
    await waitForFileInEditor(page3, fileId);

    await page2.evaluate((id) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const appState = api.getAppState();
      api.updateScene({
        appState: {
          ...appState,
          selectedElementIds: {
            ...(appState.selectedElementIds || {}),
            [id]: true,
          },
        },
      });
    }, elementId);

    await page1.evaluate((id) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const els = api.getSceneElementsIncludingDeleted();
      const target = els.find((e: any) => e?.id === id);
      if (!target) throw new Error("Target element not found");
      const updated = {
        ...target,
        isDeleted: true,
        version: (target.version ?? 0) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: Date.now(),
      };
      api.updateScene({
        elements: els.map((e: any) => (e.id === id ? updated : e)),
      });
    }, elementId);

    await waitForElementDeletedEverywhere(page2, elementId);
    await waitForElementDeletedEverywhere(page3, elementId);

    const persisted = await getDrawing(request, drawing.id);
    const persistedFile = persisted.files?.[fileId];
    expect(typeof persistedFile?.dataURL).toBe("string");
    expect((persistedFile?.dataURL || "").length).toBeGreaterThan(0);

    await context.close();
  });
});
