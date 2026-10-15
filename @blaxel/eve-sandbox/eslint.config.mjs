// @ts-check

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "eslint.config.mjs"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
    languageOptions: {
      ...(config.languageOptions || {}),
      parserOptions: {
        ...(config.languageOptions?.parserOptions || {}),
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),
  {
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
