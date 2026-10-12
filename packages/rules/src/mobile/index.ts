// Mobile rules - mobile-specific checks
// viewport, tap targets, font size, web app manifest

import type { Rule } from "../types";

import { fontSizeRule } from "./font-size";
import { horizontalScrollRule } from "./horizontal-scroll";
import { interstitialsRule } from "./interstitials";
import { tapTargetsRule } from "./tap-targets";
import { viewportRule } from "./viewport";
import { viewportZoomRule } from "./viewport-zoom";
import { webAppManifestRule } from "./web-app-manifest";

export const rules: Rule[] = [
  viewportRule,
  viewportZoomRule,
  tapTargetsRule,
  fontSizeRule,
  horizontalScrollRule,
  interstitialsRule,
  webAppManifestRule,
];

export {
  fontSizeRule,
  horizontalScrollRule,
  interstitialsRule,
  tapTargetsRule,
  viewportRule,
  viewportZoomRule,
  webAppManifestRule,
};
