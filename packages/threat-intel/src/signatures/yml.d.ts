// Bun natively parses `.yml` imports into a plain object at build/run time. This
// ambient declaration lets tsgo resolve the import; the runtime value is
// validated/normalized by `parseSignature` in ../signatures.ts.
declare module "*.yml" {
  const data: unknown;
  export default data;
}
