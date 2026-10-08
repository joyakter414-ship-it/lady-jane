/** Bindings + secrets available to the Worker. */
export interface AppEnv {
  AI: Ai;
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Password for the web dashboard (secret). */
  DASHBOARD_PASSWORD: string;
  /** Shared token the WhatsApp gateway uses to talk to the brain (secret). */
  GATEWAY_TOKEN: string;
  /** GitHub Personal Access Token to trigger workflow dispatches (secret). */
  GITHUB_PAT?: string;
  /** GitHub repository owner/name (secret or var). */
  GITHUB_REPO?: string;
}

