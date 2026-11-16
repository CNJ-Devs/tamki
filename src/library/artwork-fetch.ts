import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
export function publicArtworkAddress(address: string): boolean {
  return isIP(address) === 4
    ? !blocked.check(address, "ipv4")
    : isIP(address) === 6 &&
        publicV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export function artworkURL(value: string): string {
  const url = new URL(value),
    host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (!host.includes(".") && !isIP(host)) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
    (isIP(host) && !publicArtworkAddress(host))
  )
    throw new Error("artworkUnavailable");
  return url.href;
}
export async function resolveArtworkAddress(host: string, resolve = lookup) {
  const addresses = await resolve(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((a) => !publicArtworkAddress(a.address))
  )
    throw new Error("artworkUnavailable");
  return addresses[0];
}
/** Public HTTPS only. Pin DNS to the checked address; redirects are checked anew. */
export const publicArtworkFetch: typeof fetch = async (input, init) => {
  let url = new URL(artworkURL(String(input)));
  const signal = AbortSignal.any([
    ...(init?.signal ? [init.signal] : []),
    AbortSignal.timeout(20000),
  ]);
  for (let hop = 0; hop < 4; hop++) {
    signal.throwIfAborted();
    const address = await new Promise<{ address: string; family: number }>(
      (resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        resolveArtworkAddress(url.hostname.replace(/^\[|\]$/g, ""))
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      },
    );
    signal.throwIfAborted();
    const response = await new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: "GET",
          agent: false,
          signal,
          headers: {
            Accept:
              new Headers(init?.headers).get("Accept") ||
              "image/jpeg,image/png,image/webp",
            "User-Agent": "Tamki/0.1.0",
          },
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (res) => {
          const status = res.statusCode || 500;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = res.headers.location;
            res.destroy();
            resolve(
              new Response(null, {
                status,
                headers: location ? { location } : {},
              }),
            );
            return;
          }
          const limit = (res.headers["content-type"] || "").includes(
            "text/html",
          )
            ? 2 * 1024 * 1024
            : 8 * 1024 * 1024;
          if (Number(res.headers["content-length"] || 0) > limit) {
            res.destroy();
            reject(new Error("artworkUnavailable"));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > limit) {
              res.destroy(new Error("artworkUnavailable"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              resolve(
                new Response(
                  [204, 205, 304].includes(status)
                    ? null
                    : Buffer.concat(chunks),
                  {
                    status,
                    headers: {
                      "content-type": res.headers["content-type"] || "",
                    },
                  },
                ),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("artworkUnavailable");
    url = new URL(artworkURL(new URL(location, url).href));
  }
  throw new Error("artworkUnavailable");
};

/** Fixed provider CDN paths may use Chromium's configured proxy. Arbitrary AI
 * URLs still use the DNS-pinned public fetcher; CDN redirects are never followed. */
export function providerArtworkFetch(browserFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(artworkURL(String(input)));
    const bangumi =
      url.hostname === "lain.bgm.tv" &&
      /^\/(?:r\/\d+\/)?pic\/cover\/[a-z]\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-zA-Z0-9_]+\.(?:jpg|png|webp)$/.test(
        url.pathname,
      ) &&
      !url.search;
    const bilibili =
      ["hdslb.com", "biliimg.com"].some(
        (h) => url.hostname === h || url.hostname.endsWith(`.${h}`),
      ) &&
      /^\/bfs\/[-a-zA-Z0-9_/.]+\.(?:jpg|jpeg|png|webp)$/.test(url.pathname) &&
      !url.search;
    if (bangumi || bilibili) {
      const headers = new Headers(init?.headers);
      if (bilibili) headers.set("Referer", "https://www.bilibili.com/");
      const response = await browserFetch(url.href, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400)
        throw new Error("artworkUnavailable");
      return response;
    }
    return publicArtworkFetch(url.href, init);
  };
}
