import type { Page } from "@playwright/test";

export const waitForFileInEditor = async (
  page: Page,
  fileId: string,
  requireInline = false,
) => {
  const timeoutMs = 30000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(
      ({ id, requireInline }) => {
        const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
        const files = api?.getFiles?.() || {};
        const entry = files?.[id];
        return (
          !!entry &&
          typeof entry.mimeType === "string" &&
          (!requireInline || entry.dataURL?.startsWith("data:image/"))
        );
      },
      { id: fileId, requireInline },
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for file ${fileId} to exist in editor`);
};

export const injectImageElementThenFile = async (page: Page) => {
  return await page.evaluate(async () => {
    const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
    if (!api) throw new Error("Missing __EXCALIDASH_EXCALIDRAW_API__");

    const bytes = crypto.getRandomValues(new Uint8Array(20));
    const fileId = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const elementId = `img_${Math.random().toString(36).slice(2)}`;

    const dataURL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAIElEQVR42mP8z8Dwn4EIwDiqgWjAqIGhBo4aGAAAcO0Gg+o1P8oAAAAASUVORK5CYII=";

    const now = Date.now();
    const element = {
      id: elementId,
      type: "image",
      x: 120,
      y: 120,
      width: 240,
      height: 240,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roundness: null,
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      seed: Math.floor(Math.random() * 2 ** 31),
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      isDeleted: false,
      boundElements: null,
      link: null,
      locked: false,
      index: "a1",
      updated: now,
      status: "pending",
      fileId,
      scale: [1, 1],
      crop: null,
    };

    const before = api.getSceneElementsIncludingDeleted();
    api.updateScene({ elements: [...before, element] });

    await new Promise((r) => setTimeout(r, 600));
    api.addFiles({
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL,
        created: Date.now(),
        lastRetrieved: Date.now(),
      },
    });

    return { fileId, elementId };
  });
};

export const waitForElementPresent = async (page: Page, elementId: string) => {
  await page.waitForFunction(
    (id) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const els = api?.getSceneElementsIncludingDeleted?.() || [];
      const el = els.find((e: any) => e?.id === id);
      return !!el && el.isDeleted !== true;
    },
    elementId,
    { timeout: 15000 },
  );
};
