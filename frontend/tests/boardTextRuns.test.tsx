import { describe, expect, it } from "vitest";
import {
  boardTextLines,
  clearStyleOverrides,
  moveTextRuns,
  setRangeStyle,
  wrapBoardText,
} from "../src/utils/boardTextRuns";

const base = {
  weight: 400,
  italic: false,
  underline: false,
  strikethrough: false,
} as const;

describe("board text runs", () => {
  it("preserves whole graphemes and supports an override of the element style", () => {
    const originalText = "a👩‍💻b";
    const textRuns = setRangeStyle(
      { originalText },
      2,
      3,
      { underline: false },
      { ...base, underline: true },
    );
    expect(textRuns).toEqual([
      { start: 1, end: originalText.length - 1, style: { underline: false } },
    ]);
    expect(
      boardTextLines({ originalText, textRuns }, originalText)[0].map(
        (segment) => segment.text,
      ),
    ).toEqual(["a", "👩‍💻", "b"]);
  });

  it("maps partial formatting through styled line wrapping and text edits", () => {
    const originalText = "one two three";
    const textRuns = [{ start: 4, end: 7, style: { weight: 700 } }] as const;
    const source = { originalText, textRuns: [...textRuns] };
    const text = wrapBoardText(
      source,
      6,
      ({ text, style }) => text.length * (style.weight === 700 ? 2 : 1),
    );
    expect(text).toBe("one\ntwo\nthree");
    expect(boardTextLines(source, text)[1]).toEqual([
      { text: "two", style: { weight: 700 } },
    ]);
    expect(moveTextRuns(source, "one new two three", 4)).toEqual([
      { start: 4, end: 11, style: { weight: 700 } },
    ]);
  });

  it("changes and clears text colors independently of other formatting", () => {
    const originalText = "Grüße";
    const source = {
      originalText,
      textRuns: [{ start: 0, end: 5, style: { italic: true } }],
    };
    const textRuns = setRangeStyle(
      source,
      2,
      3,
      { color: "#1971c2" },
      { ...base, color: "#1e1e1e" },
    );
    expect(boardTextLines({ originalText, textRuns }, originalText)[0]).toEqual(
      [
        { text: "Gr", style: { italic: true } },
        { text: "ü", style: { italic: true, color: "#1971c2" } },
        { text: "ße", style: { italic: true } },
      ],
    );
    expect(
      clearStyleOverrides({ originalText, textRuns }, { color: "#1e1e1e" }),
    ).toEqual(source.textRuns);
  });
});
