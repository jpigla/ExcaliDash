import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";

test("board fonts and formatting survive editing, save, and native export", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, { name: "Typography E2E" });
  const sample = "Grüße – Straße, ẞ, €";
  const sceneText = () =>
    page.evaluate(() =>
      (window as any).__EXCALIDASH_EXCALIDRAW_API__
        ?.getSceneElements()
        .find((element: any) => element.type === "text"),
    );
  try {
    await page.addInitScript(() => {
      // Exercise the standard download path without an OS save dialog.
      Reflect.deleteProperty(window, "showOpenFilePicker");
      Reflect.deleteProperty(window, "showSaveFilePicker");
    });
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/editor/${drawing.id}`);
    const canvas = page.locator(".excalidraw__canvas.interactive");
    await expect(canvas).toBeVisible();
    await expect(
      page.getByRole("heading", { name: drawing.name }),
    ).toBeVisible();
    await canvas.click({ position: { x: 410, y: 280 } });
    await page.keyboard.press("t");
    await canvas.click({ position: { x: 450, y: 300 } });
    const editor = page.locator(".excalidraw-wysiwyg");
    await expect(editor).toBeVisible();
    await editor.fill(sample);

    await page.getByTestId("font-family-show-fonts").click();
    for (const font of [
      "Kalam",
      "Luckiest Guy",
      "Patrick Hand",
      "Redacted Script",
      "Indie Flower",
      "Gochi Hand",
      "Schoolbell",
    ]) {
      await expect(page.getByText(font, { exact: true })).toBeVisible();
    }
    await page.getByText("Kalam", { exact: true }).click();

    const weights = page.getByRole("combobox", { name: "Font weight" });
    const format = page.getByRole("group", { name: "Text formatting" });
    await weights.selectOption("300");
    await expect
      .poll(async () => (await sceneText())?.textFormatting?.weight)
      .toBe(300);
    await format.getByRole("button", { name: "Bold" }).click();
    await format.getByRole("button", { name: "Italic" }).click();
    await format.getByRole("button", { name: "Underline" }).click();
    await format.getByRole("button", { name: "Strikethrough" }).click();
    await expect.poll(sceneText).toMatchObject({
      fontFamily: 101,
      textFormatting: {
        weight: 700,
        italic: true,
        underline: true,
        strikethrough: true,
      },
    });

    // Styled CSS shorthand can start with "italic 700". The height
    // still comes from the pixel size, and the text stays on the canvas.
    await expect
      .poll(async () => {
        const text = await sceneText();
        return text?.height / (text?.fontSize * text?.lineHeight);
      })
      .toBeCloseTo(1);
    const { y } = await sceneText();
    expect(Number.isFinite(y)).toBe(true);

    await page.keyboard.press("Escape");
    await expect
      .poll(async () => (await getDrawing(request, drawing.id)).elements)
      .toContainEqual(
        expect.objectContaining({
          text: sample,
          fontFamily: 101,
          height: expect.closeTo(31.8),
          y: expect.any(Number),
          textFormatting: {
            weight: 700,
            italic: true,
            underline: true,
            strikethrough: true,
          },
        }),
      );

    await page.reload();
    await expect.poll(sceneText).toMatchObject({
      text: sample,
      fontFamily: 101,
      textFormatting: {
        weight: 700,
        italic: true,
        underline: true,
        strikethrough: true,
      },
    });

    await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const element = api
        .getSceneElements()
        .find((item: any) => item.type === "text");
      api.updateScene({
        appState: { selectedElementIds: { [element.id]: true } },
      });
    });
    await format.getByRole("button", { name: "Strikethrough" }).click();
    await expect
      .poll(async () => (await sceneText())?.textFormatting?.strikethrough)
      .toBe(false);
    await page.getByTestId("button-undo").click();
    await expect
      .poll(async () => (await sceneText())?.textFormatting?.strikethrough)
      .toBe(true);

    await page.getByTestId("main-menu-trigger").click();
    await page.getByTestId("image-export-button").click();
    const exportButtons = page.locator(
      ".ImageExportModal__settings__buttons button",
    );
    await expect(exportButtons).toHaveCount(3);
    const pngDownload = page.waitForEvent("download", { timeout: 10_000 });
    await exportButtons.nth(0).click();
    const png = await readFile((await (await pngDownload).path())!);
    expect(png.subarray(1, 4).toString()).toBe("PNG");

    const svgDownload = page.waitForEvent("download", { timeout: 10_000 });
    await exportButtons.nth(1).click();
    const svg = await readFile((await (await svgDownload).path())!, "utf8");
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('font-style="italic"');
    expect(svg).toContain('text-decoration="underline line-through"');
    expect(svg).toMatch(
      /font-family: Kalam; src: url\(data:[^)]+\); font-weight: 700/,
    );
    expect(svg).toMatch(/font-family: Nunito; src: url\(data:/);
    await exportButtons.nth(2).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const items = await navigator.clipboard.read();
          return items.flatMap(({ types }) => types);
        }),
      )
      .toContain("image/png");

    await page.goto("/");
    const card = page.locator(`[id="drawing-card-${drawing.id}"]`);
    await expect(
      card.locator(".drawing-preview text", { hasText: sample }),
    ).toHaveAttribute("text-decoration", "underline line-through");
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});
