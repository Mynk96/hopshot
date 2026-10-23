/** Vite serves `?raw` imports as strings; the migration is loaded that way in tests. */
declare module "*.sql?raw" {
  const contents: string;
  export default contents;
}
