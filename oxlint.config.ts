import uinaf, { env, ignorePatterns, options } from "@uinaf/oxlint-config/effect";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [uinaf],
  env,
  ignorePatterns: [...ignorePatterns, ".alchemy/**", "dist/**", "workshop/**"],
  jsPlugins: ["@xstate/effect/oxlint"],
  options,
  rules: {
    "@nkzw/no-instanceof": "off",
    "curly": "off",
    "eqeqeq": "off",
    "no-control-regex": "off",
    "no-empty": "off",
    "import/no-namespace": "off",
    "react-hooks/rules-of-hooks": "off",
    "typescript/no-explicit-any": "off",
    "typescript/no-misused-spread": "off",
    "typescript/no-unsafe-argument": "off",
    "typescript/no-unsafe-assignment": "off",
    "typescript/no-unsafe-call": "off",
    "typescript/no-unsafe-member-access": "off",
    "typescript/no-unsafe-return": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/unbound-method": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/prefer-structured-clone": "off",
    "unicorn/catch-error-name": ["error", { ignore: ["^cause$"] }],
    "oxc/no-accumulating-spread": "error",
    "xstate-effect/no-inline-effect": "error",
  },
  overrides: [
    {
      files: ["scripts/**", "src/server/testing/**", "src/client/main.ts"],
      rules: { "no-console": "off" },
    },
  ],
});
