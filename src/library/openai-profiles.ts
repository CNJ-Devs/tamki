import { randomUUID } from "node:crypto";
import type { LibraryStore } from "./store";
import type {
  OAuthRecord,
  OAuthRegistration,
  OAuthStorage,
} from "../providers/openai-oauth";
import type { SettingsState } from "../shared/settings";
import { ProviderError } from "../providers/provider";

interface Profile {
  id: string;
  name: string;
  registration?: OAuthRegistration;
}
interface Registry {
  profiles: Profile[];
  bindings: Record<string, string>;
  preferred?: string;
}
const registryKey = "openaiOAuthRegistrations";
const sessionKey = (id: string) => `openaiOAuthSession:${id}`;

/** One renewable session per registration, independent of editable connection rows.
 * Unsaved sessions stay in memory; issued registration IDs are always durable. */
export class OpenAIProfiles implements OAuthStorage {
  private data?: Registry;
  private drafts = new Map<string, OAuthRecord>();
  constructor(
    private store: LibraryStore,
    private protect: (value: string) => string,
    private reveal: (value: string) => string,
    private saved: (id: string) => boolean,
  ) {}

  host() {
    return this.store.config("openaiOAuthHost") || undefined;
  }
  setHost(value: string) {
    this.store.setConfig("openaiOAuthHost", value);
  }
  private load() {
    if (this.data) return this.data;
    const raw = this.store.config(registryKey);
    const data: Registry = raw
      ? JSON.parse(this.reveal(raw))
      : { profiles: [], bindings: {} };
    data.bindings = Object.assign(Object.create(null), data.bindings);
    // Migrate the former per-source credential records without registering again.
    const settings = JSON.parse(
      this.store.config("settings") || "null",
    ) as SettingsState | null;
    const sources = [
      ...(settings?.aiConnections || []),
      ...(settings?.recognition.sources || []),
    ];
    const changes: Record<string, string> = {};
    for (const source of sources) {
      if (source.provider !== "openai-oauth") continue;
      const legacyKey = `source:${source.id}:oauth`;
      const legacy = this.store.config(legacyKey);
      if (!legacy || legacyKey in changes) continue;
      const record = JSON.parse(this.reveal(legacy)) as OAuthRecord;
      let profile = data.profiles.find(
        (p) => p.registration?.clientId === record.clientId,
      );
      if (
        profile?.registration?.subject &&
        profile.registration.subject !== record.subject
      )
        throw new ProviderError("oauthAccountMismatch");
      if (!profile) {
        profile = {
          id: randomUUID(),
          name: source.name,
          registration: {
            clientId: record.clientId,
            subject: record.subject,
            email: record.email,
          },
        };
        data.profiles.push(profile);
      }
      data.bindings[source.id] = profile.id;
      data.preferred ??= profile.id;
      // A canonical session wins over a stale legacy copy after migration.
      if (
        !this.store.config(sessionKey(profile.id)) &&
        !(sessionKey(profile.id) in changes)
      )
        changes[sessionKey(profile.id)] = this.protect(JSON.stringify(record));
      changes[legacyKey] = "";
    }
    // Draft row IDs are not durable identities. Keep their registrations, not the
    // abandoned bindings, after a process restart.
    for (const id of Object.keys(data.bindings))
      if (!this.saved(id)) delete data.bindings[id];
    data.profiles = data.profiles.filter(
      (p) => p.registration || Object.values(data.bindings).includes(p.id),
    );
    for (const profile of data.profiles)
      if (!Object.values(data.bindings).includes(profile.id))
        changes[sessionKey(profile.id)] = "";
    if (raw || data.profiles.length || Object.keys(changes).length)
      this.store.setConfigs({
        ...changes,
        [registryKey]: this.protect(JSON.stringify(data)),
      });
    this.data = data;
    return data;
  }
  private persist(changes: Record<string, string> = {}) {
    try {
      this.store.setConfigs({
        ...changes,
        [registryKey]: this.protect(JSON.stringify(this.load())),
      });
    } catch (error) {
      this.data = undefined;
      throw error;
    }
  }
  key(id: string) {
    const data = this.load();
    return data.profiles.some((p) => p.id === id)
      ? id
      : data.bindings[id] || id;
  }
  has(id: string) {
    return !!this.load().bindings[id];
  }
  ensure(id: string, name: string) {
    if (this.has(id)) {
      const profile = this.load().profiles.find((p) => p.id === this.key(id));
      if (profile && !profile.registration && profile.name !== name) {
        profile.name = name;
        this.persist();
      }
      return;
    }
    const data = this.load();
    const preferred =
      data.profiles.find((p) => p.id === data.preferred && p.registration) ||
      data.profiles.find((p) => p.registration);
    this.select(id, name, preferred?.id || null);
  }
  select(id: string, name: string, profileId: string | null) {
    const data = this.load();
    if (data.profiles.some((p) => p.id === id))
      throw new ProviderError("invalidInput");
    let profile = profileId
      ? data.profiles.find((p) => p.id === profileId && p.registration)
      : undefined;
    if (profileId && !profile) throw new ProviderError("invalidInput");
    if (!profile) {
      profile = { id: randomUUID(), name };
      data.profiles.push(profile);
    }
    data.bindings[id] = profile.id;
    if (profile.registration) data.preferred = profile.id;
    data.profiles = data.profiles.filter(
      (p) => p.registration || Object.values(data.bindings).includes(p.id),
    );
    this.persist();
  }
  profiles() {
    return this.load()
      .profiles.filter((p) => p.registration)
      .map((p) => ({
        id: p.id,
        name: p.name,
        email: p.registration!.email,
        verified: !!p.registration!.subject,
      }));
  }
  registration(id: string) {
    return this.load().profiles.find((p) => p.id === this.key(id))
      ?.registration;
  }
  register(id: string, registration: OAuthRegistration) {
    this.updateRegistration(id, registration);
    this.persist();
  }
  private updateRegistration(id: string, registration: OAuthRegistration) {
    const data = this.load(),
      profile = data.profiles.find((p) => p.id === this.key(id));
    if (!profile) throw new ProviderError("invalidInput");
    if (
      profile.registration &&
      (profile.registration.clientId !== registration.clientId ||
        (profile.registration.subject &&
          profile.registration.subject !== registration.subject))
    )
      throw new ProviderError("oauthAccountMismatch");
    profile.registration = { ...registration };
    data.preferred = profile.id;
  }
  read(id: string): OAuthRecord | undefined {
    const key = this.key(id),
      draft = this.drafts.get(key);
    if (draft) return draft;
    const raw = this.store.config(sessionKey(key));
    if (raw) return JSON.parse(this.reveal(raw));
    const registration = this.registration(id);
    return registration?.subject
      ? {
          ...registration,
          subject: registration.subject,
          scopes: [],
          expiresAt: 0,
        }
      : undefined;
  }
  write(id: string, record: OAuthRecord | undefined) {
    const key = this.key(id);
    if (record)
      this.updateRegistration(id, {
        clientId: record.clientId,
        subject: record.subject,
        email: record.email,
      });
    const hasSaved = Object.entries(this.load().bindings).some(
      ([binding, profile]) => profile === key && this.saved(binding),
    );
    if (record?.accessToken && !hasSaved) {
      this.persist();
      this.drafts.set(key, record);
      return;
    }
    this.persist({
      [sessionKey(key)]: record?.accessToken
        ? this.protect(JSON.stringify(record))
        : "",
    });
    this.drafts.delete(key);
  }
  prepareCommit(id: string): Record<string, string> {
    const record = this.read(id);
    if (!record?.accessToken) throw new ProviderError("oauthSignInRequired");
    return { [sessionKey(this.key(id))]: this.protect(JSON.stringify(record)) };
  }
  committed(id: string) {
    this.drafts.delete(this.key(id));
  }
  hasPeers(id: string) {
    const key = this.key(id);
    return Object.entries(this.load().bindings).some(
      ([other, profile]) => other !== id && profile === key,
    );
  }
  release(id: string) {
    const data = this.load(),
      key = this.key(id);
    delete data.bindings[id];
    if (!Object.values(data.bindings).includes(key)) {
      this.drafts.delete(key);
      data.profiles = data.profiles.filter(
        (p) => p.id !== key || p.registration,
      );
    }
    this.persist();
  }
  close() {
    this.drafts.clear();
  }
}
