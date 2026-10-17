import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import ts from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "lib/db/generated/**",
    "public/judge/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    ".gemma-tmp/**",
    ".gemma-uma/**",
    "next-env.d.ts",
  ]),
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true }],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    // Check Hooks correctness without opting existing components into the
    // React Compiler's additional purity/ref/effect migration rules.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
]);
