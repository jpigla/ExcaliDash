import { readFile } from "node:fs/promises";
import { patchZoom } from "./excalidrawZoom";
import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin as VitePlugin } from "vite";

type FontCatalog = ReadonlyArray<{
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
}>;

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

function patchCore(source: string, catalog: FontCatalog) {
  source = replace(
    source,
    "var FONT_FAMILY = {",
    `var boardFonts = ${JSON.stringify(catalog)};
var supportsLightFont = (family) => boardFonts.some((font) => font.id === family && font.weights.includes(300));
var getTextFormatting = (element) => {
  const format = element?.textFormatting;
  return {
    weight: format?.weight === 700 ? 700 : format?.weight === 300 && supportsLightFont(element.fontFamily) ? 300 : 400,
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
    for (const { name, slug, weights } of boardFonts) {
      init(name, ...weights.map((weight) => ({
        uri: "board-fonts/" + slug + "-" + weight + ".woff2",
        descriptors: { weight: String(weight) }
      })));
    }`,
  );
  source = replace(
    source,
    `    const iterator = _Fonts.fontFacesStylesGenerator(families, charsPerFamily);`,
    `    const weightsPerFamily = new Map();
    for (const element of elements) {
      const font = boardFonts.find(({ id }) => id === element.fontFamily);
      if (!isTextElement(element) || !font) continue;
      const weights = weightsPerFamily.get(font.id) ?? new Set();
      const { weight } = getTextFormatting(element);
      weights.add(font.weights.includes(weight) ? weight : 400);
      weightsPerFamily.set(font.id, weights);
      const fallback = FONT_FAMILY.Nunito;
      charsPerFamily[fallback] ??= new Set();
      for (const char of element.originalText) charsPerFamily[fallback].add(char);
      if (!families.includes(fallback)) families.push(fallback);
    }
    const iterator = _Fonts.fontFacesStylesGenerator(families, charsPerFamily, weightsPerFamily);`,
  );
  source = replace(
    source,
    "static *fontFacesStylesGenerator(families, charsPerFamily)",
    "static *fontFacesStylesGenerator(families, charsPerFamily, weightsPerFamily)",
  );
  source = replace(
    source,
    "for (const [fontFaceIndex, fontFace] of fontFaces.entries()) {",
    `for (const [fontFaceIndex, fontFace] of fontFaces.entries()) {
        if (weightsPerFamily.has(family) && !weightsPerFamily.get(family).has(Number(fontFace.fontFace.weight))) continue;`,
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
    `      const weights = boardFonts.find(({ id }) => id === fontFamily)?.weights ?? [400];
      for (const weight of weights) {
      const font = getFontString({ fontFamily, fontSize: 16, textFormatting: { weight } });`,
  );
  source = replace(
    source,
    "return [index, fontFaces];",
    "return [index * 1000 + weight, fontFaces];",
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
  return (
    source +
    "\nexport { getTextFormatting, getTextDecoration, supportsLightFont };\n"
  );
}

const controls = `function TextFormattingControls({ elements, appState, app, selectedFontFamily, updateData }) {
  const { langCode } = useI18n();
  const german = langCode.startsWith("de");
  const targets = getSelectedElements(elements, appState, { includeBoundTextElement: true }).filter(isTextElement);
  const editing = app.scene.getElement(appState.editingTextElement?.id);
  if (isTextElement(editing) && !targets.some(({ id }) => id === editing.id)) targets.push(editing);
  const styles = (targets.length ? targets : [{
    fontFamily: selectedFontFamily, textFormatting: appState.currentItemTextFormatting
  }]).map(getTextFormatting);
  const all = (property, value) => styles.every((style) => style[property] === value);
  const some = (property, value) => styles.some((style) => style[property] === value);
  const set = (property, value) => updateData({
    textFormattingChange: { [property]: value }
  });
  const toggle = (property, value, label, letter, off = false, style) => jsx34("button", {
    type: "button",
    title: label,
    "aria-label": label,
    "aria-pressed": all(property, value) ? true : some(property, value) ? "mixed" : false,
    style,
    onPointerDown: (event) => event.preventDefault(),
    onClick: () => set(property, all(property, value) ? off : value),
    children: letter
  }, property);
  const formatting = german ? "Textformatierung" : "Text formatting";
  const lightAvailable = targets.length
    ? targets.every(({ fontFamily }) => supportsLightFont(fontFamily))
    : supportsLightFont(selectedFontFamily);
  return jsxs20("div", { className: "excalidash-text-formatting", role: "group", "aria-label": formatting, children: [
    lightAvailable && jsx34("select", {
      "aria-label": german ? "Schriftstärke" : "Font weight",
      value: all("weight", 300) ? 300 : all("weight", 400) ? 400 : all("weight", 700) ? 700 : "",
      onChange: (event) => set("weight", Number(event.currentTarget.value)),
      children: [
        jsx34("option", { value: "", disabled: true, children: german ? "Gemischt" : "Mixed" }, "mixed"),
        jsx34("option", { value: 300, children: german ? "Leicht (300)" : "Light (300)" }, 300),
        jsx34("option", { value: 400, children: "Regular (400)" }, 400),
        jsx34("option", { value: 700, children: german ? "Fett (700)" : "Bold (700)" }, 700)
      ]
    }),
    jsxs20("div", { className: "excalidash-text-formatting-buttons", children: [
      toggle("weight", 700, german ? "Fett" : "Bold", german ? "F" : "B", 400, { fontWeight: 700 }),
      toggle("italic", true, german ? "Kursiv" : "Italic", "I", false, { fontStyle: "italic" }),
      toggle("underline", true, german ? "Unterstrichen" : "Underline", "U", false, { textDecoration: "underline" }),
      toggle("strikethrough", true, german ? "Durchgestrichen" : "Strikethrough", "S", false, { textDecoration: "line-through" })
    ] })
  ] });
}

function changeTextFormatting(elements, appState, change, app) {
  const candidates = changeProperty(elements, appState, (element) => {
    if (!isTextElement(element) || element.locked || element.isDeleted) return element;
    const current = getTextFormatting(element);
    const next = getTextFormatting({
      fontFamily: element.fontFamily, textFormatting: { ...current, ...change }
    });
    if (Object.keys(change).every((key) => current[key] === next[key])) return element;
    return newElementWith(element, { textFormatting: next });
  }, true);
  const updated = arrayToMap(candidates);
  let changed = false;
  candidates.forEach((element, index) => {
    const previous = elements[index];
    if (previous === element) return;
    changed = true;
    if (change.weight !== undefined || change.italic !== undefined) {
      const container = app.scene.getContainerElement(previous);
      // Work against a cloned container so undo captures the layout change.
      const updatedContainer = container ? { ...updated.get(container.id) } : null;
      redrawTextBoundingBox(element, updatedContainer, updated, false);
      offsetElementAfterFontResize(previous, element);
      if (container && updatedContainer && (container.width !== updatedContainer.width || container.height !== updatedContainer.height)) {
        updated.set(container.id, newElementWith(container, {
          width: updatedContainer.width, height: updatedContainer.height
        }));
      }
    }
  });
  if (changed) {
    for (const element of candidates) {
      if (element !== app.scene.getElement(element.id) && isTextElement(element)) {
        updateBoundElements(element, updated);
      }
    }
  }
  return {
    elements: changed ? elements.map(({ id }) => updated.get(id)) : elements,
    appState: {
      ...appState,
      currentItemTextFormatting: {
        ...appState.currentItemTextFormatting,
        ...change
      }
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY
  };
}
`;

function patchEditor(source: string) {
  source =
    'import { getTextFormatting, getTextDecoration, supportsLightFont } from "./chunk-4FTI6OG3.js";\n' +
    source;
  source = replace(
    source,
    "var actionChangeFontFamily = register({",
    controls + "var actionChangeFontFamily = register({",
  );
  source = replace(
    source,
    `    const { cachedElements, resetAll, resetContainers, ...nextAppState } = value;`,
    `    const { cachedElements, resetAll, resetContainers, textFormattingChange, ...nextAppState } = value;
    if (textFormattingChange) return changeTextFormatting(elements, appState, textFormattingChange, app);`,
  );
  source = replace(
    source,
    `      const chars = Array.from(uniqueChars.values()).join();`,
    `      const chars = Array.from(uniqueChars.values()).join();
      if (!skipFontFaceCheck && supportsLightFont(nextFontFamily) && elementContainerMapping.size) {
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
      ),
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
  return source;
}

export function excalidrawTypography(
  catalog: FontCatalog,
  revision: string,
): {
  vite: VitePlugin;
  optimizer: EsbuildPlugin;
} {
  const name = `excalidash-excalidraw-typography-${revision}`;
  let base = "/";
  const patch = (source: string, id: string) =>
    bundles.exec(id)?.[1] === "index"
      ? patchEditor(source)
      : patchCore(source, catalog);
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
          .flatMap(({ name, slug, weights }) =>
            weights.map(
              (weight) =>
                `@font-face{font-family:${JSON.stringify(name)};font-weight:${weight};font-display:swap;src:url("${base}board-fonts/${slug}-${weight}.woff2") format("woff2")}`,
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
