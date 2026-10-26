// Pixel-art icons drawn behind the report header (DecorativeHeader).
// Copied from the squirrelscan design system; MIT, like the rest of this package.
// Classic JSX in the CLI build needs React in scope.
import React from "react";
import type { SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

function PixelBase({
  children,
  className,
  viewBox = "0 0 24 24",
  ...props
}: IconProps & { viewBox?: string }) {
  return (
    <svg
      viewBox={viewBox}
      className={className}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      style={{ shapeRendering: "crispEdges" }}
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconTerminal(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Monitor frame */}
      <rect x="2" y="4" width="20" height="14" fill="currentColor" />
      <rect x="4" y="6" width="16" height="10" fill="var(--background)" />
      {/* Prompt arrow > */}
      <rect x="6" y="8" width="2" height="2" fill="currentColor" />
      <rect x="8" y="10" width="2" height="2" fill="currentColor" />
      <rect x="6" y="12" width="2" height="2" fill="currentColor" />
      {/* Cursor line */}
      <rect x="12" y="12" width="6" height="2" fill="currentColor" />
      {/* Stand */}
      <rect x="8" y="18" width="8" height="2" fill="currentColor" />
    </PixelBase>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Magnifying glass circle */}
      <rect x="6" y="2" width="8" height="2" fill="currentColor" />
      <rect x="4" y="4" width="2" height="2" fill="currentColor" />
      <rect x="14" y="4" width="2" height="2" fill="currentColor" />
      <rect x="2" y="6" width="2" height="6" fill="currentColor" />
      <rect x="16" y="6" width="2" height="6" fill="currentColor" />
      <rect x="4" y="12" width="2" height="2" fill="currentColor" />
      <rect x="14" y="12" width="2" height="2" fill="currentColor" />
      <rect x="6" y="14" width="8" height="2" fill="currentColor" />
      {/* Handle */}
      <rect x="14" y="14" width="2" height="2" fill="currentColor" />
      <rect x="16" y="16" width="2" height="2" fill="currentColor" />
      <rect x="18" y="18" width="4" height="4" fill="currentColor" />
    </PixelBase>
  );
}

export function IconBot(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Antenna */}
      <rect x="11" y="2" width="2" height="2" fill="currentColor" />
      <rect x="10" y="4" width="4" height="2" fill="currentColor" />
      {/* Head */}
      <rect x="4" y="6" width="16" height="12" fill="currentColor" />
      {/* Eyes */}
      <rect x="6" y="8" width="4" height="4" fill="var(--background)" />
      <rect x="14" y="8" width="4" height="4" fill="var(--background)" />
      {/* Pupils */}
      <rect x="8" y="10" width="2" height="2" fill="currentColor" />
      <rect x="16" y="10" width="2" height="2" fill="currentColor" />
      {/* Mouth */}
      <rect x="8" y="14" width="8" height="2" fill="var(--background)" />
      {/* Ears */}
      <rect x="2" y="8" width="2" height="6" fill="currentColor" />
      <rect x="20" y="8" width="2" height="6" fill="currentColor" />
      {/* Body hint */}
      <rect x="8" y="18" width="8" height="4" fill="currentColor" />
    </PixelBase>
  );
}

export function IconServer(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Top server unit */}
      <rect x="2" y="2" width="20" height="8" fill="currentColor" />
      <rect x="4" y="4" width="16" height="4" fill="var(--background)" />
      <rect x="6" y="5" width="2" height="2" fill="currentColor" />
      <rect x="10" y="5" width="2" height="2" fill="currentColor" />
      <rect x="16" y="5" width="2" height="2" fill="currentColor" />
      {/* Bottom server unit */}
      <rect x="2" y="12" width="20" height="8" fill="currentColor" />
      <rect x="4" y="14" width="16" height="4" fill="var(--background)" />
      <rect x="6" y="15" width="2" height="2" fill="currentColor" />
      <rect x="10" y="15" width="2" height="2" fill="currentColor" />
      <rect x="16" y="15" width="2" height="2" fill="currentColor" />
      {/* Feet */}
      <rect x="4" y="20" width="4" height="2" fill="currentColor" />
      <rect x="16" y="20" width="4" height="2" fill="currentColor" />
    </PixelBase>
  );
}

export function IconFileJson(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Document body */}
      <rect x="4" y="2" width="12" height="20" fill="currentColor" />
      {/* Folded corner */}
      <rect x="16" y="2" width="4" height="2" fill="currentColor" />
      <rect x="18" y="4" width="2" height="2" fill="currentColor" />
      <rect x="16" y="6" width="4" height="16" fill="currentColor" />
      {/* Inner white */}
      <rect x="6" y="4" width="12" height="16" fill="var(--background)" />
      {/* JSON brackets { } */}
      <rect x="8" y="6" width="2" height="2" fill="currentColor" />
      <rect x="7" y="8" width="2" height="4" fill="currentColor" />
      <rect x="8" y="12" width="2" height="2" fill="currentColor" />
      <rect x="14" y="6" width="2" height="2" fill="currentColor" />
      <rect x="15" y="8" width="2" height="4" fill="currentColor" />
      <rect x="14" y="12" width="2" height="2" fill="currentColor" />
      {/* Colon and value lines */}
      <rect x="10" y="8" width="4" height="2" fill="currentColor" />
      <rect x="8" y="16" width="8" height="2" fill="currentColor" />
    </PixelBase>
  );
}

export function IconGauge(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Gauge circle */}
      <rect x="6" y="2" width="12" height="2" fill="currentColor" />
      <rect x="4" y="4" width="2" height="2" fill="currentColor" />
      <rect x="18" y="4" width="2" height="2" fill="currentColor" />
      <rect x="2" y="6" width="2" height="10" fill="currentColor" />
      <rect x="20" y="6" width="2" height="10" fill="currentColor" />
      <rect x="4" y="16" width="2" height="2" fill="currentColor" />
      <rect x="18" y="16" width="2" height="2" fill="currentColor" />
      <rect x="6" y="18" width="12" height="2" fill="currentColor" />
      {/* Needle pointing right (good/fast) */}
      <rect x="10" y="10" width="2" height="4" fill="currentColor" />
      <rect x="12" y="10" width="2" height="2" fill="currentColor" />
      <rect x="14" y="8" width="2" height="2" fill="currentColor" />
      <rect x="16" y="6" width="2" height="2" fill="currentColor" />
      {/* Center dot */}
      <rect x="10" y="12" width="4" height="4" fill="currentColor" />
    </PixelBase>
  );
}

export function IconShield(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Shield shape */}
      <rect x="4" y="2" width="16" height="2" fill="currentColor" />
      <rect x="2" y="4" width="20" height="8" fill="currentColor" />
      <rect x="4" y="12" width="16" height="4" fill="currentColor" />
      <rect x="6" y="16" width="12" height="2" fill="currentColor" />
      <rect x="8" y="18" width="8" height="2" fill="currentColor" />
      <rect x="10" y="20" width="4" height="2" fill="currentColor" />
      {/* Inner highlight */}
      <rect x="6" y="6" width="12" height="6" fill="var(--background)" />
      {/* Checkmark inside */}
      <rect x="8" y="10" width="2" height="2" fill="currentColor" />
      <rect x="10" y="12" width="2" height="2" fill="currentColor" />
      <rect x="12" y="10" width="2" height="2" fill="currentColor" />
      <rect x="14" y="8" width="2" height="2" fill="currentColor" />
    </PixelBase>
  );
}

export function IconLink(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* First chain link */}
      <rect x="2" y="8" width="2" height="8" fill="currentColor" />
      <rect x="4" y="6" width="2" height="2" fill="currentColor" />
      <rect x="4" y="16" width="2" height="2" fill="currentColor" />
      <rect x="6" y="6" width="6" height="2" fill="currentColor" />
      <rect x="6" y="16" width="6" height="2" fill="currentColor" />
      <rect x="10" y="8" width="2" height="8" fill="currentColor" />
      {/* Second chain link */}
      <rect x="12" y="8" width="2" height="8" fill="currentColor" />
      <rect x="14" y="6" width="6" height="2" fill="currentColor" />
      <rect x="14" y="16" width="6" height="2" fill="currentColor" />
      <rect x="18" y="6" width="2" height="2" fill="currentColor" />
      <rect x="18" y="16" width="2" height="2" fill="currentColor" />
      <rect x="20" y="8" width="2" height="8" fill="currentColor" />
    </PixelBase>
  );
}

export function IconNut(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Stem */}
      <rect x="11" y="2" width="2" height="2" fill="currentColor" />
      {/* Acorn Cap */}
      <rect x="6" y="4" width="12" height="2" fill="currentColor" />
      <rect x="4" y="6" width="16" height="4" fill="currentColor" />
      {/* Cap texture */}
      <rect x="6" y="6" width="2" height="2" fill="var(--background)" fillOpacity={0.35} />
      <rect x="10" y="6" width="2" height="2" fill="var(--background)" fillOpacity={0.35} />
      <rect x="14" y="6" width="2" height="2" fill="var(--background)" fillOpacity={0.35} />
      {/* Nut Body */}
      <rect x="6" y="10" width="12" height="8" fill="currentColor" fillOpacity={0.65} />
      <rect x="8" y="18" width="8" height="2" fill="currentColor" fillOpacity={0.65} />
      <rect x="10" y="20" width="4" height="2" fill="currentColor" fillOpacity={0.65} />
    </PixelBase>
  );
}

export function IconCrackedNut(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Left half cap */}
      <rect x="4" y="4" width="6" height="2" fill="currentColor" />
      <rect x="2" y="6" width="8" height="4" fill="currentColor" />
      {/* Right half cap */}
      <rect x="14" y="4" width="6" height="2" fill="currentColor" />
      <rect x="14" y="6" width="8" height="4" fill="currentColor" />
      {/* Left body */}
      <rect x="2" y="10" width="8" height="6" fill="currentColor" fillOpacity={0.65} />
      <rect x="4" y="16" width="4" height="2" fill="currentColor" fillOpacity={0.65} />
      {/* Right body */}
      <rect x="14" y="10" width="8" height="6" fill="currentColor" fillOpacity={0.65} />
      <rect x="16" y="16" width="4" height="2" fill="currentColor" fillOpacity={0.65} />
      {/* Debris */}
      <rect x="11" y="14" width="2" height="2" fill="currentColor" fillOpacity={0.65} />
      <rect x="10" y="18" width="2" height="2" fill="currentColor" fillOpacity={0.65} />
      <rect x="12" y="20" width="2" height="2" fill="currentColor" fillOpacity={0.65} />
    </PixelBase>
  );
}

export function IconTree(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Tree top */}
      <rect x="10" y="2" width="4" height="2" fill="currentColor" />
      <rect x="8" y="4" width="8" height="2" fill="currentColor" />
      <rect x="6" y="6" width="12" height="2" fill="currentColor" />
      <rect x="4" y="8" width="16" height="2" fill="currentColor" />
      <rect x="6" y="10" width="12" height="2" fill="currentColor" />
      <rect x="4" y="12" width="16" height="2" fill="currentColor" />
      <rect x="6" y="14" width="12" height="2" fill="currentColor" />
      {/* Trunk */}
      <rect x="10" y="16" width="4" height="6" fill="currentColor" fillOpacity={0.65} />
    </PixelBase>
  );
}

export function IconRocket(props: IconProps) {
  return (
    <PixelBase {...props}>
      {/* Nose cone */}
      <rect x="10" y="2" width="4" height="2" fill="currentColor" />
      <rect x="8" y="4" width="8" height="2" fill="currentColor" />
      {/* Body */}
      <rect x="8" y="6" width="8" height="10" fill="currentColor" />
      {/* Window */}
      <rect x="10" y="8" width="4" height="4" fill="var(--background)" />
      {/* Fins */}
      <rect x="4" y="14" width="4" height="2" fill="currentColor" />
      <rect x="6" y="16" width="2" height="2" fill="currentColor" />
      <rect x="16" y="14" width="4" height="2" fill="currentColor" />
      <rect x="16" y="16" width="2" height="2" fill="currentColor" />
      {/* Exhaust */}
      <rect x="10" y="16" width="4" height="2" fill="currentColor" />
      <rect x="9" y="18" width="6" height="2" fill="currentColor" />
      <rect x="10" y="20" width="4" height="2" fill="currentColor" />
    </PixelBase>
  );
}
