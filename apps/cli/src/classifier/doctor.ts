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

  if (!info.hashMatches && info.loadedSha256 !== "") {
    return {
      name,
      status: "fail",
      message: `Loaded artifact sha256 ${info.loadedSha256.slice(0, 12)} (${formatBytes(info.loadedBytes)}) does not match the manifest ${info.artifactSha256.slice(0, 12)} (${formatBytes(info.artifactBytes)}); the model is not used`,
      fix: "Reinstall squirrel with 'squirrel self update'",
    };
  }
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
      `artifact v${info.artifactVersion} (loaded sha256 ${info.loadedSha256.slice(0, 12)} matches the manifest, ${formatBytes(info.loadedBytes)}), ` +
      `featurizer ${info.featurizerVersion}, ${info.heads.join("+")} heads, loaded in ${Math.round(info.loadMs)} ms`,
  };
}
