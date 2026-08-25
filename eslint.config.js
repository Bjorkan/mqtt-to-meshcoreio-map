import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["tests/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        DOMException: "readonly",
        console: "readonly",
        process: "readonly",
        setImmediate: "readonly",
      },
    },
  },
  eslintConfigPrettier,
);
