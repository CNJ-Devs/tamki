import type { AuthorizationState } from "../../src/shared/authorization";

interface AuthorizationClient {
  authorization(id: string): AuthorizationState | null;
  openAuthorization(id: string, attempt: string): Promise<void>;
}

export async function waitForAuthorization(
  client: AuthorizationClient,
  id: string,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = client.authorization(id);
    if (state?.url) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Authorization URL was not generated");
}

/** Simulates the user's explicit Open in browser action against a synthetic launcher. */
export async function authorize<T>(
  login: Promise<T>,
  client: AuthorizationClient,
  id: string,
): Promise<T> {
  void login.catch(() => {});
  const state = await waitForAuthorization(client, id);
  await client.openAuthorization(id, state.id);
  return login;
}
