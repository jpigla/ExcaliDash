import { expect, it } from "vitest";
import { sanitizeSvg } from "../security";
import { boardFonts, textFormattingSchema } from "../textFormatting";
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
  expect(textFormattingSchema.safeParse({ weight: 300 }).success).toBe(false);
  for (const { id, weights, italic } of boardFonts) {
    if (weights.includes(700))
      expect(render(id, { weight: 700 })).not.toBe(render(id));
    if (italic)
      expect(render(id, { weight: 700, italic: true })).not.toBe(
        render(id, { weight: 700 }),
      );
  }
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
          textFormatting: { weight: 700, italic: true },
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
    textFormatting: { weight: 700, italic: true, underline: true },
  });
});

it("renders selectively styled words in MCP previews and preserves SVG spans", () => {
  const [plain] = changeElements(
    [],
    [
      {
        op: "add",
        element: {
          type: "text",
          text: "First word",
          fontFamily: 101,
          x: 5,
          y: 5,
          fontSize: 36,
        },
      },
    ],
  ).elements;
  const rich = {
    ...plain,
    textRuns: [{ start: 6, end: 10, style: { weight: 700, underline: true } }],
  };
  expect(renderScene([rich]).data).not.toBe(renderScene([plain]).data);
  const colored = {
    ...rich,
    textRuns: [
      {
        start: 6,
        end: 10,
        style: { weight: 700, underline: true, color: "#b00022" },
      },
    ],
  };
  expect(renderScene([colored]).data).not.toBe(renderScene([rich]).data);
  expect(
    sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><text xml:space="preserve">First <tspan text-decoration="underline" fill="#b00022">word</tspan></text></svg>',
    ),
  ).toContain('<tspan text-decoration="underline" fill="#b00022">word</tspan>');
});
