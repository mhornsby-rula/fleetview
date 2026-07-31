// FleetView's OWN config shape (~/.fleetview.json) — shared by server + web.
// This is NOT Claude Code state; the firewall rule does not apply to this file.

/** Watched-repo config persisted to ~/.fleetview.json. */
export interface FleetViewConfig {
  /** Absolute repo paths FleetView monitors. Also feeds the adapter's FleetConfig.repos. */
  repos: string[];
  /** Repos where FleetView session reporting is enabled (CLAUDE.md instruction injected). */
  enabledRepos?: string[];
  /** Editor CLI used to open files from the UI (default "code"). e.g. "code", "cursor". */
  editor?: string;
  /** Server bind host. Default "127.0.0.1" (localhost only). Set "0.0.0.0" to expose on
   *  the LAN — UNAUTHENTICATED, so only on a trusted network. */
  host?: string;
}

/** POST /api/config request body. UI mutates via add/remove/enable/disable; server persists. */
export type ConfigRequest =
  | { action: 'add'; path: string }
  | { action: 'remove'; path: string }
  | { action: 'enable'; path: string }
  | { action: 'disable'; path: string };

/** Uniform response for GET/POST /api/config (servers report; UI decides). */
export interface ConfigResponse {
  ok: boolean;
  config: FleetViewConfig;
  /** Machine-readable failure code when ok === false. */
  reason?: string;
}

export const DEFAULT_CONFIG: FleetViewConfig = { repos: [] };
