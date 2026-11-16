import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

test("native two-finger gestures pan while modified wheel zooms", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, {
    name: `Navigation ${Date.now()}`,
  });
  try {
    await page.goto(`/editor/${drawing.id}`);
    const canvas = page.locator("canvas.excalidraw__canvas.interactive");
    await expect(canvas).toBeVisible();
    const state = () =>
      page.evaluate(() => {
        const app = (
          window as any
        ).__EXCALIDASH_EXCALIDRAW_API__?.getAppState();
        return app
          ? { x: app.scrollX, y: app.scrollY, zoom: app.zoom.value }
          : null;
      });
    await expect.poll(state).not.toBeNull();
    await canvas.hover({ timeout: 10000 });
    const before = (await state())!;
    await page.mouse.wheel(48, 0);
    await expect.poll(async () => (await state())!.x).not.toBe(before.x);
    expect((await state())!.zoom).toBe(before.zoom);

    const horizontal = (await state())!;
    await page.mouse.wheel(0, 16.5);
    await expect.poll(async () => (await state())!.y).not.toBe(horizontal.y);
    expect((await state())!.zoom).toBe(before.zoom);

    const vertical = (await state())!;
    await page.mouse.wheel(12.5, 18);
    await expect.poll(async () => (await state())!.x).not.toBe(vertical.x);
    await expect.poll(async () => (await state())!.y).not.toBe(vertical.y);
    expect((await state())!.zoom).toBe(before.zoom);

    await page.keyboard.down("Control");
    try {
      await page.mouse.wheel(0, -48);
      await expect
        .poll(async () => (await state())!.zoom)
        .not.toBe(before.zoom);
    } finally {
      await page.keyboard.up("Control");
    }
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});

test("boards open fitted or restore the last viewport and zoom down to 1%", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, {
    name: `Viewport ${Date.now()}`,
    elements: [
      {
        id: "a",
        type: "rectangle",
        x: 4000,
        y: -12000,
        width: 100,
        height: 100,
      },
      {
        id: "b",
        type: "rectangle",
        x: 22000,
        y: -3000,
        width: 100,
        height: 100,
      },
    ],
  });
  try {
    const openingView = page.getByRole("combobox", {
      name: "Board opening view",
    });
    const zoomLabel = page.locator(".reset-zoom-button");
    const viewport = () =>
      page.evaluate(() => {
        const state = (
          window as any
        ).__EXCALIDASH_EXCALIDRAW_API__?.getAppState();
        if (!state || state.isLoading) return null;
        const zoom = state.zoom.value;
        return {
          zoom,
          x: state.width / (2 * zoom) - state.scrollX,
          y: state.height / (2 * zoom) - state.scrollY,
          visibleWidth: state.width / zoom,
          visibleHeight: state.height / zoom,
        };
      });

    await page.goto("/settings");
    await expect(openingView).toHaveValue("fit");
    await page.goto(`/editor/${drawing.id}`);
    await expect
      .poll(async () => {
        const view = await viewport();
        return (
          view && {
            x: Math.round(view.x),
            y: Math.round(view.y),
            fits: view.visibleWidth >= 18100 && view.visibleHeight >= 9100,
          }
        );
      })
      .toEqual({ x: 13050, y: -7450, fits: true });
    await expect(zoomLabel).toHaveText(/^[1-9]%$/);

    await page.goto("/settings");
    await openingView.selectOption("last");
    await page.goto(`/editor/${drawing.id}`);
    await expect(zoomLabel).toBeVisible();
    await page.evaluate(() => {
      (window as any).__EXCALIDASH_EXCALIDRAW_API__.updateScene({
        appState: { zoom: { value: 0.1 } },
      });
    });
    await expect(zoomLabel).toHaveText("10%");
    const zoomOut = page.locator(".zoom-out-button");
    for (let percent = 9; percent >= 1; percent--) {
      await zoomOut.click();
      await expect(zoomLabel).toHaveText(`${percent}%`);
    }
    await expect(zoomOut).toBeDisabled();
    const zoomIn = page.locator(".zoom-in-button");
    for (let percent = 2; percent <= 10; percent++) {
      await zoomIn.click();
      await expect(zoomLabel).toHaveText(`${percent}%`);
    }

    const canvas = page.locator("canvas.excalidraw__canvas.interactive");
    await canvas.hover();
    const beforePan = await viewport();
    await page.mouse.wheel(120, 100);
    await expect.poll(async () => (await viewport())?.x).not.toBe(beforePan?.x);
    const lastView = await viewport();
    await page.reload();
    await expect.poll(viewport).toEqual(lastView);
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});
