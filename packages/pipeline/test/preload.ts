// Loaded before every test file (see bunfig.toml).
// Tests must not depend on a developer's personal `.env` / `.env.local`, nor on
// CI-provided variables. Child processes spawned by tests inherit this too.
import { CONFIG_ENV_KEYS } from "../src/env-keys.ts";

process.env.RISCV_CN_NO_DOTENV = "1";
for (const key of CONFIG_ENV_KEYS) {
  delete process.env[key];
}
