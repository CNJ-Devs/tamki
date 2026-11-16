import {
  Menu,
  clipboard,
  type WebContents,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from "electron";
import { isWebURL } from "./navigation";
import { browserMessages } from "./shared/browser-messages";
export type BrowserLabels = typeof browserMessages.en;
export function pageMenu(
  wc: WebContents,
  t: BrowserLabels,
  actions: {
    find(): void;
    zoom(direction: number): void;
    back: string;
    forward: string;
    reload: string;
  },
): MenuItemConstructorOptions[] {
  return [
    {
      label: actions.back,
      enabled: wc.navigationHistory.canGoBack(),
      click: () => wc.navigationHistory.goBack(),
    },
    {
      label: actions.forward,
      enabled: wc.navigationHistory.canGoForward(),
      click: () => wc.navigationHistory.goForward(),
    },
    { label: actions.reload, click: () => wc.reload() },
    { label: t.hardReload, click: () => wc.reloadIgnoringCache() },
    { type: "separator" },
    { label: t.findPage, click: actions.find },
    { label: t.zoomIn, click: () => actions.zoom(1) },
    { label: t.zoomOut, click: () => actions.zoom(-1) },
    {
      label: `${t.resetZoom} (${Math.round(wc.getZoomFactor() * 100)}%)`,
      click: () => actions.zoom(0),
    },
  ];
}
export function showWebMenu(
  wc: WebContents,
  p: ContextMenuParams,
  t: BrowserLabels,
  open: (url: string, background: boolean) => void,
  page: MenuItemConstructorOptions[],
  search: (text: string) => string,
) {
  const items: MenuItemConstructorOptions[] = [];
  const section = (group: MenuItemConstructorOptions[]) => {
    if (items.length) items.push({ type: "separator" });
    items.push(...group);
  };
  if (isWebURL(p.linkURL))
    section([
      { label: t.openLinkBackground, click: () => open(p.linkURL, true) },
      { label: t.openLinkForeground, click: () => open(p.linkURL, false) },
      { label: t.copyLink, click: () => clipboard.writeText(p.linkURL) },
      { label: t.saveLink, click: () => wc.downloadURL(p.linkURL) },
    ]);
  if (p.mediaType === "image") {
    const group: MenuItemConstructorOptions[] = [];
    if (isWebURL(p.srcURL))
      group.push(
        { label: t.openImage, click: () => open(p.srcURL, true) },
        {
          label: t.copyImageAddress,
          click: () => clipboard.writeText(p.srcURL),
        },
        { label: t.saveImage, click: () => wc.downloadURL(p.srcURL) },
      );
    if (p.hasImageContents)
      group.push({ label: t.copyImage, click: () => wc.copyImageAt(p.x, p.y) });
    if (group.length) section(group);
  }
  if (p.isEditable)
    section([
      {
        label: t.browserUndo,
        enabled: p.editFlags.canUndo,
        click: () => wc.undo(),
      },
      {
        label: t.browserRedo,
        enabled: p.editFlags.canRedo,
        click: () => wc.redo(),
      },
      {
        label: t.browserCut,
        enabled: p.editFlags.canCut,
        click: () => wc.cut(),
      },
      {
        label: t.browserCopy,
        enabled: p.editFlags.canCopy,
        click: () => wc.copy(),
      },
      {
        label: t.browserPaste,
        enabled: p.editFlags.canPaste,
        click: () => wc.paste(),
      },
      {
        label: t.browserSelectAll,
        enabled: p.editFlags.canSelectAll,
        click: () => wc.selectAll(),
      },
    ]);
  else if (p.selectionText.trim())
    section([
      {
        label: t.browserCopy,
        enabled: p.editFlags.canCopy,
        click: () => wc.copy(),
      },
    ]);
  if (!p.isEditable && p.selectionText.trim())
    section([
      {
        label: t.searchSelection,
        click: () => open(search(p.selectionText.trim().slice(0, 2000)), false),
      },
    ]);
  section(page);
  Menu.buildFromTemplate(items).popup();
}
