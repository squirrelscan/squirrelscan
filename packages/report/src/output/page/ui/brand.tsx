// Classic JSX in the CLI build needs React in scope.
import React from "react";
import type { SVGProps } from "react";

import { cn } from "./utils";

function SquirrelPixels() {
  return (
    <>
      <rect x="2" y="4" width="4" height="4" fill="#8B4513" />
      <rect x="2" y="8" width="4" height="4" fill="#8B4513" />
      <rect x="4" y="12" width="4" height="4" fill="#8B4513" />
      <rect x="6" y="16" width="4" height="4" fill="#A0522D" />
      <rect x="2" y="0" width="4" height="4" fill="#A0522D" />
      <rect x="10" y="12" width="4" height="4" fill="#A0522D" />
      <rect x="14" y="12" width="4" height="4" fill="#A0522D" />
      <rect x="10" y="16" width="4" height="4" fill="#CD853F" />
      <rect x="14" y="16" width="4" height="4" fill="#CD853F" />
      <rect x="18" y="16" width="4" height="4" fill="#A0522D" />
      <rect x="10" y="20" width="4" height="4" fill="#CD853F" />
      <rect x="14" y="20" width="4" height="4" fill="#DEB887" />
      <rect x="18" y="20" width="4" height="4" fill="#CD853F" />
      <rect x="18" y="8" width="4" height="4" fill="#A0522D" />
      <rect x="22" y="8" width="4" height="4" fill="#A0522D" />
      <rect x="18" y="12" width="4" height="4" fill="#CD853F" />
      <rect x="22" y="12" width="4" height="4" fill="#CD853F" />
      <rect x="26" y="12" width="4" height="4" fill="#A0522D" />
      <rect x="24" y="10" width="2" height="2" fill="#000000" />
      <rect x="20" y="4" width="4" height="4" fill="#A0522D" />
      <rect x="24" y="6" width="2" height="2" fill="#DEB887" />
      <rect x="10" y="24" width="4" height="4" fill="#8B4513" />
      <rect x="18" y="24" width="4" height="4" fill="#8B4513" />
      <rect x="26" y="18" width="4" height="4" fill="#8B4513" />
      <rect x="28" y="16" width="2" height="2" fill="#228B22" />
    </>
  );
}

type BrandSvgProps = Omit<SVGProps<SVGSVGElement>, "className" | "height"> & {
  /** Height utility (width follows the aspect ratio). */
  height?: string;
};

/** The squirrelscan wordmark: pixel squirrel plus the lowercase name. */
export function SquirrelLogo({ height = "h-8", ...props }: BrandSvgProps) {
  return (
    // oxlint-disable-next-line github/a11y-aria-label-is-well-formatted -- brand name is always lowercase
    <svg
      viewBox="0 0 216 32"
      className={cn("w-auto", height)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ shapeRendering: "crispEdges" }}
      aria-label="squirrelscan"
      {...props}
    >
      <SquirrelPixels />
      <text
        x="42"
        y="21"
        fill="currentColor"
        fontFamily="JetBrains Mono, SFMono-Regular, Menlo, monospace"
        fontSize="15"
        fontWeight="700"
        letterSpacing="-0.04em"
      >
        squirrelscan
      </text>
    </svg>
  );
}
