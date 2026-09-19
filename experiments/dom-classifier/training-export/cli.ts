import { exportReviewedLabels } from "./export.ts";

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
if (args.includes("--help") || !value("--input") || !value("--output")) {
  console.error(
    "Usage: bun training-export/cli.ts --input /private/labeler-store --output /private/new-snapshot [--grouping-input /private/groups.json]",
  );
  process.exit(args.includes("--help") ? 0 : 2);
}
const manifest = await exportReviewedLabels({
  inputDir: value("--input")!,
  outputDir: value("--output")!,
  groupingInput: value("--grouping-input"),
});
console.log(
  JSON.stringify({
    captures: manifest.counts.captures,
    nodeExamples: manifest.counts.nodeExamples,
    pageExamples: manifest.counts.pageExamples,
    exclusions: manifest.counts.exclusions,
  }),
);
