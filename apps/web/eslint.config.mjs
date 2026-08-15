import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    rules: {
      // The codebase has written `_previous` / `_formData` since R-008 to mean
      // "this parameter exists because the signature demands it, and is
      // deliberately unused" — every `useActionState` action has one, because
      // React passes previous state whether or not the action wants it.
      //
      // The convention was never actually configured. It went unnoticed
      // because ESLint's default `args: "after-used"` only reports UNUSED
      // TRAILING parameters, and in almost every action the last parameter
      // (`formData`) is used — so the `_previous` before it was silently
      // exempt. An action that ignores both, which R-049's `retireTemplate` is
      // the first of, reports two warnings for following the same convention
      // as everything around it.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
