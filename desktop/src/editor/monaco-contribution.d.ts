// The TypeScript contribution ships without declarations under its exports subpath; its
// getTypeScriptWorker export has the same type as the one on the public `languages` namespace.
declare module "monaco-editor/language/typescript/monaco.contribution.js" {
  import type { languages } from "monaco-editor";
  export const getTypeScriptWorker: typeof languages.typescript.getTypeScriptWorker;
}
