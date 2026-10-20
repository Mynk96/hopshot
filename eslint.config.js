// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // marketing/ is hand-maintained and live in production (CLAUDE.md repo map).
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.astro/**",
      "**/.wrangler/**",
      "**/target/**",
      "**/node_modules/**",
      "**/worker-configuration.d.ts",
      "marketing/**",
      "design/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The service worker runs in ServiceWorkerGlobalScope, not a browser window. Flat config
    // removed `/* eslint-env */`, so its globals are declared here instead of exempting the
    // file — the cache policy in there is worth linting.
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // A leading underscore marks a parameter kept for signature compatibility � common in
      // the placeholder modules that later phases fill in.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
