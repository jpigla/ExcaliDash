import { readFile } from "node:fs/promises";
import { patchZoom } from "./excalidrawZoom";
import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin as VitePlugin } from "vite";

type FontCatalog = ReadonlyArray<{
  id: number;
  name: string;
  slug: string;
  weights: number[];
  italic?: boolean;
  metrics: {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    lineHeight: number;
  };
}>;

function boardFontFaces({ slug, weights, italic }: FontCatalog[number]) {
  const styles = italic ? ["normal", "italic"] : ["normal"];
  return weights.flatMap((weight) =>
    styles.map((style) => ({
      weight,
      style,
      file: `${slug}-${weight}${style === "italic" ? "-italic" : ""}.woff2`,
    })),
  );
}

// Use the readable distribution of the pinned Excalidraw version in both builds.
// Require the expected source at every integration point on dependency upgrades.
const bundles =
  /[/\\]@excalidraw[/\\]excalidraw[/\\]dist[/\\]dev[/\\](index|chunk-4FTI6OG3)\.js$/;

function replace(source: string, original: string, replacement: string) {
  const start = source.indexOf(original);
  if (start < 0 || start !== source.lastIndexOf(original)) {
    throw new Error(
      `ExcaliDash typography patch expected one occurrence of ${original}`,
    );
  }
  return (
    source.slice(0, start) + replacement + source.slice(start + original.length)
  );
}

function patchCore(source: string, catalog: FontCatalog, runsModule: string) {
  const fonts = catalog.map((font) => ({
    ...font,
    faces: boardFontFaces(font),
  }));
  source =
    `import { boardTextLines, wrapBoardText, safeTextRuns } from ${JSON.stringify(runsModule)};\n` +
    source;
  source = replace(
    source,
    "var FONT_FAMILY = {",
    `var boardFonts = ${JSON.stringify(fonts)};
var hasNativeBoldFace = (family) => boardFonts.some((font) => font.id === family && font.weights.includes(700));
var getTextFormatting = (element) => {
  const format = element?.textFormatting;
  return {
    weight: format?.weight === 700 ? 700 : 400,
    italic: format?.italic === true,
    underline: format?.underline === true,
    strikethrough: format?.strikethrough === true
  };
};
var getTextDecoration = ({ underline, strikethrough }) =>
  [underline && "underline", strikethrough && "line-through"].filter(Boolean).join(" ");
var FONT_FAMILY = {
  ...Object.fromEntries(boardFonts.map(({ name, id }) => [name, id])),`,
  );
  source = replace(
    source,
    "var getFontFamilyFallbacks = (fontFamily) => {",
    `var getFontFamilyFallbacks = (fontFamily) => {
  if (boardFonts.some(({ id }) => id === fontFamily)) {
    return ["Nunito", "sans-serif", WINDOWS_EMOJI_FALLBACK_FONT];
  }`,
  );
  source = replace(
    source,
    `var getFontString = ({
  fontSize,
  fontFamily
}) => {
  return \`\${fontSize}px \${getFontFamilyString({ fontFamily })}\`;
};`,
    `var getFontString = (element) => {
  const { fontSize, fontFamily } = element;
  const { weight, italic } = getTextFormatting(element);
  return (italic ? "italic " : "") + (weight === 400 ? "" : weight + " ") +
    fontSize + "px " + getFontFamilyString({ fontFamily });
};`,
  );
  source = replace(
    source,
    "    currentItemFontFamily: DEFAULT_FONT_FAMILY,",
    `    currentItemFontFamily: DEFAULT_FONT_FAMILY,
    currentItemTextFormatting: undefined,`,
  );
  source = replace(
    source,
    "  currentItemFontFamily: { browser: true, export: false, server: false },",
    `  currentItemFontFamily: { browser: true, export: false, server: false },
  currentItemTextFormatting: { browser: false, export: false, server: false },`,
  );
  // Canvas shorthand can begin with a style or a weight. Text geometry
  // must use its pixel size, regardless of which modifiers precede it.
  source = replace(
    source,
    "  const fontSize = parseFloat(font);",
    String.raw`  const fontSize = parseFloat(font.match(/(?:^|\s)([\d.]+)px(?=\s|$)/)?.[1] ?? font);`,
  );
  source = replace(
    source,
    "var FONT_METADATA = {",
    `var FONT_METADATA = {
  ...Object.fromEntries(boardFonts.map(({ id, metrics }) => [id, { metrics }])),`,
  );
  source = replace(
    source,
    '    init("Virgil", ...VirgilFontFaces);',
    `    init("Virgil", ...VirgilFontFaces);
    for (const { name, faces } of boardFonts) {
      init(name, ...faces.map(({ weight, style, file }) => ({
        uri: "board-fonts/" + file,
        descriptors: { weight: String(weight), style }
      })));
    }`,
  );
  source = replace(
    source,
    `    const iterator = _Fonts.fontFacesStylesGenerator(families, charsPerFamily);`,
    `    const facesPerFamily = new Map();
    for (const element of elements) {
      const font = boardFonts.find(({ id }) => id === element.fontFamily);
      if (!isTextElement(element) || !font) continue;
      const needed = facesPerFamily.get(font.id) ?? new Set();
      const base = getTextFormatting(element);
      const styles = [base, ...safeTextRuns(element).map(({ style }) => ({ ...base, ...style }))];
      for (const { weight, italic } of styles) {
        const faceWeight = font.weights.includes(weight) ? weight : 400;
        const faceStyle = italic && font.italic ? "italic" : "normal";
        needed.add(faceWeight + "/" + faceStyle);
      }
      facesPerFamily.set(font.id, needed);
      const fallback = FONT_FAMILY.Nunito;
      charsPerFamily[fallback] ??= new Set();
      for (const char of element.originalText) charsPerFamily[fallback].add(char);
      if (!families.includes(fallback)) families.push(fallback);
    }
    const iterator = _Fonts.fontFacesStylesGenerator(families, charsPerFamily, facesPerFamily);`,
  );
  source = replace(
    source,
    "static *fontFacesStylesGenerator(families, charsPerFamily)",
    "static *fontFacesStylesGenerator(families, charsPerFamily, facesPerFamily)",
  );
  source = replace(
    source,
    "for (const [fontFaceIndex, fontFace] of fontFaces.entries()) {",
    `for (const [fontFaceIndex, fontFace] of fontFaces.entries()) {
        const faceKey = fontFace.fontFace.weight + "/" + fontFace.fontFace.style;
        if (facesPerFamily.has(family) && !facesPerFamily.get(family).has(faceKey)) continue;`,
  );
  source = replace(
    source,
    "src: url(${content}); }",
    "src: url(${content}); font-weight: ${this.fontFace.weight}; font-style: ${this.fontFace.style}; }",
  );
  source = replace(
    source,
    `      const font = getFontString({
        fontFamily,
        fontSize: 16
      });`,
    `      const faces = boardFonts.find(({ id }) => id === fontFamily)?.faces ?? [{ weight: 400, style: "normal" }];
      for (const [faceIndex, { weight, style }] of faces.entries()) {
      const font = getFontString({ fontFamily, fontSize: 16, textFormatting: { weight, italic: style === "italic" } });`,
  );
  source = replace(
    source,
    "return [index, fontFaces];",
    "return [index * 10000 + faceIndex, fontFaces];",
  );
  source = replace(
    source,
    `    }
  }
  static *fontFacesStylesGenerator`,
    `      }
    }
  }
  static *fontFacesStylesGenerator`,
  );
  source = replace(
    source,
    `    getFontString({ fontFamily, fontSize }),
    lineHeight
  );`,
    `    getFontString({ fontFamily, fontSize, textFormatting: opts.textFormatting }),
    lineHeight
  );`,
  );
  source = replace(
    source,
    `    originalText: opts.originalText ?? text,`,
    `    originalText: opts.originalText ?? text,
    ...(opts.textFormatting ? { textFormatting: opts.textFormatting } : {}),`,
  );
  source = replace(
    source,
    `        for (let index = 0; index < lines.length; index++) {
          context.fillText(
            lines[index],
            horizontalOffset,
            index * lineHeightPx + verticalOffset
          );
        }`,
    `        const { underline, strikethrough } = getTextFormatting(element);
        for (let index = 0; index < lines.length; index++) {
          const baseline = index * lineHeightPx + verticalOffset;
          const line = lines[index];
          context.fillText(line, horizontalOffset, baseline);
          if (line && (underline || strikethrough)) {
            const width = context.measureText(line).width;
            const x = horizontalOffset - (element.textAlign === "center" ? width / 2 : element.textAlign === "right" ? width : 0);
            const thickness = Math.max(1, element.fontSize / 16);
            if (underline) context.fillRect(x, baseline + element.fontSize * 0.1, width, thickness);
            if (strikethrough) context.fillRect(x, baseline - element.fontSize * 0.3, width, thickness);
          }
        }`,
  );
  source = replace(
    source,
    `          text.setAttribute("font-family", getFontFamilyString(element));`,
    `          text.setAttribute("font-family", getFontFamilyString(element));
          const format = getTextFormatting(element);
          if (format.weight !== 400) text.setAttribute("font-weight", String(format.weight));
          if (format.italic) text.setAttribute("font-style", "italic");
          const decoration = getTextDecoration(format);
          if (decoration) text.setAttribute("text-decoration", decoration);`,
  );
  source = replace(
    source,
    `  ctx.font = getFontString({
    fontFamily: element.fontFamily,
    fontSize: element.fontSize
  });`,
    `  ctx.font = getFontString(element);`,
  );
  source = replace(
    source,
    `      getFontString({
        fontSize: element.fontSize,
        fontFamily: element.fontFamily
      }),`,
    `      getFontString(element),`,
  );
  source = replace(
    source,
    `      getFontString({
        fontSize: newElement2.fontSize,
        fontFamily: newElement2.fontFamily
      }),`,
    `      getFontString(newElement2),`,
  );
  source = replace(
    source,
    "var measureText = (text, font, lineHeight) => {",
    `var textWithRun = (element, style) => ({
  ...element, textFormatting: { ...getTextFormatting(element), ...style }
});
var measureBoardRuns = (element, text) => {
  if (!element.textRuns?.length) return measureText(text, getFontString(element), element.lineHeight);
  const widths = boardTextLines(element, text).map(line =>
    line.reduce((sum, {text, style}) => sum + getLineWidth(text, getFontString(textWithRun(element, style))), 0));
  return { width: widths.reduce((max, width) => Math.max(max, width), 0), height: widths.length * element.fontSize * element.lineHeight };
};
var wrapForTextElement = (element, text, width) =>
  element.textRuns?.length
    ? wrapBoardText({ ...element, originalText: text }, width,
        ({text, style}) => getLineWidth(text, getFontString(textWithRun(element, style))))
    : wrapText(text, getFontString(element), width);
var measureText = (text, font, lineHeight) => {`,
  );
  source = replace(
    source,
    `    boundTextUpdates.text = wrapText(
      textElement.originalText,
      getFontString(textElement),
      maxWidth
    );`,
    `    boundTextUpdates.text = wrapForTextElement(textElement, textElement.originalText, maxWidth);`,
  );
  source = replace(
    source,
    `  const metrics = measureText(
    boundTextUpdates.text,
    getFontString(textElement),
    textElement.lineHeight
  );`,
    `  const metrics = measureBoardRuns(textElement, boundTextUpdates.text);`,
  );
  source = replace(
    source,
    `  let { width: nextWidth, height: nextHeight } = measureText(
    nextText,
    getFontString(element),
    element.lineHeight
  );`,
    `  let { width: nextWidth, height: nextHeight } = measureBoardRuns(element, nextText);`,
  );
  source = replace(
    source,
    `    const prevMetrics = measureText(
      element.text,
      getFontString(element),
      element.lineHeight
    );`,
    `    const prevMetrics = measureBoardRuns(element, element.text);`,
  );
  source = replace(
    source,
    `    text = wrapText(
      text,
      getFontString(textElement),
      container ? getBoundTextMaxWidth(container, textElement) : textElement.width
    );`,
    `    text = wrapForTextElement(textElement, text, container ? getBoundTextMaxWidth(container, textElement) : textElement.width);`,
  );
  source = replace(
    source,
    `        text = wrapText(
          textElement.originalText,
          getFontString(textElement),
          maxWidth
        );`,
    `        text = wrapForTextElement(textElement, textElement.originalText, maxWidth);`,
  );
  source = replace(
    source,
    `      const metrics = measureText(
        text,
        getFontString(textElement),
        textElement.lineHeight
      );`,
    `      const metrics = measureBoardRuns(textElement, text);`,
  );
  source = replace(
    source,
    `    const text = wrapText(
      element.originalText,
      getFontString(element),
      Math.abs(newWidth)
    );
    const metrics = measureText(
      text,
      getFontString(element),
      element.lineHeight
    );`,
    `    const text = wrapForTextElement(element, element.originalText, Math.abs(newWidth));
    const metrics = measureBoardRuns(element, text);`,
  );
  source = replace(
    source,
    `        const { underline, strikethrough } = getTextFormatting(element);
        for (let index = 0; index < lines.length; index++) {`,
    `        const { underline, strikethrough } = getTextFormatting(element);
        if (element.textRuns?.length) {
          const styledLines = boardTextLines(element, lines.join("\\n"));
          context.textAlign = "left";
          for (const [index, line] of styledLines.entries()) {
            const baseline = index * lineHeightPx + verticalOffset;
            const segments = line.map(({text, style}) => {
              const styled = textWithRun(element, style);
              const font = getFontString(styled);
              context.font = font;
              return { text, font, width: context.measureText(text).width, format: getTextFormatting(styled), color: style.color ?? element.strokeColor };
            });
            const width = segments.reduce((sum, segment) => sum + segment.width, 0);
            let x = horizontalOffset - (element.textAlign === "center" ? width / 2 : element.textAlign === "right" ? width : 0);
            for (const segment of rtl ? segments.reverse() : segments) {
              context.font = segment.font;
              context.fillStyle = segment.color;
              context.fillText(segment.text, x, baseline);
              const thickness = Math.max(1, element.fontSize / 16);
              if (segment.format.underline) context.fillRect(x, baseline + element.fontSize * 0.1, segment.width, thickness);
              if (segment.format.strikethrough) context.fillRect(x, baseline - element.fontSize * 0.3, segment.width, thickness);
              x += segment.width;
            }
          }
        } else for (let index = 0; index < lines.length; index++) {`,
  );
  source = replace(
    source,
    `        for (let i = 0; i < lines.length; i++) {
          const text = svgRoot.ownerDocument.createElementNS(SVG_NS, "text");`,
    `        const runLines = element.textRuns?.length ? boardTextLines(element, lines.join("\\n")) : null;
        for (let i = 0; i < lines.length; i++) {
          const text = svgRoot.ownerDocument.createElementNS(SVG_NS, "text");`,
  );
  source = replace(
    source,
    `          node.appendChild(text);`,
    `          if (runLines) {
            text.textContent = "";
            text.removeAttribute("text-decoration");
            text.setAttribute("xml:space", "preserve");
            for (const segment of runLines[i]) {
              const tspan = svgRoot.ownerDocument.createElementNS(SVG_NS, "tspan");
              tspan.textContent = segment.text;
              if (segment.style.color) tspan.setAttribute("fill", segment.style.color);
              const format = getTextFormatting(textWithRun(element, segment.style));
              tspan.setAttribute("font-weight", String(format.weight));
              tspan.setAttribute("font-style", format.italic ? "italic" : "normal");
              const decoration = getTextDecoration(format);
              if (decoration) tspan.setAttribute("text-decoration", decoration);
              text.appendChild(tspan);
            }
          }
          node.appendChild(text);`,
  );
  return (
    source +
    "\nexport { getTextFormatting, getTextDecoration, hasNativeBoldFace };\n"
  );
}

const controls = `function getTextFormattingShortcut(event) {
  if (!event[KEYS.CTRL_OR_CMD] || event.altKey || event.isComposing) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === "s" ? "strikethrough" : null;
  switch (key) {
    case "b": return "weight";
    case "i": return "italic";
    case "u": return "underline";
    default: return null;
  }
}

function getSelectedTextFormattingTargets(elements, appState) {
  return getSelectedElements(elements, appState, { includeBoundTextElement: true })
    .filter(element => isTextElement(element) && !element.locked && !element.isDeleted);
}

function getTextFormattingStyles(element, start = 0, end = element.originalText.length) {
  const base = getTextFormatting(element);
  const pieces = element.textRuns?.length ? stylesInRange(element, start, end) : [];
  return pieces.length ? pieces.map(({ style }) => ({ ...base, ...style })) : [base];
}

function getTextColorSelection(app, appState) {
  const editor = activeTextEditors.get(app);
  const element = app.scene.getElement(appState.editingTextElement?.id);
  if (!editor || !isTextElement(element) || element.locked || element.isDeleted) return null;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  return start < end && (start > 0 || end < element.originalText.length)
    ? { element, start, end }
    : null;
}

function TextAwareStrokePicker({ elements, appState, updateData, app }) {
  const { langCode } = useI18n();
  const editor = activeTextEditors.get(app);
  const [, refreshSelection] = useState8(0);
  useEffect15(() => {
    if (!editor) return;
    const refresh = () => refreshSelection(value => value + 1);
    document.addEventListener("selectionchange", refresh);
    return () => document.removeEventListener("selectionchange", refresh);
  }, [editor]);
  const selection = getTextColorSelection(app, appState);
  let color;
  if (selection) {
    const { element, start, end } = selection;
    const colors = stylesInRange(element, start, end)
      .map(({ style }) => style.color ?? element.strokeColor);
    color = colors.every(value => value === colors[0]) ? colors[0] : null;
  } else {
    color = getFormValue(elements, appState, (element) => element.strokeColor, true, appState.currentItemStrokeColor);
  }
  const label = selection
    ? langCode.startsWith("de") ? "Textfarbe der Auswahl" : "Selected text color"
    : t("labels.stroke");
  return jsxs20(Fragment4, { children: [
    jsx34("h3", { "aria-hidden": "true", children: label }),
    jsx34(ColorPicker, {
      topPicks: DEFAULT_ELEMENT_STROKE_PICKS,
      palette: DEFAULT_ELEMENT_STROKE_COLOR_PALETTE,
      type: "elementStroke",
      label,
      color,
      onChange: (color) => updateData({ currentItemStrokeColor: color }),
      elements,
      appState,
      updateData
    })
  ] });
}

function TextFormattingControls({ elements, appState, app, selectedFontFamily, updateData }) {
  const { langCode } = useI18n();
  const german = langCode.startsWith("de");
  const targets = getSelectedTextFormattingTargets(elements, appState);
  const editing = app.scene.getElement(appState.editingTextElement?.id);
  if (isTextElement(editing) && !targets.some(({ id }) => id === editing.id)) targets.push(editing);
  const editor = activeTextEditors.get(app);
  const [, refreshSelection] = useState8(0);
  useEffect15(() => {
    if (!editor) return;
    const refresh = () => refreshSelection(value => value + 1);
    document.addEventListener("selectionchange", refresh);
    return () => document.removeEventListener("selectionchange", refresh);
  }, [editor]);
  const styles = editing && editor && editor.selectionStart < editor.selectionEnd
    ? getTextFormattingStyles(editing, editor.selectionStart, editor.selectionEnd)
    : targets.length
      ? targets.flatMap(element => getTextFormattingStyles(element))
      : [getTextFormatting({ fontFamily: selectedFontFamily, textFormatting: appState.currentItemTextFormatting })];
  const all = (property, value) => styles.every((style) => style[property] === value);
  const some = (property, value) => styles.some((style) => style[property] === value);
  const set = (property, value) => updateData({
    textFormattingChange: { [property]: value }
  });
  const toggle = (property, value, label, letter, off = false, style, className) => jsx34("button", {
    type: "button",
    className,
    title: label,
    "aria-label": label,
    "aria-pressed": all(property, value) ? true : some(property, value) ? "mixed" : false,
    style,
    "aria-keyshortcuts": property === "strikethrough" ? "Meta+Shift+S Control+Shift+S" : "Meta+" + ({weight:"B",italic:"I",underline:"U"})[property] + " Control+" + ({weight:"B",italic:"I",underline:"U"})[property],
    onPointerDown: (event) => event.preventDefault(),
    onClick: () => set(property, all(property, value) ? off : value),
    children: letter
  }, property);
  return jsxs20("fieldset", { children: [
    jsx34("legend", { children: german ? "Textformatierung" : "Text formatting" }),
    jsxs20("div", { className: "FontPicker__container excalidash-text-formatting", children: [
      jsxs20("div", { className: "buttonList", children: [
        toggle("weight", 700, german ? "Fett" : "Bold", german ? "F" : "B", 400, { fontWeight: 700 }),
        toggle("italic", true, german ? "Kursiv" : "Italic", "I", false, { fontStyle: "italic" }),
        toggle("underline", true, german ? "Unterstrichen" : "Underline", "U", false, { textDecoration: "underline" })
      ] }),
      jsx34(ButtonSeparator, {}),
      jsx34("div", { children: toggle("strikethrough", true, german ? "Durchgestrichen" : "Strikethrough", "S", false, { textDecoration: "line-through" }, "standalone") })
    ] })
  ] });
}

function updateFormattedTextLayout(elements, candidates, app, needsResize) {
  const updated = arrayToMap(candidates);
  let changed = false;
  candidates.forEach((element, index) => {
    const previous = elements[index];
    if (previous === element || !isTextElement(element)) return;
    changed = true;
    if (!needsResize(element, previous)) return;
    const container = app.scene.getContainerElement(previous);
    // Work against a cloned container so undo captures the layout change.
    const updatedContainer = container ? { ...updated.get(container.id) } : null;
    redrawTextBoundingBox(element, updatedContainer, updated, false);
    offsetElementAfterFontResize(previous, element);
    if (container && updatedContainer && (container.width !== updatedContainer.width || container.height !== updatedContainer.height)) {
      updated.set(container.id, newElementWith(updated.get(container.id), {
        width: updatedContainer.width, height: updatedContainer.height
      }));
    }
  });
  if (changed) {
    for (const element of candidates) {
      if (isTextElement(element) && element !== app.scene.getElement(element.id)) updateBoundElements(element, updated);
    }
  }
  return changed ? elements.map(({ id }) => updated.get(id)) : candidates;
}

function changeTextColor(elements, appState, value, app) {
  const color = value.currentItemStrokeColor;
  const selection = getTextColorSelection(app, appState);
  if (selection) {
    const change = { color: color.toLowerCase() };
    if (!isTextRunColor(change.color)) return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
    const { element, start, end } = selection;
    const textRuns = setRangeStyle(element, start, end, change, {
      ...getTextFormatting(element), color: element.strokeColor
    });
    const candidates = elements.map((previous) => {
      if (previous.id !== element.id || JSON.stringify(previous.textRuns ?? []) === JSON.stringify(textRuns)) return previous;
      return newElementWith(previous, { textRuns });
    });
    return {
      elements: updateFormattedTextLayout(elements, candidates, app, () => true),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    };
  }
  const clearedTextIds = new Set();
  const candidates = changeProperty(elements, appState, (element) => {
    if (!hasStrokeColor(element.type)) return element;
    if (isTextElement(element) && Array.isArray(element.textRuns) && element.textRuns.some(run => run?.style?.color)) {
      clearedTextIds.add(element.id);
      return newElementWith(element, { strokeColor: color, textRuns: clearStyleOverrides(element, { color }) });
    }
    return newElementWith(element, { strokeColor: color });
  }, true);
  return {
    elements: clearedTextIds.size
      ? updateFormattedTextLayout(elements, candidates, app, element => clearedTextIds.has(element.id))
      : candidates,
    appState: { ...appState, ...value },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY
  };
}

function changeTextFormatting(elements, appState, change, app) {
  const editor = activeTextEditors.get(app);
  const edited = app.scene.getElement(appState.editingTextElement?.id);
  const rangeStart = editor?.selectionStart ?? 0;
  const rangeEnd = editor?.selectionEnd ?? 0;
  const isPartial = edited && rangeStart < rangeEnd && (rangeStart !== 0 || rangeEnd !== edited.originalText.length);
  const candidates = changeProperty(elements, appState, (element) => {
    if (!isTextElement(element) || element.locked || element.isDeleted) return element;
    const current = getTextFormatting(element);
    if (isPartial && element.id === edited.id) {
      const textRuns = setRangeStyle(element, rangeStart, rangeEnd, change, current);
      return newElementWith(element, { textRuns });
    }
    const next = getTextFormatting({
      fontFamily: element.fontFamily, textFormatting: { ...current, ...change }
    });
    const runs = clearStyleOverrides(element, change);
    if (Object.keys(change).every((key) => current[key] === next[key]) &&
      JSON.stringify(runs) === JSON.stringify(element.textRuns ?? [])) return element;
    return newElementWith(element, { textFormatting: next, ...(element.textRuns?.length ? { textRuns: runs } : {}) });
  }, true);
  return {
    elements: updateFormattedTextLayout(elements, candidates, app,
      () => change.weight !== undefined || change.italic !== undefined),
    appState: {
      ...appState,
      currentItemTextFormatting: isPartial ? appState.currentItemTextFormatting : {
        ...appState.currentItemTextFormatting,
        ...change
      }
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY
  };
}
`;

function patchEditor(source: string, runsModule: string) {
  source =
    `import { activeTextEditors, createBoardTextEditor, stylesInRange, setRangeStyle, clearStyleOverrides, moveTextRuns, isTextRunColor } from ${JSON.stringify(runsModule)};\n` +
    'import { getTextFormatting, getTextDecoration, hasNativeBoldFace } from "./chunk-4FTI6OG3.js";\n' +
    source;
  source = replace(
    source,
    "var actionChangeFontFamily = register({",
    controls + "var actionChangeFontFamily = register({",
  );
  const strokeActionStart = source.indexOf(
    "var actionChangeStrokeColor = register({",
  );
  const strokeActionEnd = source.indexOf(
    "var actionChangeBackgroundColor = register({",
    strokeActionStart,
  );
  if (strokeActionStart === -1 || strokeActionEnd === -1) {
    throw new Error("Could not find Excalidraw's stroke color action");
  }
  source = replace(
    source,
    source.slice(strokeActionStart, strokeActionEnd),
    `var actionChangeStrokeColor = register({
  name: "changeStrokeColor",
  label: "labels.stroke",
  trackEvent: false,
  perform: (elements, appState, value, app) => value.currentItemStrokeColor
    ? changeTextColor(elements, appState, value, app)
    : { appState: { ...appState, ...value }, captureUpdate: CaptureUpdateAction.EVENTUALLY },
  PanelComponent: TextAwareStrokePicker
});
`,
  );
  source = replace(
    source,
    `    const { cachedElements, resetAll, resetContainers, ...nextAppState } = value;`,
    `    const { cachedElements, resetAll, resetContainers, textFormattingChange, ...nextAppState } = value;
    if (textFormattingChange) return changeTextFormatting(elements, appState, textFormattingChange, app);`,
  );
  source = replace(
    source,
    `        if (this.actionManager.handleKeyDown(event)) {`,
    `        if (!this.state.viewModeEnabled && !this.state.openDialog && !this.state.editingTextElement && !isInputLike(event.target)) {
          const format = getTextFormattingShortcut(event);
          if (format) {
            const targets = getSelectedTextFormattingTargets(this.scene.getNonDeletedElementsMap(), this.state);
            if (targets.length) {
              const on = format === "weight" ? 700 : true;
              const off = format === "weight" ? 400 : false;
              const allFormatted = targets.every(element =>
                getTextFormattingStyles(element).every(style => style[format] === on)
              );
              event.preventDefault();
              event.stopPropagation();
              this.actionManager.executeAction(actionChangeFontFamily, "keyboard", {
                textFormattingChange: { [format]: allFormatted ? off : on }
              });
              return;
            }
          }
        }
        if (this.actionManager.handleKeyDown(event)) {`,
  );
  source = replace(
    source,
    `      const chars = Array.from(uniqueChars.values()).join();`,
    `      const chars = Array.from(uniqueChars.values()).join();
      if (!skipFontFaceCheck && hasNativeBoldFace(nextFontFamily) && elementContainerMapping.size) {
        const formatted = [...elementContainerMapping.keys()];
        Fonts.loadElementsFonts(formatted).then((fontFaces) => {
          for (const [element, container] of elementContainerMapping) {
            const latest = app.scene.getElement(element.id);
            if (latest?.versionNonce === element.versionNonce) {
              redrawTextBoundingBox(latest, container && app.scene.getElement(container.id), app.scene.getNonDeletedElementsMap(), false);
            }
          }
          app.fonts.onLoaded(fontFaces);
          app.scene.triggerUpdate();
        });
      }`,
  );
  source = replace(
    source,
    'text: fontFaces[0]?.fontFace?.family ?? "Unknown"',
    'text: fontFaces[0]?.fontFace?.family?.replace(/^"|"$/g, "") ?? "Unknown"',
  );
  source = replace(
    source,
    `          fontFamily: getFontFamilyString({ fontFamily: font.value })`,
    `          fontFamily: font.text === "Redacted Script" ? undefined : getFontFamilyString({ fontFamily: font.value })`,
  );
  source = replace(
    source,
    `    return /* @__PURE__ */ jsxs20("fieldset", { children: [
      /* @__PURE__ */ jsx34("legend", { children: t("labels.fontFamily") }),`,
    `    return jsxs20(Fragment4, { children: [
      jsxs20("fieldset", { children: [
        jsx34("legend", { children: t("labels.fontFamily") }),`,
  );
  source = replace(
    source,
    `            }
          }
        }
      )
    ] });
  }
});
var actionChangeTextAlign`,
    `            }
          }
        }
        )
      ] }),
      jsx34(TextFormattingControls, { elements, appState, app, selectedFontFamily, updateData })
    ] });
  }
});
var actionChangeTextAlign`,
  );
  source = replace(
    source,
    `    return false;
  };
  const updateWysiwygStyle`,
    `    const { weight, italic } = getTextFormatting(updatedTextElement);
    return weight !== Number(editable2.style.fontWeight || 400) ||
      italic !== (editable2.style.fontStyle === "italic");
  };
  const updateWysiwygStyle`,
  );
  source = replace(
    source,
    `        lineHeight: updatedTextElement.lineHeight,`,
    `        lineHeight: updatedTextElement.lineHeight,
        textDecoration: getTextDecoration(getTextFormatting(updatedTextElement)),`,
  );
  source = replace(
    source,
    `      const font = getFontString({
        fontSize: app.state.currentItemFontSize,
        fontFamily: app.state.currentItemFontFamily
      });`,
    `      const font = getFontString(app.scene.getElement(element.id) ?? element);`,
  );
  source = replace(
    source,
    `        text: "",
        fontSize,
        fontFamily,`,
    `        text: "",
        fontSize,
        fontFamily,
        textFormatting: this.state.currentItemTextFormatting,`,
  );
  source = replace(
    source,
    `      fontFamily: this.state.currentItemFontFamily,
      textAlign: DEFAULT_TEXT_ALIGN,`,
    `      fontFamily: this.state.currentItemFontFamily,
      textFormatting: this.state.currentItemTextFormatting,
      textAlign: DEFAULT_TEXT_ALIGN,`,
  );
  source = replace(
    source,
    `    const fontString = getFontString({
      fontSize: textElementProps.fontSize,
      fontFamily: textElementProps.fontFamily
    });`,
    `    const fontString = getFontString(textElementProps);`,
  );
  source = replace(
    source,
    `          getFontString({
            fontSize: newElement2.fontSize,
            fontFamily: newElement2.fontFamily
          }),`,
    `          getFontString(newElement2),`,
  );
  source = replace(
    source,
    `              textAlign: elementStylesToCopyFrom.textAlign || DEFAULT_TEXT_ALIGN,`,
    `              textFormatting: elementStylesToCopyFrom.textFormatting,
              textAlign: elementStylesToCopyFrom.textAlign || DEFAULT_TEXT_ALIGN,`,
  );
  source = replace(
    source,
    `          fontFamily: match.textElement.fontFamily`,
    `          fontFamily: match.textElement.fontFamily,
          textFormatting: match.textElement.textFormatting`,
  );
  source = replace(
    source,
    `          getFontString({ fontFamily, fontSize }),`,
    `          getFontString({ fontFamily, fontSize, textFormatting: element.textFormatting }),`,
  );
  source = replace(
    source,
    `        const fontString = {
          fontSize,
          fontFamily
        };`,
    `        const fontString = {
          fontSize,
          fontFamily,
          textFormatting: this.state.currentItemTextFormatting
        };`,
  );
  source = replace(
    source,
    `  const editable = document.createElement("textarea");`,
    `  const editable = createBoardTextEditor();
  activeTextEditors.set(app, editable);`,
  );
  source = replace(source, `  editable.wrap = "off";\n`, "");
  source = replace(
    source,
    `      editable.scrollTop = 0;`,
    `      editable.renderRuns(updatedTextElement, getTextFormatting(updatedTextElement));
      editable.scrollTop = 0;`,
  );
  source = replace(
    source,
    `        textDecoration: getTextDecoration(getTextFormatting(updatedTextElement)),`,
    `        textDecoration: updatedTextElement.textRuns?.length ? "none" : getTextDecoration(getTextFormatting(updatedTextElement)),`,
  );
  source = replace(
    source,
    `    editable.onblur = null;
    editable.oninput = null;`,
    `    activeTextEditors.delete(app);
    editable.onblur = null;
    editable.oninput = null;`,
  );
  source = replace(
    source,
    `      if (target instanceof HTMLTextAreaElement) {`,
    `      if (target === editable) {`,
  );
  source = source.replaceAll(
    'target instanceof HTMLElement && target.classList.contains("properties-trigger")',
    'target instanceof Element && !!target.closest(".properties-trigger")',
  );
  source = replace(
    source,
    `    if ((event.target instanceof HTMLElement || event.target instanceof SVGElement) && event.target.closest(`,
    `    if (target instanceof Element && target.closest(".color-picker-container, .color-picker-content")) {
      editable.rememberSelection();
      temporarilyDisableSubmit();
      return;
    }
    if ((event.target instanceof HTMLElement || event.target instanceof SVGElement) && event.target.closest(`,
  );
  source = replace(
    source,
    `      if (!isPropertiesTrigger) {
        editable.focus();
      }`,
    `      if (!isPropertiesTrigger && !document.activeElement?.closest(".color-picker-content")) {
        editable.focus();
      }`,
  );
  source = replace(
    source,
    `  editable.onkeydown = (event) => {\n    if (!event.shiftKey && actionZoomIn.keyTest(event)) {`,
    `  editable.onkeydown = (event) => {
    {
      const format = getTextFormattingShortcut(event);
      if (format) {
        const textElement = app.scene.getElement(id);
        if (textElement) {
          event.preventDefault();
          event.stopPropagation();
          const value = format === "weight" ? 700 : true;
          const base = getTextFormatting(textElement);
          const start = editable.selectionStart;
          const end = editable.selectionEnd;
          if (start === end) {
            const preceding = stylesInRange(textElement, Math.max(0, start - 1), start).at(-1)?.style;
            const pending = editable.pendingFormatting?.offset === start ? editable.pendingFormatting.style : preceding;
            const style = { ...base, ...pending };
            style[format] = style[format] === value ? (format === "weight" ? 400 : false) : value;
            editable.pendingFormatting = { offset: start, style };
            return;
          }
          editable.pendingFormatting = undefined;
          const styles = getTextFormattingStyles(textElement, start, end);
          const off = format === "weight" ? 400 : false;
          const change = { [format]: styles.every(style => style[format] === value) ? off : value };
          app.actionManager.executeAction(actionChangeFontFamily, "ui", { textFormattingChange: change });
          return;
        }
      }
    }
    if (event.key === "Enter" && !event[KEYS.CTRL_OR_CMD] && !event.isComposing) {
      event.preventDefault();
      const { value, selectionStart, selectionEnd } = editable;
      editable.value = value.slice(0, selectionStart) + "\\n" + value.slice(selectionEnd);
      editable.setSelectionRange(selectionStart + 1, selectionStart + 1);
      onChange({ text: editable.value, inputStart: selectionStart });
      return;
    }
    if (!event.shiftKey && actionZoomIn.keyTest(event)) {`,
  );
  source = replace(
    source,
    `      onChange(editable.value);`,
    `      const start = editable.lastInputStart;
      const pending = editable.pendingFormatting;
      const current = app.scene.getElement(id);
      const added = current ? editable.value.length - current.originalText.length : 0;
      const typing = pending && start === pending.offset && start === editable.lastInputEnd && added > 0
        ? { start, end: start + added, style: pending.style }
        : undefined;
      editable.pendingFormatting = typing ? { offset: typing.end, style: typing.style } : undefined;
      onChange({ text: editable.value, inputStart: start, typing });`,
  );
  source = replace(
    source,
    `    const updateElement = (nextOriginalText, isDeleted) => {`,
    `    const updateElement = (nextOriginalText, isDeleted, inputStart, typing) => {`,
  );
  source = replace(
    source,
    `            return newElementWith(_element, {
              originalText: nextOriginalText,`,
    `            let textRuns = _element.textRuns?.length ? moveTextRuns(_element, nextOriginalText, inputStart) : _element.textRuns;
            if (typing) textRuns = setRangeStyle({ originalText: nextOriginalText, textRuns }, typing.start, typing.end, typing.style, getTextFormatting(_element));
            return newElementWith(_element, {
              ...(textRuns ? { textRuns } : {}),
              originalText: nextOriginalText,`,
  );
  source = replace(
    source,
    `              ...refreshTextDimensions(
                _element,
                getContainerElement(_element, elementsMap),`,
    `              ...refreshTextDimensions(
                { ..._element, originalText: nextOriginalText, textRuns },
                getContainerElement(_element, elementsMap),`,
  );
  source = replace(
    source,
    `      onChange: withBatchedUpdates((nextOriginalText) => {
        updateElement(nextOriginalText, false);`,
    `      onChange: withBatchedUpdates(({ text: nextOriginalText, inputStart, typing }) => {
        updateElement(nextOriginalText, false, inputStart, typing);`,
  );
  return source;
}

export function excalidrawTypography(
  catalog: FontCatalog,
  revision: string,
  runsModule: string,
): {
  vite: VitePlugin;
  optimizer: EsbuildPlugin;
} {
  const name = `excalidash-excalidraw-typography-${revision}`;
  let base = "/";
  const patch = (source: string, id: string) =>
    bundles.exec(id)?.[1] === "index"
      ? patchEditor(source, runsModule)
      : patchCore(source, catalog, runsModule);
  return {
    vite: {
      name,
      enforce: "pre",
      transform(source, id) {
        if (bundles.test(id)) return patch(source, id);
      },
      configResolved(config) {
        base = config.base;
      },
      transformIndexHtml() {
        const css = catalog
          .flatMap((font) =>
            boardFontFaces(font).map(
              ({ weight, style, file }) =>
                `@font-face{font-family:${JSON.stringify(font.name)};font-weight:${weight};font-style:${style};font-display:swap;src:url("${base}board-fonts/${file}") format("woff2")}`,
            ),
          )
          .join("\n");
        return [{ tag: "style", children: css, injectTo: "head" }];
      },
    },
    optimizer: {
      name,
      setup(build) {
        build.onLoad({ filter: bundles }, async ({ path }) => ({
          contents: patch(
            patchZoom(
              await readFile(path, "utf8"),
              "dev/" + bundles.exec(path)![1],
            ),
            path,
          ),
          loader: "js",
        }));
      },
    },
  };
}
