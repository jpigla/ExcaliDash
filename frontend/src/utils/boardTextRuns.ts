type TextStyle = {
  weight: 400 | 700;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  color?: string;
};
type Overrides = Partial<TextStyle>;

type TextRun = {
  start: number;
  end: number;
  style: Overrides;
};
type TextSource = {
  originalText: string;
  textRuns?: TextRun[];
};
type Segment = { text: string; style: Overrides };

const styleKeys = [
  "weight",
  "italic",
  "underline",
  "strikethrough",
  "color",
] as const;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function isTextRunColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:transparent|#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8}))$/i.test(value)
  );
}

function normalizedStyle(style: Overrides | undefined): Overrides {
  const result: Overrides = {};
  if (style?.weight === 400 || style?.weight === 700) {
    result.weight = style.weight;
  }
  for (const key of ["italic", "underline", "strikethrough"] as const) {
    if (typeof style?.[key] === "boolean") result[key] = style[key];
  }
  if (isTextRunColor(style?.color)) result.color = style.color.toLowerCase();
  return result;
}

function appendRun(
  runs: TextRun[],
  start: number,
  end: number,
  style: Overrides,
) {
  if (start >= end || Object.keys(style).length === 0) return;
  const last = runs.at(-1);
  if (
    last?.end === start &&
    styleKeys.every((key) => last.style[key] === style[key])
  ) {
    last.end = end;
  } else {
    runs.push({ start, end, style });
  }
}

export function safeTextRuns(source: TextSource): TextRun[] {
  if (!Array.isArray(source.textRuns)) return [];
  const result: TextRun[] = [];
  for (const run of source.textRuns.slice(0, 200000)) {
    if (!run || !Number.isInteger(run.start) || !Number.isInteger(run.end))
      continue;
    const start = Math.max(0, result.at(-1)?.end ?? 0, run.start);
    appendRun(
      result,
      start,
      Math.min(source.originalText.length, run.end),
      normalizedStyle(run.style),
    );
  }
  return result;
}

function segments(text: string, runs: TextRun[], offset: number): Segment[] {
  const end = offset + text.length;
  const result: Segment[] = [];
  let at = offset;
  // Wrapped lines share the same sorted spans. Seek the first intersecting run.
  let left = 0;
  let right = runs.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (runs[mid].end <= at) left = mid + 1;
    else right = mid;
  }
  for (
    let index = left;
    index < runs.length && runs[index].start < end;
    index++
  ) {
    const run = runs[index];
    if (at < run.start)
      result.push({
        text: text.slice(at - offset, run.start - offset),
        style: {},
      });
    const next = Math.min(run.end, end);
    result.push({
      text: text.slice(Math.max(at, run.start) - offset, next - offset),
      style: run.style,
    });
    at = next;
  }
  if (at < end) result.push({ text: text.slice(at - offset), style: {} });
  return result;
}

export function boardTextLines(source: TextSource, text: string): Segment[][] {
  const runs = safeTextRuns(source);
  let offset = 0;
  return text.split("\n").map((line) => {
    const found = source.originalText.indexOf(line, offset);
    if (found >= 0) offset = found;
    const lineSegments = segments(line, runs, offset);
    offset += line.length;
    if (source.originalText[offset] === "\n") offset++;
    return lineSegments;
  });
}

export function wrapBoardText(
  source: TextSource,
  width: number,
  measure: (segment: Segment) => number,
): string {
  const text = source.originalText;
  if (!Number.isFinite(width) || width < 0) return text;
  const runs = safeTextRuns(source);
  const lines: string[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    const measureSlice = (start: number, end: number) =>
      segments(text.slice(start, end), runs, start).reduce(
        (sum, segment) => sum + measure(segment),
        0,
      );
    if (measureSlice(offset, lineEnd) <= width) {
      lines.push(line);
      offset = lineEnd + 1;
      continue;
    }
    let start = offset;
    let end = offset;
    for (const match of line.matchAll(/\s+|[^\s]+/gu)) {
      const tokenStart = offset + match.index;
      const tokenEnd = tokenStart + match[0].length;
      if (/^\s/u.test(match[0])) {
        end = tokenEnd;
        continue;
      }
      if (measureSlice(start, tokenEnd) > width && tokenStart > start) {
        lines.push(text.slice(start, tokenStart).trimEnd());
        start = tokenStart;
      }
      if (measureSlice(start, tokenEnd) > width) {
        for (const part of graphemes.segment(match[0])) {
          const boundary = tokenStart + part.index;
          if (
            boundary > start &&
            measureSlice(start, boundary + part.segment.length) > width
          ) {
            lines.push(text.slice(start, boundary));
            start = boundary;
          }
        }
      }
      end = tokenEnd;
    }
    lines.push(text.slice(start, end).trimEnd());
    offset = lineEnd + 1;
  }
  return lines.join("\n");
}

export function stylesInRange(source: TextSource, start: number, end: number) {
  return segments(
    source.originalText.slice(start, end),
    safeTextRuns(source),
    start,
  );
}

export function setRangeStyle(
  source: TextSource,
  start: number,
  end: number,
  change: Overrides,
  base: TextStyle,
) {
  if (start >= end) return safeTextRuns(source);
  // Selection indices use UTF-16, as do scene offsets. Expand accidental
  // half-selections to whole graphemes before persisting the boundaries.
  const boundaries = graphemes.segment(source.originalText);
  start = boundaries.containing(start)?.index ?? start;
  const last = boundaries.containing(end - 1);
  if (last) end = last.index + last.segment.length;
  const output: TextRun[] = [];
  const runs = safeTextRuns(source);
  let offset = 0;
  for (const piece of segments(source.originalText, runs, 0)) {
    const next = offset + piece.text.length;
    appendRun(output, offset, Math.min(next, start), piece.style);
    if (next > start && offset < end) {
      const style = { ...piece.style, ...change };
      for (const key of styleKeys)
        if (style[key] === base[key]) delete style[key];
      appendRun(output, Math.max(offset, start), Math.min(next, end), style);
    }
    appendRun(output, Math.max(offset, end), next, piece.style);
    offset = next;
  }
  return output;
}

export function clearStyleOverrides(source: TextSource, change: Overrides) {
  const result: TextRun[] = [];
  for (const run of safeTextRuns(source)) {
    const style = { ...run.style };
    for (const key of styleKeys) if (key in change) delete style[key];
    appendRun(result, run.start, run.end, style);
  }
  return result;
}

export function moveTextRuns(
  source: TextSource,
  next: string,
  selectionStart?: number,
) {
  const before = source.originalText;
  const runs = safeTextRuns(source);
  if (before === next || runs.length === 0) return runs;
  let start = 0;
  while (
    start < before.length &&
    start < next.length &&
    before[start] === next[start] &&
    (selectionStart === undefined || start < selectionStart)
  )
    start++;
  let oldEnd = before.length;
  let newEnd = next.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    before[oldEnd - 1] === next[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const result: TextRun[] = [];
  const delta = newEnd - oldEnd;
  for (const run of runs)
    appendRun(result, run.start, Math.min(run.end, start), run.style);
  const inherited = runs.find((run) => run.start <= start && start < run.end);
  if (inherited) appendRun(result, start, newEnd, inherited.style);
  for (const run of runs) {
    appendRun(
      result,
      Math.max(run.start, oldEnd) + delta,
      run.end + delta,
      run.style,
    );
  }
  return result;
}

type Editor = HTMLDivElement & {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  select(): void;
  setSelectionRange(start: number, end: number): void;
  rememberSelection(): void;
  renderRuns(source: TextSource, base: TextStyle): void;
  lastInputStart?: number;
  lastInputEnd?: number;
  pendingFormatting?: { offset: number; style: Overrides };
};
export const activeTextEditors = new WeakMap<object, Editor>();

export function createBoardTextEditor(): Editor {
  const editor = document.createElement("div") as Editor;
  editor.contentEditable = "plaintext-only";
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-multiline", "true");
  let selectionStart = 0;
  let selectionEnd = 0;
  let rendered: { text: string; runs: string } | undefined;
  const value = () =>
    Array.from(editor.childNodes).some(
      (node) => node instanceof HTMLBRElement || node instanceof HTMLDivElement,
    )
      ? editor.innerText
      : (editor.textContent ?? "");

  function offsets() {
    const selection = document.getSelection();
    if (selection?.rangeCount) {
      const current = selection.getRangeAt(0);
      if (
        editor.contains(current.startContainer) &&
        editor.contains(current.endContainer)
      ) {
        const start = document.createRange();
        start.selectNodeContents(editor);
        start.setEnd(current.startContainer, current.startOffset);
        selectionStart = start.toString().length;
        start.setEnd(current.endContainer, current.endOffset);
        selectionEnd = start.toString().length;
      }
    }
    return [selectionStart, selectionEnd] as const;
  }

  editor.setSelectionRange = (start, end) => {
    selectionStart = Math.max(0, start);
    selectionEnd = Math.max(selectionStart, end);
    if (!editor.isConnected || document.activeElement !== editor) return;
    const range = document.createRange();
    const locate = (offset: number): [Node, number] => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let last: Node = editor;
      while (node) {
        const size = node.textContent?.length ?? 0;
        if (offset <= size) return [node, offset];
        offset -= size;
        last = node;
        node = walker.nextNode();
      }
      return [last, last === editor ? 0 : (last.textContent?.length ?? 0)];
    };
    range.setStart(...locate(selectionStart));
    range.setEnd(...locate(selectionEnd));
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  editor.select = () => editor.setSelectionRange(0, value().length);
  editor.rememberSelection = () => {
    offsets();
  };
  Object.defineProperties(editor, {
    value: {
      get: value,
      set: (text: string) => {
        rendered = undefined;
        editor.textContent = text;
      },
    },
    selectionStart: {
      get: () => offsets()[0],
      set: (start: number) =>
        editor.setSelectionRange(start, Math.max(start, selectionEnd)),
    },
    selectionEnd: {
      get: () => offsets()[1],
      set: (end: number) =>
        editor.setSelectionRange(Math.min(selectionStart, end), end),
    },
  });
  let composing = false;
  editor.addEventListener("compositionstart", () => {
    composing = true;
  });
  editor.addEventListener("compositionend", () => {
    composing = false;
    editor.dispatchEvent(new Event("input"));
  });
  editor.addEventListener("beforeinput", () => {
    [editor.lastInputStart, editor.lastInputEnd] = offsets();
  });
  editor.addEventListener("focus", () =>
    editor.setSelectionRange(selectionStart, selectionEnd),
  );
  editor.renderRuns = (source, base) => {
    if (composing) return;
    const text = source.originalText;
    const runs = safeTextRuns(source);
    const key = JSON.stringify(runs.length ? [runs, base] : runs);
    if (rendered?.text === text && rendered.runs === key && value() === text)
      return;
    // Keep native editing intact for unformatted text.
    if (
      runs.length === 0 &&
      value() === text &&
      !editor.querySelector("span")
    ) {
      rendered = { text, runs: key };
      return;
    }
    const [start, end] = offsets();
    const fragment = document.createDocumentFragment();
    for (const { text: part, style } of segments(text, runs, 0)) {
      if (!runs.length) {
        fragment.append(document.createTextNode(part));
        continue;
      }
      const effective = { ...base, ...style };
      const span = document.createElement("span");
      span.textContent = part;
      span.style.fontWeight = String(effective.weight);
      span.style.fontStyle = effective.italic ? "italic" : "normal";
      if (style.color) span.style.color = style.color;
      const decoration = [
        effective.underline && "underline",
        effective.strikethrough && "line-through",
      ]
        .filter(Boolean)
        .join(" ");
      if (decoration) span.style.textDecoration = decoration;
      fragment.append(span);
    }
    editor.replaceChildren(fragment);
    rendered = { text, runs: key };
    editor.setSelectionRange(start, end);
  };
  return editor;
}
