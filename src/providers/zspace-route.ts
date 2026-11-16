import { networkInterfaces } from "node:os";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

type Run = (args: string[], signal?: AbortSignal) => Promise<unknown>;
const cloud = ["--clear-host", "--mode", "cloud"];
function ipv4(value: string): number | undefined {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)
  )
    return;
  return parts.reduce((n, p) => (n * 256 + Number(p)) >>> 0, 0);
}
export function samePrivateNetwork(
  address: string,
  networks = networkInterfaces(),
): boolean {
  const ip = ipv4(address);
  if (
    ip === undefined ||
    !(
      address.startsWith("10.") ||
      address.startsWith("192.168.") ||
      ip >>> 20 === 0xac1
    )
  )
    return false;
  return Object.values(networks)
    .flat()
    .some((n) => {
      if (!n || n.internal || n.family !== "IPv4") return false;
      const local = ipv4(n.address),
        mask = ipv4(n.netmask);
      return (
        local !== undefined &&
        mask !== undefined &&
        mask !== 0 &&
        (local & mask) === (ip & mask) &&
        local !== ip
      );
    });
}
async function reachable(host: string, secure: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = secure
      ? tlsConnect({ host, port: 5056, rejectUnauthorized: true })
      : tcpConnect({ host, port: 5055 });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1200, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once(secure ? "secureConnect" : "connect", () => finish(true));
  });
}
/** Candidates come only from the authenticated NAS, never unauthenticated LAN discovery. */
export class ZSpaceRoute {
  private cached?: { key: string; until: number; args: string[] };
  private pending?: Promise<string[]>;
  constructor(
    private run: Run,
    private allowHTTP: () => boolean,
    private probe = reachable,
    private networks = networkInterfaces,
  ) {}
  invalidate() {
    this.cached = undefined;
  }
  async select(signal?: AbortSignal): Promise<string[]> {
    const key = JSON.stringify([this.networks(), this.allowHTTP()]);
    if (this.cached?.key === key && this.cached.until > Date.now())
      return this.cached.args;
    if (!this.pending)
      this.pending = this.discover()
        .then((args) => {
          this.cached = { key, until: Date.now() + 30000, args };
          return args;
        })
        .finally(() => {
          this.pending = undefined;
        });
    const result = await this.pending;
    signal?.throwIfAborted();
    return result;
  }
  private async discover(signal?: AbortSignal): Promise<string[]> {
    try {
      const data = (await this.run(
        [
          ...cloud,
          "system",
          "network",
          "--params",
          JSON.stringify({ action: "interfaces" }),
        ],
        signal,
      )) as { list?: { ipv4_address?: string; status?: string }[] };
      for (const item of (data.list || []).slice(0, 16)) {
        const address = item.ipv4_address;
        if (
          !address ||
          item.status !== "up" ||
          !samePrivateNetwork(address, this.networks())
        )
          continue;
        if (await this.probe(address, true))
          return ["--mode", "lan", "--host", `https://${address}:5056`];
        if (this.allowHTTP() && (await this.probe(address, false)))
          return [
            "--mode",
            "lan",
            "--host",
            `http://${address}:5055`,
            "--allow-insecure-http",
          ];
      }
    } catch {
      signal?.throwIfAborted();
    }
    return cloud;
  }
}
