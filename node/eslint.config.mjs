import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [tseslint.configs.base],
    rules: {
      "no-debugger": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
    },
  },
);
