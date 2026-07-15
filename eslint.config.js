import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "playwright-report/", "test-results/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["validation/**/*.spec.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
