import { expect, it } from "vitest";
import { sanitizeSvg } from "../security";
import { boardFonts } from "../textFormatting";
import { changeElements, summarize } from "./elements";
import { renderScene } from "./render";

it("renders real cuts, synthesized styles, and decorations in MCP PNGs", () => {
  const text = "Grüße – Board";
  const render = (fontFamily: number, textFormatting = {}, label = text) => {
    const [element] = changeElements(
      [],
      [
        {
          op: "add",
          element: {
            type: "text",
            text: label,
            fontFamily,
            textFormatting,
            fontSize: 36,
            x: 0,
            y: 0,
          },
        },
      ],
    ).elements;
    expect(summarize(element)).toMatchObject({ fontFamily, textFormatting });
    return renderScene([element], [-10, -10, 450, 100]).data;
  };
  const blank = render(101, {}, "");
  const images = new Set(boardFonts.map(({ id }) => render(id)));
  expect(images).toHaveLength(boardFonts.length);
  expect(images).not.toContain(blank);

  const regular = render(101);
  expect(render(101, { weight: 300 })).not.toBe(regular);
  expect(render(101, { weight: 700 })).not.toBe(regular);
  for (const format of [
    { italic: true },
    { underline: true },
    { strikethrough: true },
  ]) {
    expect(render(101, format)).not.toBe(regular);
  }
  expect(render(103, { weight: 700 })).not.toBe(render(103));
});

it("keeps formatting attributes in saved dashboard previews", () => {
  const svg = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg">
    <style>@font-face { font-family: Kalam; src: url(https://example.com/font) }</style>
    <text font-family="Kalam" font-style="italic" font-weight="700" text-decoration="underline line-through">Text</text>
  </svg>`);
  for (const attr of [
    'font-family="Kalam"',
    'font-style="italic"',
    'font-weight="700"',
    'text-decoration="underline line-through"',
  ])
    expect(svg).toContain(attr);
  expect(svg).not.toContain("<style");
});

it("updates one formatting field without resetting the others", () => {
  const [before] = changeElements(
    [],
    [
      {
        op: "add",
        element: {
          type: "text",
          text: "Example",
          fontFamily: 101,
          textFormatting: { weight: 300, italic: true },
          x: 0,
          y: 0,
        },
      },
    ],
  ).elements;
  const [after] = changeElements(
    [before],
    [
      {
        op: "update",
        id: before.id,
        changes: { textFormatting: { underline: true } },
      },
    ],
  ).elements;
  expect(after).toMatchObject({
    fontFamily: 101,
    textFormatting: { weight: 300, italic: true, underline: true },
  });
});
