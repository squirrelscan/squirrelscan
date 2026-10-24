// The bundled classifier artifact (#2307).
//
// `with { type: "file" }` makes bun embed the file in the compiled executable and hand back a path
// to it (a real path under `bun run`, a virtual `/$bunfs/...` path in the binary). The bytes are
// read only when something asks for the model, so a command that never classifies (`--version`,
// `self doctor`'s other checks) pays nothing for the 8 MB.
//
// Swapping the artifact: `bun run scripts/install-artifact.ts <file>` in packages/page-classifier
// rewrites the two files below; nothing here changes.

import artifactFile from "@squirrelscan/page-classifier/assets/classifier-v2.json" with { type: "file" };
import manifest from "@squirrelscan/page-classifier/assets/classifier-v2.manifest.json";

export interface ArtifactManifest {
  file: string;
  sha256: string;
  bytes: number;
  format: string;
  artifactVersion: number;
  featurizerVersion: string;
  heads: string[];
}

/** Path to the embedded artifact JSON. */
export const BUNDLED_ARTIFACT_PATH: string = artifactFile as unknown as string;

/** What the bundled artifact is: its hash, size and the featurizer it was built for. */
export const BUNDLED_ARTIFACT_MANIFEST: ArtifactManifest =
  manifest as ArtifactManifest;
