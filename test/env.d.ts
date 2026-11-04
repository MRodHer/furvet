import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/env";

// `env` from "cloudflare:test" is typed as Cloudflare.Env. The app declares its own Env
// (wrangler types runs with --include-env=false), so the test runtime env is declared
// here as the app Env plus the test-only migrations binding.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
