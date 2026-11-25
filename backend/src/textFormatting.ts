import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const textFormattingSchema = z.object({
  weight: z.union([z.literal(400), z.literal(700)]).optional(),
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

export const textRunsSchema = z
  .array(
    z.object({
      start: z.number().int().nonnegative().max(200_000),
      end: z.number().int().positive().max(200_000),
      style: textFormattingSchema,
    }),
  )
  .max(200_000)
  .refine((runs) =>
    runs.every(
      (run, index) =>
        run.end > run.start &&
        (index === 0 || runs[index - 1].end <= run.start),
    ),
  );

export function styledTextLines(
  text: string,
  original: string,
  runs: z.infer<typeof textRunsSchema>,
) {
  let offset = 0;
  let index = 0;
  return text.split("\n").map((line) => {
    const found = original.indexOf(line, offset);
    if (found !== -1) offset = found;
    const end = offset + line.length;
    while (index < runs.length && runs[index].end <= offset) index++;
    const pieces: {
      text: string;
      style: z.infer<typeof textFormattingSchema>;
    }[] = [];
    let cursor = offset;
    for (let i = index; i < runs.length && runs[i].start < end; i++) {
      const run = runs[i];
      if (cursor < run.start)
        pieces.push({
          text: line.slice(cursor - offset, run.start - offset),
          style: {},
        });
      cursor = Math.max(cursor, run.start);
      const stop = Math.min(run.end, end);
      if (cursor < stop)
        pieces.push({
          text: line.slice(cursor - offset, stop - offset),
          style: run.style,
        });
      cursor = stop;
    }
    if (cursor < end)
      pieces.push({ text: line.slice(cursor - offset), style: {} });
    offset = end + (original[end] === "\n" ? 1 : 0);
    return pieces;
  });
}
