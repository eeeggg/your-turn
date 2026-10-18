import { defineConfig } from "eslint/config";
import typescriptEslint from "typescript-eslint";

const vscodeApi = {
  name: "vscode",
  message: "Only adapters, extension.ts, and the integration suite may use the VS Code API.",
};

// Flat config replaces a rule's options rather than merging them, so every
// layer's rule repeats the parent-import ban.
/**
 * @param {{ paths?: { name: string, message: string }[], patterns?: { group: string[], message: string }[] }} [restrictions]
 * @returns {Pick<import("eslint/rules").ESLintRules, "no-restricted-imports">}
 */
function restrictImports({ paths = [], patterns = [] } = {}) {
  return {
    "no-restricted-imports": ["error", {
      paths,
      patterns: [
        { group: ["../*"], message: "Import across directories with @/; ./ is for the same directory." },
        ...patterns,
      ],
    }],
  };
}

export default defineConfig(
  {
    ignores: ["dist/**"],
  },
  {
    files: ["**/*.ts"],
    extends: typescriptEslint.configs.recommended,
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],
      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
      semi: "warn",
      ...restrictImports(),
    },
  },
  {
    files: ["src/core/**/*.ts", "src/shared/**/*.ts"],
    rules: restrictImports({
      paths: [vscodeApi],
      patterns: [{
        group: ["@/adapters/*", "@/webview/*"],
        message: "Core and shared code depend on neither adapters nor the webview; declare an interface for adapters to implement.",
      }],
    }),
  },
  {
    files: ["src/adapters/**/*.ts"],
    rules: restrictImports({
      patterns: [{
        group: ["@/webview/*"],
        message: "Adapters reach the webview only by webview messages; share their types through @/shared.",
      }],
    }),
  },
  {
    files: ["src/webview/**/*.ts"],
    rules: restrictImports({
      paths: [vscodeApi],
      patterns: [{
        group: ["@/core/*", "@/adapters/*"],
        message: "The webview reaches the extension only by webview messages; share their types through @/shared.",
      }],
    }),
  },
);
