import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import typescriptEslint from "typescript-eslint";

const vscodeApi = {
  name: "vscode",
  message: "Only adapters, extension.ts, and the integration suite may use the VS Code API.",
};

const webviewApi = {
  name: "@/webview/VsCodeApi",
  message: "Only Main.tsx posts to the extension; views dispatch events to the store, which posts its outgoing messages.",
};

const webviewLayers = {
  group: ["@/core/*", "@/adapters/*"],
  message: "The webview reaches the extension only by webview messages; share their types through @/shared.",
};

const react = {
  group: ["react", "react/*", "react-dom", "react-dom/*"],
  message: "Webview .ts modules stay free of React; views are .tsx modules in views/.",
};

const views = {
  group: ["@/webview/views/*"],
  message: "state/ is the data layer and depends on no view; views read the state through useSelector.",
};

const webviewState = {
  message: "The extension owns session state and replays it on `ready`; webview state lives in the store.",
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
    files: ["**/*.{ts,tsx}"],
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
    files: ["src/webview/**/*.{ts,tsx}"],
    rules: {
      ...restrictImports({ paths: [vscodeApi, webviewApi], patterns: [webviewLayers] }),
      "no-restricted-globals": ["error", {
        name: "acquireVsCodeApi",
        message: "VS Code allows one call per page; import from @/webview/VsCodeApi instead.",
      }],
      "no-restricted-properties": ["error",
        { property: "getState", ...webviewState },
        { property: "setState", ...webviewState },
        { property: "postMessage", message: webviewApi.message },
      ],
    },
  },
  {
    files: ["src/webview/**/*.ts"],
    rules: restrictImports({ paths: [vscodeApi, webviewApi], patterns: [webviewLayers, react] }),
  },
  {
    files: ["src/webview/state/**/*.ts"],
    rules: restrictImports({ paths: [vscodeApi, webviewApi], patterns: [webviewLayers, react, views] }),
  },
  {
    files: ["src/webview/Main.tsx"],
    rules: restrictImports({ paths: [vscodeApi], patterns: [webviewLayers] }),
  },
  {
    files: ["src/webview/VsCodeApi.ts"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": ["error",
        { property: "getState", ...webviewState },
        { property: "setState", ...webviewState },
      ],
    },
  },
  {
    files: ["src/webview/**/*.tsx", "tests/**/*.tsx"],
    extends: [reactHooks.configs.flat.recommended],
  },
);
