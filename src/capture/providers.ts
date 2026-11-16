import type { CaptureResource, CaptureResult } from "../shared/capture";
import type { ResolvedMedia } from "./bilibili";
import { ProviderError } from "../providers/provider";

export interface CaptureAdapter {
  readonly id: CaptureResource["provider"];
  supports(url: string): boolean;
  discover(
    url: string,
    signal: AbortSignal,
  ): Promise<CaptureResult | undefined>;
  resolve(
    resource: CaptureResource,
    signal: AbortSignal,
  ): Promise<ResolvedMedia>;
}
/** Platform discovery/resolution is independent of the browser overlay and queue. */
export class MediaCapture {
  constructor(private adapters: CaptureAdapter[]) {}
  supports(url: string) {
    return this.adapters.some((adapter) => adapter.supports(url));
  }
  discover(url: string, signal: AbortSignal) {
    return (
      this.adapters
        .find((adapter) => adapter.supports(url))
        ?.discover(url, signal) ?? Promise.resolve(undefined)
    );
  }
  resolve(resource: CaptureResource, signal: AbortSignal) {
    const adapter = this.adapters.find(
      (adapter) => adapter.id === resource.provider,
    );
    if (!adapter) throw new ProviderError("captureUnavailable");
    return adapter.resolve(resource, signal);
  }
}
