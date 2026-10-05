import js from "@eslint/js";
import globals from "globals";

// ESLint's recommended rules for correctness, nothing stylistic: formatting is
// Prettier's job (npm run format).
export default [
  { ignores: ["node_modules/", "dist/", "images/", "output/", ".pixmith/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none" }],
      // "smart" still allows the deliberate `x == null` (null or undefined).
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
  {
    // The fake Codex is CommonJS, so it can run as a plain script on every Node.
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
];
