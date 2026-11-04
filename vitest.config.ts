import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        // Every test injects a fake AI (withEnv); never open a remote session or need a wrangler login.
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only values. A test that needs a missing secret overrides env.
            PAYPAL_CLIENT_ID: "test-client-id",
            PAYPAL_CLIENT_SECRET: "test-client-secret",
            PAYPAL_WEBHOOK_ID: "WH-TEST",
            ANTHROPIC_API_KEY: "sk-ant-test",
            PUBLIC_BASE_URL: "https://furvet.test",
            DOCTOR_DEMO_USER: "doctor",
            DOCTOR_DEMO_PASSWORD: "test-doctor-pass",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // One Workers runtime at a time: the suite shares a machine with wrangler dev and
      // other agents; parallel runtimes made files abort silently under load.
      fileParallelism: false,
    },
  };
});
