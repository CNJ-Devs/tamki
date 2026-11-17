import {
  dialog,
  Menu,
  type Session,
  type WebContents,
  type BaseWindow,
} from "electron";
import { z } from "zod";
import { isWebURL } from "./navigation";
import { browserMessages } from "./shared/browser-messages";
type Labels = typeof browserMessages.en;
type Store = {
  config(key: string): string | null | undefined;
  setConfig(key: string, value: string): void;
};
const permissions = [
  "notifications",
  "media",
  "geolocation",
  "clipboard-read",
  "fullscreen",
] as const;
type Permission = (typeof permissions)[number];
const schema = z.record(
  z.string(),
  z.record(z.string(), z.enum(["allow", "block"])),
);
function origin(url: string) {
  return isWebURL(url) ? new URL(url).origin : undefined;
}
export class BrowserSites {
  private pending = new Map<string, Promise<boolean>>();
  constructor(
    private store: Store,
    private labels: () => Labels,
    private window: () => BaseWindow,
    private active: (wc: WebContents) => boolean,
  ) {}
  private saved() {
    try {
      return schema.parse(
        JSON.parse(this.store.config("browserPermissions") || "{}"),
      );
    } catch {
      return {};
    }
  }
  private decision(site: string, permission: string) {
    return this.saved()[site]?.[permission];
  }
  private save(site: string, permission: string, value?: "allow" | "block") {
    const saved = this.saved();
    const row = saved[site] || {};
    if (value) row[permission] = value;
    else delete row[permission];
    saved[site] = row;
    this.store.setConfig("browserPermissions", JSON.stringify(saved));
  }
  private name(p: Permission) {
    const t = this.labels();
    return {
      notifications: t.permissionNotifications,
      media: t.permissionMedia,
      geolocation: t.permissionLocation,
      "clipboard-read": t.permissionClipboard,
      fullscreen: t.permissionFullscreen,
    }[p];
  }
  install(profile: Session, isRemote: (wc: WebContents | null) => boolean) {
    profile.setPermissionCheckHandler((wc, p, requestingOrigin, details) => {
      if (!wc || !isRemote(wc)) return false;
      const site = origin(wc.getURL()),
        request = origin(requestingOrigin || details.requestingUrl || "");
      return (
        !!site &&
        request === site &&
        permissions.includes(p as Permission) &&
        this.decision(site, p) === "allow"
      );
    });
    profile.setPermissionRequestHandler((wc, p, callback, details) => {
      const site = origin(wc.getURL()),
        request = origin(details.requestingUrl);
      if (
        !isRemote(wc) ||
        !site ||
        site !== request ||
        !permissions.includes(p as Permission)
      ) {
        callback(false);
        return;
      }
      const saved = this.decision(site, p);
      if (saved) {
        callback(saved === "allow");
        return;
      }
      if (!this.active(wc)) {
        callback(false);
        return;
      }
      const key = `${site}|${p}`;
      let pending = this.pending.get(key);
      if (!pending) {
        const t = this.labels();
        pending = dialog
          .showMessageBox(this.window(), {
            type: "question",
            title: t.sitePermissions,
            message: site,
            detail: `${t.permissionRequest}: ${this.name(p as Permission)}`,
            buttons: [t.permissionBlock, t.permissionAllow],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
          .then((result) => {
            if (wc.isDestroyed() || origin(wc.getURL()) !== site) return false;
            const allowed = result.response === 1;
            this.save(site, p, allowed ? "allow" : "block");
            return allowed;
          })
          .catch(() => false)
          .finally(() => this.pending.delete(key));
        this.pending.set(key, pending);
      }
      void pending.then((allowed) =>
        callback(allowed && !wc.isDestroyed() && origin(wc.getURL()) === site),
      );
    });
  }
  show(wc: WebContents) {
    const site = origin(wc.getURL());
    if (!site) return;
    const t = this.labels();
    Menu.buildFromTemplate([
      { label: site, enabled: false },
      ...permissions.map((p) => ({
        label: this.name(p),
        submenu: [
          {
            label: t.permissionAsk,
            type: "radio" as const,
            checked: !this.decision(site, p),
            click: () => this.save(site, p),
          },
          {
            label: t.permissionAllow,
            type: "radio" as const,
            checked: this.decision(site, p) === "allow",
            click: () => this.save(site, p, "allow"),
          },
          {
            label: t.permissionBlock,
            type: "radio" as const,
            checked: this.decision(site, p) === "block",
            click: () => this.save(site, p, "block"),
          },
        ],
      })),
      { type: "separator" },
      {
        label: t.permissionReload,
        click: () => {
          if (!wc.isDestroyed() && origin(wc.getURL()) === site) wc.reload();
        },
      },
      {
        label: t.resetSitePermissions,
        click: () => {
          for (const p of permissions) this.save(site, p);
        },
      },
      {
        label: t.clearSiteData,
        click: () => {
          void this.clear(wc, site).catch(() => {});
        },
      },
    ]).popup({ window: this.window() });
  }
  private async clear(wc: WebContents, site: string) {
    const t = this.labels();
    const answer = await dialog.showMessageBox(this.window(), {
      type: "warning",
      message: t.clearSiteData,
      detail: `${site}\n${t.clearSiteDataHelp}`,
      buttons: [t.browserCancel, t.clearSiteData],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1 || wc.isDestroyed()) return;
    try {
      await wc.session.clearData({
        origins: [site],
        originMatchingMode: "origin-in-all-contexts",
        dataTypes: [
          "cache",
          "cookies",
          "fileSystems",
          "indexedDB",
          "localStorage",
          "serviceWorkers",
          "webSQL",
        ],
      });
      if (!wc.isDestroyed() && origin(wc.getURL()) === site) wc.reload();
    } catch {
      await dialog.showMessageBox(this.window(), {
        type: "error",
        message: t.clearSiteDataFailed,
        buttons: [t.browserOK],
      });
    }
  }
}
