// grapesjs-mjml ships no types; we only ever pass it as a plugin.
declare module "grapesjs-mjml" {
  const plugin: unknown;
  export default plugin;
}
// Dynamic CSS side-effect imports (grapesjs stylesheet).
declare module "*.css";
