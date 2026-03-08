import { scrubEnv } from "./packages/opencode/src/util/env"
const mockProcessEnv = { OPENAI_API_KEY: "secret", NORMAL_VAR: "value" }
const mockShellEnv = { OPENAI_API_KEY: "secret", NORMAL_VAR: "value" }

const finalEnv = {
  ...scrubEnv(mockProcessEnv),
  ...mockShellEnv
}

console.log(finalEnv)
