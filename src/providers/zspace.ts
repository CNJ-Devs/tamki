import { ZSpaceRoute } from "./zspace-route";
import { traced, logEvent } from "../diagnostics";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  containsRemote,
  ProviderError,
  type StorageProvider,
} from "./provider";
import type { Entry } from "../shared/model";

type Runner = (args: string[], signal?: AbortSignal) => Promise<unknown>;
const number = z
  .union([z.number(), z.string().regex(/^\d+(\.\d+)?$/)])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
const remotePath = z
  .string()
  .startsWith("/")
  .max(4096)
  .refine((v) => path.posix.normalize(v) === v && !v.includes("\0"));
const listing = z.object({
  list: z.array(
    z.object({
      path: remotePath,
      name: z.string().min(1),
      is_dir: z.enum(["0", "1"]),
      size: number,
      modify_time: number,
    }),
  ),
  total: number,
});
export class ZSpaceProvider implements StorageProvider {
  constructor(
    private run: Runner,
    private roots: string[],
  ) {}
  private assertPath(target: string) {
    remotePath.parse(target);
    if (!this.roots.some((root) => containsRemote(root, target)))
      throw new ProviderError("outsideRoot");
  }
  static async spaces(run: Runner): Promise<string[]> {
    const result = z
      .object({
        personal_spaces: z.array(
          z.object({ path: remotePath, readable: z.boolean() }),
        ),
      })
      .parse(await run(["file", "space", "--params", "{}"]));
    return result.personal_spaces.filter((s) => s.readable).map((s) => s.path);
  }
  async list(directory: string, signal?: AbortSignal): Promise<Entry[]> {
    this.assertPath(directory);
    const entries: Entry[] = [],
      seen = new Set<string>();
    let total = Infinity;
    for (let start = 0; start < total;) {
      signal?.throwIfAborted();
      const page = listing.parse(
        await this.run(
          [
            "file",
            "list",
            "--params",
            JSON.stringify({
              path: directory,
              start,
              num: 200,
              sortby: "name",
              order: "asc",
            }),
          ],
          signal,
        ),
      );
      total = page.total;
      if (total > 500000 || (!page.list.length && start < total))
        throw new ProviderError("invalidListing");
      for (const item of page.list) {
        if (path.posix.dirname(item.path) !== directory || seen.has(item.path))
          throw new ProviderError("invalidListing");
        seen.add(item.path);
        entries.push({
          path: item.path,
          name: item.name,
          directory: item.is_dir === "1",
          size: item.size,
          modified: item.modify_time * 1000,
        });
      }
      start += page.list.length;
    }
    return entries.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  }
  async read(
    target: string,
    offset: number,
    length: number,
    expectedSize: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.assertPath(target);
    const data = z
      .object({
        path: remotePath,
        offset: number,
        size: number,
        bytes: number,
        content: z.string(),
        encoding: z.literal("base64"),
        next_offset: number.nullable(),
      })
      .parse(
        await this.run(
          [
            "file",
            "read",
            "--params",
            JSON.stringify({
              path: target,
              offset,
              max_bytes: length,
              encoding: "base64",
            }),
          ],
          signal,
        ),
      );
    const bytes = Buffer.from(data.content, "base64");
    if (
      data.path !== target ||
      data.offset !== offset ||
      data.size !== expectedSize ||
      data.bytes !== bytes.length ||
      bytes.length !== Math.min(length, expectedSize - offset) ||
      (data.next_offset === null
        ? offset + bytes.length !== expectedSize
        : data.next_offset !== offset + bytes.length)
    )
      throw new ProviderError("mediaChanged");
    return bytes;
  }
}

// Only an installed official CLI is used. Tamki neither ships its OAuth client ID nor reads its tokens.
export class ZSpaceCLI {
  private routes = new Map<string, ZSpaceRoute>();
  private loggedRoutes = new Map<string, string>();
  private children = new Set<ChildProcessWithoutNullStreams>();
  private logins = new Map<
    string,
    {
      child: ChildProcessWithoutNullStreams;
      completion: Promise<void>;
      expires: number;
    }
  >();
  constructor(
    private executable: string,
    private home: string,
    private allowLANHTTP: (profile: string) => boolean = () => false,
  ) {}
  private async child(profile: string, args: string[]) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(profile))
      throw new ProviderError("invalidInput");
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const child = spawn(
      this.executable,
      [
        "--profile",
        profile,
        "--credential-store",
        "keyring",
        "--timeout",
        "30",
        ...args,
      ],
      {
        shell: false,
        windowsHide: true,
        env: { ...process.env, ZSPACE_CLI_HOME: this.home },
      },
    );
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    return child;
  }
  runner(profile: string, timeout = 45000): Runner {
    return (args, signal) =>
      traced(
        "storage.cli",
        {
          provider: "zspace",
          operation: args
            .slice(0, 2)
            .filter((a) => /^[a-z-]+$/.test(a))
            .join("."),
        },
        async () => {
          let route = this.routes.get(profile);
          if (!route) {
            route = new ZSpaceRoute(
              (a, s) => this.run(profile, a, s, 8000),
              () => this.allowLANHTTP(profile),
            );
            this.routes.set(profile, route);
          }
          const routing = await route.select(signal);
          const phase = routing.includes("lan") ? "lan" : "cloud";
          if (this.loggedRoutes.get(profile) !== phase) {
            this.loggedRoutes.set(profile, phase);
            logEvent("storage.route", {
              provider: "zspace",
              connectionId: profile,
              phase,
            });
          }
          try {
            return await this.run(
              profile,
              [...routing, ...args],
              signal,
              timeout,
            );
          } catch (error) {
            route.invalidate();
            if (
              phase === "lan" &&
              args[0] === "file" &&
              ["list", "read", "info", "space"].includes(args[1]) &&
              error instanceof ProviderError &&
              ["connectionFailed", "requestTimeout"].includes(error.code)
            ) {
              logEvent("storage.route", {
                provider: "zspace",
                connectionId: profile,
                phase: "cloud",
                reason: "lan-read-failed",
              });
              return this.run(
                profile,
                ["--clear-host", "--mode", "cloud", ...args],
                signal,
                timeout,
              );
            }
            throw error;
          }
        },
      );
  }
  private async run(
    profile: string,
    args: string[],
    signal?: AbortSignal,
    timeout = 45000,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const child = await this.child(profile, args);
    return new Promise((resolve, reject) => {
      let output = "",
        errors = "";
      const stop = () => {
        child.kill();
        reject(new ProviderError("cancelled"));
      };
      const timer = setTimeout(() => {
        child.kill();
        reject(new ProviderError("requestTimeout"));
      }, timeout);
      signal?.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (b) => {
        output += b.toString();
        if (output.length > 8 * 1024 * 1024) {
          child.kill();
          reject(new ProviderError("invalidListing"));
        }
      });
      child.stderr.on("data", (b) => {
        errors = (errors + b.toString()).slice(-8192);
      });
      child.once("error", () => reject(new ProviderError("cliUnavailable")));
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        try {
          const result = JSON.parse(output || errors);
          if (code !== 0 || result.ok !== true)
            throw new ProviderError(
              result?.error?.code === "E_OAUTH" ||
                result?.error?.code === "E_AUTH"
                ? "authExpired"
                : "connectionFailed",
            );
          resolve(result.data);
        } catch (e) {
          reject(
            e instanceof ProviderError
              ? e
              : new ProviderError("connectionFailed"),
          );
        }
      });
      child.stdin.end();
    });
  }
  async begin(profile: string): Promise<{ url: string; expiresAt: number }> {
    this.cancel(profile);
    const child = await this.child(profile, [
      "login",
      "--no-open",
      "--auth-code-stdin",
    ]);
    let complete!: () => void, fail!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    void completion.catch(() => {});
    const expires = Date.now() + 180000;
    this.logins.set(profile, { child, completion, expires });
    return new Promise((resolve, reject) => {
      let buffer = "",
        finalOutput = "",
        success = false;
      const timer = setTimeout(() => {
        this.cancel(profile);
        reject(new ProviderError("authExpired"));
      }, 180000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 65536) {
          this.cancel(profile);
          reject(new ProviderError("connectionFailed"));
          return;
        }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const data = JSON.parse(line);
            if (data.event === "oauth_authorization") {
              const url = new URL(data.url);
              if (
                url.origin !== "https://oauth.zconnect.cn" ||
                url.pathname !== "/wbui/authorize"
              ) {
                this.cancel(profile);
                reject(new ProviderError("connectionFailed"));
                return;
              }
              resolve({ url: url.href, expiresAt: expires });
            }
            if (data.ok === true) success = true;
          } catch {
            finalOutput += line + "\n";
          }
        }
      });
      // Never return provider output that might contain sensitive state to the shell or logs.
      child.stderr.resume();
      child.once("error", () => {
        clearTimeout(timer);
        fail(new ProviderError("cliUnavailable"));
        reject(new ProviderError("cliUnavailable"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        try {
          success ||= JSON.parse(finalOutput + buffer).ok === true;
        } catch {}
        if (code === 0 && success) complete();
        else {
          fail(new ProviderError("authorizationFailed"));
          reject(new ProviderError("authorizationFailed"));
        }
      });
    });
  }
  async finish(profile: string, code: string) {
    const login = this.logins.get(profile);
    if (
      !login ||
      Date.now() >= login.expires ||
      !/^[A-Za-z0-9-]{8,100}$/.test(code)
    )
      throw new ProviderError("authExpired");
    login.child.stdin.end(code + "\n");
    try {
      await login.completion;
    } finally {
      this.logins.delete(profile);
    }
  }
  cancel(profile: string) {
    this.logins.get(profile)?.child.kill();
    this.logins.delete(profile);
  }
  close() {
    for (const child of this.children) child.kill();
    this.logins.clear();
  }
}
