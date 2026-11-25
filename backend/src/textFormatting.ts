import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const textFormattingSchema = z.object({
  weight: z.union([z.literal(300), z.literal(400), z.literal(700)]).optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
});

type BoardFont = {
  id: number;
  name: string;
  slug: string;
  weights: number[];
  metrics: {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    lineHeight: number;
  };
};

const assetDirectory = resolve(__dirname, "../assets/board-fonts");
export const boardFonts: BoardFont[] = JSON.parse(
  readFileSync(resolve(assetDirectory, "catalog.json"), "utf8"),
);
export const boardFontById = new Map(boardFonts.map((font) => [font.id, font]));
export const boardFontFiles = boardFonts.flatMap(({ slug, weights }) =>
  weights.map((weight) => resolve(assetDirectory, `${slug}-${weight}.ttf`)),
);
