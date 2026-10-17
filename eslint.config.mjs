import { defineConfig } from "eslint/config";
import typescriptEslint from "typescript-eslint";

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
    },
  },
  {
    // Logic that stays free of the VS Code API, so the unit suite can import it.
    files: [
      "src/webview/**/*.ts",
      "src/ui/ChatHtml.ts",
      "src/core/AcpClientImpl.ts",
      "src/core/AgentManager.ts",
      "src/core/ConnectionManager.ts",
      "src/handlers/SessionUpdateHandler.ts",
      "src/config/RegistryClient.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "vscode",
          message: "This module must stay unit-testable; keep VS Code API calls in an adapter that imports it.",
        }],
      }],
    },
  },
);
