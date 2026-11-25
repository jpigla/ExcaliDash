import type { Plugin as VitePlugin } from "vite";

// Excalidraw 0.18.1 exposes no minimum-zoom option. Patch its locked bundles
// in memory so the built-in controls, shortcuts and zoom clamping agree.
const bundles =
  /[/\\]@excalidraw[/\\]excalidraw[/\\]dist[/\\](dev[/\\](?:index|chunk-4FTI6OG3)|prod[/\\](?:index|chunk-K2UTITRG))\.js$/;

function replaceOnce(source: string, original: string, replacement: string) {
  if (
    source.indexOf(original) === -1 ||
    source.indexOf(original) !== source.lastIndexOf(original)
  ) {
    throw new Error(
      `ExcaliDash zoom patch could not find a unique match for ${original}`,
    );
  }
  return source.replace(original, replacement);
}

function patchZoomActions(
  source: string,
  zoom: string,
  step: string,
  format = "",
) {
  // Round at the 10% boundary so fractional trackpad zoom can join either
  // direction of the whole-percent steps without skipping 10%.
  source = replaceOnce(
    source,
    `${zoom}${format}+${format}${step}`,
    `${zoom}<0.1?(Math.floor(${zoom}*100+1e-8)+1)/100:${zoom}+${step}`,
  );
  return replaceOnce(
    source,
    `${zoom}${format}-${format}${step}`,
    `${zoom}<=0.1?(Math.ceil(${zoom}*100-1e-8)-1)/100:Math.max(0.1,${zoom}-${step})`,
  );
}

export function patchZoom(source: string, bundle: string) {
  if (bundle.endsWith("chunk-4FTI6OG3")) {
    return replaceOnce(source, "var MIN_ZOOM = 0.1;", "var MIN_ZOOM = 0.01;");
  }
  if (bundle.endsWith("chunk-K2UTITRG")) {
    return replaceOnce(source, "DE=.1,Js=.1,Ys=30", "DE=.1,Js=.01,Ys=30");
  }
  if (bundle.startsWith("dev")) {
    return replaceOnce(
      patchZoomActions(source, "appState.zoom.value", "ZOOM_STEP", " "),
      'roundToStep(adjustedZoomValue, ZOOM_STEP, "floor")',
      'roundToStep(adjustedZoomValue, adjustedZoomValue < 0.1 ? 0.01 : ZOOM_STEP, "floor")',
    );
  }
  return replaceOnce(
    patchZoomActions(source, "o.zoom.value", "Fn"),
    'Ph(E,Fn,"floor")',
    'Ph(E,E<.1?.01:Fn,"floor")',
  );
}

export const excalidrawZoom: VitePlugin = {
  name: "excalidash-excalidraw-zoom",
  enforce: "pre",
  transform(source, id) {
    const match = bundles.exec(id);
    if (match) return patchZoom(source, match[1]);
  },
};
