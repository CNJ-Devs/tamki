/** Ephemeral browser authorization metadata. Never includes tokens or PKCE secrets. */
export interface AuthorizationState {
  id: string;
  status: "preparing" | "waiting" | "finishing";
  expiresAt: number;
  url?: string;
  browserError?: boolean;
}
