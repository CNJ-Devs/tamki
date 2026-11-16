import type { OAuthAccount } from "./settings";

// Public local profile IDs only. OAuth client IDs and credentials stay in main.
export interface OpenAIProfiles {
  selectedId: string;
  profiles: { id: string; name: string; email: string; verified: boolean }[];
  account: OAuthAccount;
  revoked?: boolean;
}
