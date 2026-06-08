// Bun bundles `*.md` files imported with `{ type: "text" }` into the binary as
// their raw string contents (survives `bun build --compile`). This declaration
// lets TypeScript type those imports.
declare module "*.md" {
  const content: string;
  export default content;
}
