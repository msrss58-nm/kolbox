import { MockApi } from "./mockApi";
import type { ApiClient } from "./types";

/** The app-wide ApiClient singleton. Post-MVP: swap MockApi → SupabaseApi here. */
export const api: ApiClient = new MockApi();

export type * from "./types";
