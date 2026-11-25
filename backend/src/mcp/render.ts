import { Resvg } from "@resvg/resvg-js";
import { type Element } from "./elements";
import type { SceneBounds } from "../server/sceneBounds";
import {
  boardFontById,
  boardFontFiles,
  textFormattingSchema,
  textRunsSchema,
  styledTextLines,
} from "../textFormatting";

const escape = (value: string) =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
const number = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(-1_000_000, Math.min(1_000_000, value))
    : fallback;
const paint = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value)
    ? value
    : fallback;

function points(element: Element): [number, number][] {
  if (!Array.isArray(element.points)) return [];
  return element.points
    .slice(0, 400)
    .flatMap((point) =>
      Array.isArray(point) && point.length >= 2
        ? [[number(point[0]), number(point[1])] as [number, number]]
        : [],
    );
}

const fallbackFamily =
  process.platform === "darwin" ? "Helvetica" : "DejaVu Sans";

function draw(element: Element): string {
  const width = Math.max(0, number(element.width));
  const height = Math.max(0, number(element.height));
  const stroke = paint(element.strokeColor, "#1e1e1e");
  const fill = paint(element.backgroundColor, "none");
  const style = `stroke="${stroke}" fill="${fill}" stroke-width="${Math.max(1, Math.min(8, number(element.strokeWidth, 2)))}"`;
  if (element.type === "ellipse")
    return `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" ${style}/>`;
  if (element.type === "diamond")
    return `<polygon points="${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}" ${style}/>`;
  if (element.type === "text") {
    const fontSize = Math.min(128, Math.max(8, number(element.fontSize, 20)));
    const lines =
      typeof element.text === "string"
        ? element.text.slice(0, 2000).split("\n").slice(0, 60)
        : [];
    const font = boardFontById.get(Number(element.fontFamily));
    const parsed = textFormattingSchema.safeParse(element.textFormatting);
    const format = parsed.success ? parsed.data : {};
    const weight = format.weight ?? 400;
    const decoration = [
      format.underline && "underline",
      format.strikethrough && "line-through",
    ]
      .filter(Boolean)
      .join(" ");
    const align =
      element.textAlign === "center"
        ? "middle"
        : element.textAlign === "right"
          ? "end"
          : "start";
    const x = align === "middle" ? width / 2 : align === "end" ? width : 0;
    const lineHeight =
      fontSize * number(element.lineHeight, font?.metrics.lineHeight ?? 1.25);
    const baseline = font
      ? lineHeight / 2 +
        (fontSize * (font.metrics.ascender + font.metrics.descender)) /
          (2 * font.metrics.unitsPerEm)
      : fontSize;
    const family = font
      ? ` font-family="${escape(font.name)}, ${fallbackFamily}"`
      : "";
    // Resvg selects real faces when available. Emulate oblique and missing
    // bold cuts because its SVG renderer has no browser font synthesis.
    const syntheticBold = weight === 700 && font && !font.weights.includes(700);
    const bold = syntheticBold
      ? ` stroke="${stroke}" stroke-width="${fontSize / 30}"`
      : "";
    const rich = textRunsSchema.safeParse(element.textRuns);
    if (
      rich.success &&
      rich.data.length &&
      typeof element.originalText === "string"
    ) {
      return styledTextLines(lines.join("\n"), element.originalText, rich.data)
        .map((pieces, index) => {
          const body = pieces
            .map((piece) => {
              const run = { ...format, ...piece.style };
              const weight = run.weight ?? 400;
              const decoration = [
                run.underline && "underline",
                run.strikethrough && "line-through",
              ]
                .filter(Boolean)
                .join(" ");
              const synth =
                weight === 700 && font && !font.weights.includes(700);
              const color = run.color === "transparent" ? "none" : run.color;
              return `<tspan font-weight="${synth ? 400 : weight}" font-style="${run.italic ? "italic" : "normal"}"${decoration ? ` text-decoration="${decoration}"` : ""}${color ? ` fill="${color}"` : ""}${synth ? ` stroke="${color ?? stroke}" stroke-width="${fontSize / 30}"` : ""}>${escape(piece.text)}</tspan>`;
            })
            .join("");
          return `<text x="${x}" y="${baseline + index * lineHeight}"${family} font-size="${fontSize}" text-anchor="${align}" fill="${stroke}" xml:space="preserve">${body}</text>`;
        })
        .join("");
    }
    return lines
      .map((line, index) => {
        const y = baseline + index * lineHeight;
        const tilt = !format.italic
          ? ""
          : font?.italic
            ? ' font-style="italic"'
            : ` transform="translate(${y * 0.22} 0) skewX(-12.4074)"`;
        const mode = decoration ? ` text-decoration="${decoration}"` : "";
        return `<text x="${x}" y="${y}"${family} font-size="${fontSize}" text-anchor="${align}" font-weight="${syntheticBold ? 400 : weight}" fill="${stroke}"${bold}${mode}${tilt}>${escape(line)}</text>`;
      })
      .join("");
  }
  if (["arrow", "line", "freedraw"].includes(element.type)) {
    const path = points(element);
    if (path.length < 2) return "";
    const [x, y] = path[path.length - 1];
    const [fromX, fromY] = path[path.length - 2];
    const angle = (Math.atan2(y - fromY, x - fromX) * 180) / Math.PI;
    const arrow =
      element.type === "arrow" && element.endArrowhead !== null
        ? `<path d="M -12 -6 L 0 0 L -12 6" transform="translate(${x} ${y}) rotate(${angle})" stroke="${stroke}" stroke-width="2" fill="none"/>`
        : "";
    return `<polyline points="${path.map((point) => point.join(",")).join(" ")}" stroke="${stroke}" stroke-width="2" fill="none"/>${arrow}`;
  }
  const label =
    element.type === "frame"
      ? element.name
      : element.type === "rectangle"
        ? undefined
        : `[${element.type}]`;
  const outline = element.type === "frame" ? 'stroke-dasharray="6 4"' : "";
  return (
    `<rect width="${width}" height="${height}" ${style} ${outline}/>` +
    (typeof label === "string"
      ? `<text x="4" y="16" font-size="13" fill="${stroke}">${escape(label.slice(0, 120))}</text>`
      : "")
  );
}

export function renderScene(elements: Element[], bounds?: SceneBounds) {
  // A schematic image built entirely from local geometry. Existing images and
  // embeds are represented by their bounds and are never loaded by the renderer.
  let shown = 0;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const geometry: string[] = [];
  for (const element of elements) {
    if (shown === 500) break;
    const x = number(element.x),
      y = number(element.y);
    const width = Math.max(0, number(element.width)),
      height = Math.max(0, number(element.height));
    const angle = (number(element.angle) * 180) / Math.PI;
    const rotationPad = angle ? Math.hypot(width, height) / 2 : 0;
    const path = ["arrow", "line", "freedraw"].includes(element.type)
      ? points(element)
      : [];
    const elementLeft = Math.min(
      x - rotationPad,
      ...path.map(([dx]) => x + dx),
    );
    const elementTop = Math.min(
      y - rotationPad,
      ...path.map(([, dy]) => y + dy),
    );
    const elementRight = Math.max(
      x + width + rotationPad,
      ...path.map(([dx]) => x + dx),
    );
    const elementBottom = Math.max(
      y + height + rotationPad,
      ...path.map(([, dy]) => y + dy),
    );
    if (
      bounds &&
      (elementRight < bounds[0] ||
        elementBottom < bounds[1] ||
        elementLeft > bounds[2] ||
        elementTop > bounds[3])
    )
      continue;
    left = Math.min(left, elementLeft);
    top = Math.min(top, elementTop);
    right = Math.max(right, elementRight);
    bottom = Math.max(bottom, elementBottom);
    geometry.push(
      `<g transform="translate(${x} ${y}) rotate(${angle} ${width / 2} ${height / 2})">${draw(element)}</g>`,
    );
    shown++;
  }
  if (!shown) [left, top, right, bottom] = [0, 0, 160, 90];
  const [x, y, maxX, maxY] = bounds ?? [
    left - 24,
    top - 24,
    right + 24,
    bottom + 24,
  ];
  const width = maxX - x,
    height = maxY - y;
  const scale = Math.min(1.5, 1280 / Math.max(width, height));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.ceil(width * scale))}" height="${Math.max(1, Math.ceil(height * scale))}" viewBox="${x} ${y} ${width} ${height}"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="white"/>${geometry.join("")}</svg>`;
  const png = new Resvg(svg, {
    font: {
      defaultFontFamily: fallbackFamily,
      fontFiles: boardFontFiles,
    },
  })
    .render()
    .asPng();
  return {
    data: png.toString("base64"),
    elementCount: elements.length,
    shown,
  };
}
