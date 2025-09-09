// @ts-check

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // 1. Global ignores
  {
    ignores: ["dist", "tmp", "eslint.config.mjs"],
  },

  // 2. Basic ESLint recommendations
  eslint.configs.recommended,

  // 3. Basic TypeScript recommendations
  ...tseslint.configs.recommended,

  // 4. Type-checked recommendations for TS files only
  // Map over the recommendedTypeChecked array to add file scoping and parser options
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"], // Apply only to TS files
    languageOptions: {
      // Ensure parserOptions are correctly set
      ...(config.languageOptions || {}), // Merge existing languageOptions if any
      parserOptions: {
        ...(config.languageOptions?.parserOptions || {}), // Merge existing parserOptions
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),

  // 5. Custom rule overrides for all applicable files
  {
    // If necessary, specify files: ["**/*.{js,mjs,cjs,ts,tsx}"]
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": "allow-with-description"
        }
      ]
    },
  }
);