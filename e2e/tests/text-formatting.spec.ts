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

    const fontTrigger = page.getByTestId("font-family-show-fonts");
    const fontPicker = page.locator(".FontPicker__container").filter({
      has: fontTrigger,
    });
    const format = page.getByRole("group", { name: "Text formatting" });
    await expect(format.locator(":scope > legend")).toHaveText(
      "Text formatting",
    );
    expect(
      await format.evaluate(
        (section) =>
          section.previousElementSibling?.querySelector(":scope > legend")
            ?.textContent,
      ),
    ).toBe("Font family");
    const buttonRects = (row: typeof format) =>
      row.getByRole("button").evaluateAll((buttons) =>
        buttons.map((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    await expect(fontTrigger).toBeVisible();
    await expect(format.getByRole("button")).toHaveCount(4);
    const fontRects = await buttonRects(fontPicker);
    const formatRects = await buttonRects(format);
    expect(fontRects).toHaveLength(4);
    expect(
      formatRects.map(({ x, width, height }) => ({ x, width, height })),
    ).toEqual(fontRects.map(({ x, width, height }) => ({ x, width, height })));
    expect(new Set(formatRects.map(({ y }) => y)).size).toBe(1);
    expect(formatRects[0].y).toBeGreaterThanOrEqual(
      fontRects[0].y + fontRects[0].height,
    );

    await fontTrigger.click();
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
    await page.getByText("Redacted Script", { exact: true }).click();
    await expect(format.getByRole("button")).toHaveCount(4);
    await expect(format.getByRole("combobox")).toHaveCount(0);
    await page.getByTestId("font-family-show-fonts").click();
    await page.getByText("Kalam", { exact: true }).click();
    await expect(format.getByRole("button")).toHaveCount(4);
    await expect(format.getByRole("combobox")).toHaveCount(0);

    const accent = await format.evaluate((row) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-primary)";
      row.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await fontTrigger.hover();
    for (const name of ["Bold", "Italic", "Underline", "Strikethrough"]) {
      const button = format.getByRole("button", { name });
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect(button).not.toHaveCSS("border-top-color", accent);
      await button.hover();
      await expect(button).toHaveCSS("border-top-color", accent);
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(button).toHaveCSS("border-top-color", accent);
      await fontTrigger.hover();
      await expect(button).toHaveCSS("border-top-color", accent);
    }
    const bold = format.getByRole("button", { name: "Bold" });
    await bold.click();
    await expect
      .poll(async () => (await sceneText())?.textFormatting?.weight)
      .toBe(400);
    await bold.click();
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

test("new font families preserve individual text colors in image exports", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, { name: "Board fonts E2E" });
  const families = [
    { name: "Montserrat", id: 108, nativeItalic: true },
    { name: "Manrope", id: 109, nativeItalic: false },
    { name: "Roboto", id: 110, nativeItalic: true },
    { name: "JetBrains Mono", id: 111, nativeItalic: true },
  ];
  const sample = "Grüße aus Köln – ẞ €";
  try {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, "showOpenFilePicker");
      Reflect.deleteProperty(window, "showSaveFilePicker");
    });
    await page.goto(`/editor/${drawing.id}`);
    await expect(
      page.getByRole("heading", { name: drawing.name }),
    ).toBeVisible();
    const canvas = page.locator("canvas.excalidraw__canvas.interactive");
    const editor = page.locator(".excalidraw-wysiwyg");
    await canvas.click({ position: { x: 410, y: 210 } });
    for (const [index, { name, nativeItalic }] of families.entries()) {
      await page.keyboard.press("t");
      await canvas.click({ position: { x: 450, y: 235 + 60 * index } });
      await editor.fill(sample);
      await editor.evaluate((element) => {
        const selection = document.getSelection()!;
        selection.setBaseAndExtent(
          element.firstChild!,
          0,
          element.firstChild!,
          5,
        );
      });
      await editor.press("ControlOrMeta+b");
      await editor.press("ControlOrMeta+i");
      await page.getByTestId("font-family-show-fonts").click();
      await page.getByText(name, { exact: true }).click();
      const formatted = editor.getByText("Grüße", { exact: true });
      await expect(formatted).toHaveCSS("font-style", "italic");
      await expect(formatted).toHaveCSS("font-weight", "700");
      await page.getByRole("button", { name: "Selected text color" }).click();
      await page.locator(".color-picker-input").fill("b00022");
      await expect(formatted).toHaveCSS("color", "rgb(176, 0, 34)");
      await page.locator(".color-picker-content").press("Escape");
      await expect(page.locator(".color-picker-content")).toBeHidden();
      await editor.focus();
      await editor.evaluate((element) => {
        document
          .getSelection()!
          .setBaseAndExtent(
            element.firstChild!.firstChild!,
            1,
            element.firstChild!.firstChild!,
            2,
          );
      });
      await page.getByTestId("color-top-pick-#1971c2").click();
      await expect(editor.getByText("r", { exact: true })).toHaveCSS(
        "color",
        "rgb(25, 113, 194)",
      );
      const faces = await page.evaluate(
        async ({ name, sample }) => {
          const faces = await document.fonts.load(
            `italic 700 20px "${name}"`,
            sample,
          );
          return faces.map(({ style, weight }) => ({ style, weight }));
        },
        { name, sample },
      );
      expect(faces).toContainEqual({
        style: nativeItalic ? "italic" : "normal",
        weight: "700",
      });
      await editor.press("Escape");
    }

    await expect
      .poll(async () =>
        (await getDrawing(request, drawing.id)).elements
          ?.filter(({ type }) => type === "text")
          .map(({ fontFamily }) => fontFamily),
      )
      .toEqual(families.map(({ id }) => id));
    await page.reload();
    await page.getByTestId("main-menu-trigger").click();
    await page.getByTestId("image-export-button").click();
    const svgDownload = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByRole("button", { name: "Export to SVG" }).click();
    const svg = await readFile((await (await svgDownload).path())!, "utf8");
    const exported = await page.evaluate((markup) => {
      const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
      const unquote = (family: string) =>
        family.trim().replace(/^["']|["']$/g, "");
      const css = new CSSStyleSheet();
      css.replaceSync(doc.querySelector(".style-fonts")?.textContent ?? "");
      return {
        faces: [...css.cssRules].flatMap((rule) =>
          rule instanceof CSSFontFaceRule &&
          rule.style.getPropertyValue("src").includes("data:")
            ? [
                {
                  family: unquote(rule.style.getPropertyValue("font-family")),
                  weight: rule.style.getPropertyValue("font-weight"),
                  style: rule.style.getPropertyValue("font-style"),
                },
              ]
            : [],
        ),
        texts: [...doc.querySelectorAll("text")].map((text) => ({
          family: unquote(
            text.getAttribute("font-family")?.split(",")[0] ?? "",
          ),
          text: text.textContent,
          boldItalic: Boolean(
            text.querySelector('tspan[font-weight="700"][font-style="italic"]'),
          ),
          colors: [...text.querySelectorAll("tspan[fill]")].map((span) => [
            span.textContent,
            span.getAttribute("fill"),
          ]),
        })),
      };
    }, svg);
    for (const { name, nativeItalic } of families) {
      expect(exported.faces).toEqual(
        expect.arrayContaining([
          { family: name, weight: "400", style: "normal" },
          {
            family: name,
            weight: "700",
            style: nativeItalic ? "italic" : "normal",
          },
        ]),
      );
      expect(exported.texts).toContainEqual({
        family: name,
        text: sample,
        boldItalic: true,
        colors: [
          ["G", "#b00022"],
          ["r", "#1971c2"],
          ["üße", "#b00022"],
        ],
      });
    }
    const pngDownload = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByRole("button", { name: "Export to PNG" }).click();
    const png = await readFile((await (await pngDownload).path())!);
    const inkBands = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const image = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const { width, height } = image;
      const context = new OffscreenCanvas(width, height).getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, width, height);
      const bands: number[][] = [];
      const redRows: number[] = [];
      const blueRows: number[] = [];
      let lastInkRow = -Infinity;
      for (let y = 0; y < height; y++) {
        let ink = 0;
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          if (
            data[offset] === 176 &&
            data[offset + 1] === 0 &&
            data[offset + 2] === 34 &&
            data[offset + 3] === 255
          )
            redRows.push(y);
          if (
            data[offset] === 25 &&
            data[offset + 1] === 113 &&
            data[offset + 2] === 194 &&
            data[offset + 3] === 255
          )
            blueRows.push(y);
          if (data[offset + 3] > 128 && data[offset] < 128) ink++;
        }
        if (!ink) continue;
        if (y - lastInkRow > 10) bands.push([]);
        bands.at(-1)!.push(ink);
        lastInkRow = y;
      }
      const countBands = (rows: number[]) =>
        rows.filter((y, index) => index === 0 || y - rows[index - 1] > 10)
          .length;
      return {
        bands,
        redBands: countBands(redRows),
        blueBands: countBands(blueRows),
      };
    }, png.toString("base64"));
    expect(inkBands.bands).toHaveLength(families.length);
    expect(inkBands.redBands).toBe(families.length);
    expect(inkBands.blueBands).toBe(families.length);
    expect(new Set(inkBands.bands.map((band) => band.join(","))).size).toBe(
      families.length,
    );
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});

test("keyboard shortcuts toggle formatting on a selected text element", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, { name: "Text selection E2E" });
  try {
    await page.goto(`/editor/${drawing.id}`);
    await expect(
      page.getByRole("heading", { name: drawing.name }),
    ).toBeVisible();
    const canvas = page.locator("canvas.excalidraw__canvas.interactive");
    const editor = page.locator(".excalidraw-wysiwyg");
    const format = page.getByRole("group", { name: "Text formatting" });
    const bold = format.getByRole("button", { name: "Bold" });
    await canvas.click({ position: { x: 410, y: 280 } });
    await page.keyboard.press("t");
    await canvas.click({ position: { x: 450, y: 300 } });
    await editor.fill("Mixed format");
    await editor.evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 0);
      range.setEnd(element.firstChild!, 5);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await editor.press("ControlOrMeta+b");
    await expect(editor.getByText("Mixed", { exact: true })).toHaveCSS(
      "font-weight",
      "700",
    );
    await editor.press("Escape");

    await canvas.click({ position: { x: 410, y: 280 } });
    await canvas.click({ position: { x: 470, y: 312 } });
    await expect(editor).toBeHidden();
    await expect(bold).toHaveAttribute("aria-pressed", "mixed");

    for (const [key, label] of [
      ["b", "Bold"],
      ["i", "Italic"],
      ["u", "Underline"],
      ["Shift+s", "Strikethrough"],
    ]) {
      const button = format.getByRole("button", { name: label });
      await page.keyboard.press(`ControlOrMeta+${key}`);
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press(`ControlOrMeta+${key}`);
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await page.keyboard.press(`ControlOrMeta+${key}`);
      await expect(button).toHaveAttribute("aria-pressed", "true");
    }
    await expect
      .poll(async () =>
        (await getDrawing(request, drawing.id)).elements?.find(
          (element) => element.type === "text",
        ),
      )
      .toMatchObject({
        text: "Mixed format",
        textRuns: [],
        textFormatting: {
          weight: 700,
          italic: true,
          underline: true,
          strikethrough: true,
        },
      });
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});

test("keyboard shortcuts and toolbar apply only to selected letters and words", async ({
  page,
  request,
}) => {
  const drawing = await createDrawing(request, { name: "Rich text E2E" });
  const sample = "Alpha Beta Gamma";
  const editor = page.locator(".excalidraw-wysiwyg");
  const select = (start: number, end: number) =>
    editor.evaluate(
      (root, [start, end]) => {
        const locate = (offset: number): [Node, number] => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            const length = node.textContent?.length ?? 0;
            if (offset <= length) return [node, offset];
            offset -= length;
            node = walker.nextNode();
          }
          throw new Error("Selection is outside the text");
        };
        const range = document.createRange();
        range.setStart(...locate(start));
        range.setEnd(...locate(end));
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      },
      [start, end],
    );
  const saved = async () =>
    (await getDrawing(request, drawing.id)).elements?.find(
      (element) => element.type === "text",
    );
  try {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, "showOpenFilePicker");
      Reflect.deleteProperty(window, "showSaveFilePicker");
    });
    await page.goto(`/editor/${drawing.id}`);
    await expect(
      page.getByRole("heading", { name: drawing.name }),
    ).toBeVisible();
    const canvas = page.locator("canvas.excalidraw__canvas.interactive");
    await canvas.click({ position: { x: 410, y: 280 } });
    await page.keyboard.press("t");
    await canvas.click({ position: { x: 450, y: 300 } });
    await editor.fill(sample);

    await select(0, 5);
    await editor.press("ControlOrMeta+b");
    await expect(editor.getByText("Alpha", { exact: true })).toHaveCSS(
      "font-weight",
      "700",
    );
    await select(6, 10);
    await editor.press("ControlOrMeta+i");
    await expect(editor.getByText("Beta", { exact: true })).toHaveCSS(
      "font-style",
      "italic",
    );
    await select(1, 4);
    await editor.press("ControlOrMeta+u");
    await expect(editor.getByText("lph", { exact: true })).toHaveCSS(
      "text-decoration-line",
      "underline",
    );
    await select(11, 16);
    await editor.press("ControlOrMeta+Shift+s");
    await expect(editor.getByText("Gamma", { exact: true })).toHaveCSS(
      "text-decoration-line",
      "line-through",
    );

    await select(0, 1);
    await page
      .getByRole("group", { name: "Text formatting" })
      .getByRole("button", { name: "Bold" })
      .click();
    await expect(editor.getByText("A", { exact: true })).toHaveCSS(
      "font-weight",
      "400",
    );
    await select(0, 0);
    await editor.press("X");
    await select(0, 0);
    await editor.press("ControlOrMeta+i");
    await editor.press("Y");
    await expect(editor.getByText("Y", { exact: true })).toHaveCSS(
      "font-style",
      "italic",
    );
    await editor.press("Escape");

    await expect.poll(saved).toMatchObject({
      text: "YX" + sample,
      textRuns: [
        { start: 0, end: 1, style: { italic: true } },
        { start: 3, end: 6, style: { weight: 700, underline: true } },
        { start: 6, end: 7, style: { weight: 700 } },
        { start: 8, end: 12, style: { italic: true } },
        { start: 13, end: 18, style: { strikethrough: true } },
      ],
    });
    await page.reload();
    await page.getByTestId("main-menu-trigger").click();
    await page.getByTestId("image-export-button").click();
    const svgDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByRole("button", { name: "Export to SVG" }).click();
    const svg = await readFile((await (await svgDownload).path())!, "utf8");
    expect(svg).toMatch(
      /<tspan font-weight="700" font-style="normal" text-decoration="underline">lph<\/tspan>/,
    );
    expect(svg).toMatch(
      /<tspan font-weight="400" font-style="italic">Beta<\/tspan>/,
    );
    expect(svg).toMatch(
      /<tspan[^>]+text-decoration="line-through">Gamma<\/tspan>/,
    );
    const pngDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByRole("button", { name: "Export to PNG" }).click();
    const png = await readFile((await (await pngDownload).path())!);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});
