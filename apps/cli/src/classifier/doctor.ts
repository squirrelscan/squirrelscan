// `squirrel self doctor`: is the bundled page classifier usable, and what is it (#2307).

import type { DoctorCheck } from "@/self/types";

import { formatBytes } from "@/self/disk";

import { classifierInfo, type ClassifierInfo } from "./index";

// deps injectable for tests only — production callers omit.
export function checkClassifier(
  deps: { info?: () => ClassifierInfo } = {}
): DoctorCheck {
  const name = "Page classifier";
  const info = (deps.info ?? classifierInfo)();

  if (!info.loaded) {
    return {
      name,
      status: "warn",
      message: `Bundled model unavailable (${info.reason}); link sections use page markup only`,
      fix: "Reinstall squirrel with 'squirrel self update'",
    };
  }
  if (info.artifactFeaturizerVersion !== info.featurizerVersion) {
    return {
      name,
      status: "warn",
      message: `Artifact built for featurizer ${info.artifactFeaturizerVersion}, this build is ${info.featurizerVersion}; the model is not used`,
      fix: "Reinstall squirrel with 'squirrel self update'",
    };
  }
  return {
    name,
    status: "pass",
    message:
      `artifact v${info.artifactVersion} (sha256 ${info.artifactSha256.slice(0, 12)}, ${formatBytes(info.artifactBytes)}), ` +
      `featurizer ${info.featurizerVersion}, ${info.heads.join("+")} heads, loaded in ${Math.round(info.loadMs)} ms`,
  };
}
