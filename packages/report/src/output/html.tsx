import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IconType } from "react-icons";
import {
  PiAddressBook,
  PiBuildings,
  PiCalendarBlank,
  PiShareNetwork,
  PiTag,
  PiUsersThree,
} from "react-icons/pi";

import type { ReportBranding } from "@squirrelscan/core-contracts";
import type { AuditReport } from "../types";
import { getScoreGrade, getScoreColor, getGroupColor } from "../scoring";
import {
  REPORT_COLLAPSE_THRESHOLD,
  REPORT_ITEMS_COLLAPSE_THRESHOLD,
  REPORT_SOURCE_PAGES_PREVIEW,
  REPORT_PAGES_INLINE_CAP,
  REPORT_PAGES_HARD_CAP,
} from "../constants";
import { groupIssuesByCategory, groupCategoriesByGroup, type GroupedCategory } from "../grouping";
import { groupTechnologies, techChangeSummary } from "../technologies";
import {
  SITE_PROFILE_NOTE,
  siteProfileFlags,
  siteProfileRows,
  type SiteProfileRowKey,
} from "../site-metadata";
import {
  coverageLine,
  fullScanHint,
  scanScopeLine,
  checkCarriedLabel,
  ruleCarriedRollupLine,
} from "../coverage";
import { EDITOR_SUMMARY_NOTE } from "../editor-summary";
import { DOMAIN_STATS_NOTE, domainStatRows, allPositionBands } from "../domain-stats";
import { CACHE_STATS_NOTE, cacheHitRatePercent, cacheReasonsLabel } from "../cache-stats";
import { formatBytes, formatHumanDateTime, sanitizeUrl } from "../utils";
import { getDocsUrl } from "../docs";
import { getPathname } from "../url";
import { getGroupName, getGroupTitle, severityLabel } from "../categories";
import {
  affectedPages,
  ruleAffectedPageCount,
  ruleAffectedRollup,
  ruleCarriedPageCount,
  isPageUrl,
  isRedundantPageItem,
} from "../affected-pages";
import { getAuditFailureNotice } from "../failure-notice";
import { lockedRulesMessage } from "../locked-rules";

export interface HtmlRenderOptions {
  /** Report ID for OG meta tags (API use) */
  reportId?: string;
  /** White-label branding (#810) — Team orgs hide squirrelscan branding. */
  branding?: ReportBranding;
}

// Theme matching the website/dashboard design system (.claude/rules/design_system.md)
const THEME = {
  colors: {
    background: "oklch(0.97 0.008 85)",
    foreground: "oklch(0.25 0.01 85)",
    card: "oklch(0.99 0.004 85)",
    primary: "oklch(0.52 0.12 145)",
    accent: "oklch(0.62 0.14 45)",
    muted: "oklch(0.92 0.006 85)",
    mutedForeground: "oklch(0.5 0.01 85)",
    border: "oklch(0.85 0.01 85)",
    // Semantic status colors — aligned with SCORE_COLORS (core-contracts/scoring)
    // so severity badges and stripes match the score circles.
    pass: "#22c55e",
    warn: "#f59e0b",
    fail: "#ef4444",
  },
  fonts: {
    mono: '"JetBrains Mono", "Geist Mono", "SF Mono", "Roboto Mono", "Menlo", monospace',
  },
};

const styles = `
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: ${THEME.fonts.mono};
  line-height: 1.6;
  background: ${THEME.colors.background};
  color: ${THEME.colors.foreground};
  padding: 0; margin: 0;
}

.container { max-width: 1080px; margin: 0 auto; padding: 0 2rem; }
h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.5rem; color: ${THEME.colors.foreground}; }
h2 { font-size: 1.35rem; font-weight: 700; margin: 2.5rem 0 1rem; color: ${THEME.colors.foreground}; border-bottom: 2px solid ${THEME.colors.primary}; padding-bottom: 0.4rem; }

.meta { color: ${THEME.colors.mutedForeground}; font-size: 0.875rem; margin-bottom: 0.5rem; }
.scan-scope { color: ${THEME.colors.mutedForeground}; font-size: 0.8125rem; margin-top: 0.25rem; }
.scan-hint { color: ${THEME.colors.warn}; font-size: 0.8125rem; margin-top: 0.35rem; max-width: 42rem; }

/* Header band: pixel-grid backdrop + primary rule, matching DecorativeHeader */
.report-header {
  background-image:
    linear-gradient(to right, oklch(0.85 0.01 85 / 0.3) 1px, transparent 1px),
    linear-gradient(to bottom, oklch(0.85 0.01 85 / 0.3) 1px, transparent 1px);
  background-size: 8px 8px;
  border-bottom: 2px solid oklch(0.52 0.12 145 / 0.5);
  padding: 2rem 0 1.75rem;
  margin-bottom: 2rem;
}

/* Group score circles (#626) — the only score breakdown shown */
.group-scores { display: flex; flex-wrap: wrap; gap: 1rem; margin: 2rem 0; }
.group-circle { flex: 1 1 150px; min-width: 130px; background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; padding: 1.25rem 1rem 1rem; text-align: center; text-decoration: none; color: inherit; display: flex; flex-direction: column; align-items: center; gap: 0.6rem; transition: border-color 0.2s; }
a.group-circle:hover { border-color: oklch(0.52 0.12 145 / 0.5); }
.group-circle-name { font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.group-circle-counts { color: ${THEME.colors.mutedForeground}; font-size: 0.72rem; margin-top: -0.25rem; }
/* Locked group slot (#747) — quick runs skip cloud, so the Agents score can't exist */
.group-circle-locked .group-circle-name { color: ${THEME.colors.mutedForeground}; }
.group-ring-locked { width: 84px; height: 84px; border-radius: 50%; border: 6px solid ${THEME.colors.muted}; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; }

.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin: 2rem 0; }
.stat-card { background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; padding: 1.25rem; text-align: center; }
.stat-value { font-size: 2.25rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.stat-label { color: ${THEME.colors.mutedForeground}; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0.5rem; }

.pass { color: ${THEME.colors.pass}; }
.warn { color: ${THEME.colors.warn}; }
.fail { color: ${THEME.colors.fail}; }

/* Issues: flat rule list; each rule carries its parent group as a label.
   Label colors come inline from GROUP_COLORS (core-contracts/scoring). */
.group-section { margin-bottom: 0; }
.group-label { flex-shrink: 0; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; border: 1px solid; padding: 0.12rem 0.45rem; }

.rule-block { margin-bottom: 1.25rem; padding-left: 1rem; border-left: 3px solid ${THEME.colors.muted}; list-style: none; }
.rule-block + .rule-block { margin-top: 0; }
.rule-block > summary { list-style: none; }
.rule-block > summary::-webkit-details-marker { display: none; }

.rule-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; cursor: pointer; padding: 0.5rem 0; }
.rule-summary:hover { opacity: 0.8; }
.rule-summary::before { content: "▶"; font-size: 0.6rem; transition: transform 0.15s; flex-shrink: 0; }
.rule-block[open] > .rule-summary::before { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .rule-summary::before { transition: none; } }

.rule-affected { margin-left: auto; font-size: 0.8rem; color: ${THEME.colors.mutedForeground}; white-space: nowrap; }
.rule-detail { padding: 0.75rem 0 0.5rem; }
.rule-detail-header { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.5rem; }

.rule-name { font-weight: 600; font-size: 1.1rem; color: ${THEME.colors.primary}; }
.rule-id { font-family: ${THEME.fonts.mono}; font-size: 0.75rem; color: ${THEME.colors.mutedForeground}; }

.rule-severity { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; padding: 0.1rem 0.4rem; border: 1px solid ${THEME.colors.border}; }
.rule-severity.error { color: ${THEME.colors.fail}; border-color: ${THEME.colors.fail}; }
.rule-severity.warning { color: ${THEME.colors.warn}; border-color: ${THEME.colors.warn}; }
.rule-severity.info { color: ${THEME.colors.primary}; border-color: ${THEME.colors.primary}; }

.issue-list { background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; padding: 1rem; margin-bottom: 1rem; }
.issue-item { padding: 0.5rem 0; border-bottom: 1px solid ${THEME.colors.border}; display: flex; gap: 0.75rem; align-items: flex-start; }
.issue-item:last-child { border-bottom: none; padding-bottom: 0; }
.issue-icon { flex-shrink: 0; width: 20px; font-weight: bold; }
.issue-content { flex: 1; }
.issue-message { margin-bottom: 0.25rem; }

.issue-pages { color: ${THEME.colors.mutedForeground}; font-size: 0.875rem; margin-top: 0.25rem; }
.issue-pages a { color: ${THEME.colors.primary}; text-decoration: none; margin-right: 0.5rem; overflow-wrap: break-word; word-break: break-all; }
.issue-pages a:hover { text-decoration: underline; }

.rule-description { font-size: 0.875rem; color: ${THEME.colors.mutedForeground}; margin-bottom: 0.5rem; font-style: italic; }
.rule-solution { background: ${THEME.colors.muted}; border-left: 3px solid ${THEME.colors.primary}; padding: 0.75rem 1rem; margin: 0.5rem 0 1rem; font-size: 0.85rem; }
.rule-solution-title { font-weight: 600; margin-bottom: 0.25rem; font-size: 0.75rem; text-transform: uppercase; color: ${THEME.colors.primary}; }

.rule-docs-link { font-size: 0.7rem; color: ${THEME.colors.primary}; text-decoration: none; margin-left: auto; white-space: nowrap; border: 1px solid ${THEME.colors.border}; padding: 0.1rem 0.4rem; transition: border-color 0.2s; }
.rule-docs-link:hover { border-color: ${THEME.colors.primary}; text-decoration: none; }

.footer { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid ${THEME.colors.border}; text-align: center; }
.footer-stats { display: flex; justify-content: center; gap: 2rem; font-size: 1.125rem; margin-bottom: 1rem; }
.footer-branding { color: ${THEME.colors.mutedForeground}; font-size: 0.875rem; }
.footer-branding a { color: ${THEME.colors.primary}; text-decoration: none; }
.footer-branding a:hover { text-decoration: underline; }

.no-issues { background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; padding: 2rem; text-align: center; color: ${THEME.colors.pass}; font-size: 1.125rem; }

.failure-notice { background: ${THEME.colors.card}; border: 2px solid ${THEME.colors.accent}; padding: 1.5rem 1.75rem; margin: 0 0 2rem; }
.failure-notice h2 { font-size: 1.4rem; border: none; margin: 0 0 0.6rem; padding: 0; color: ${THEME.colors.foreground}; }
.failure-notice p { color: ${THEME.colors.foreground}; margin: 0 0 0.75rem; line-height: 1.6; }
.failure-notice ul { margin: 0.25rem 0 0.75rem 1.35rem; color: ${THEME.colors.foreground}; }
.failure-notice li { margin-bottom: 0.4rem; line-height: 1.5; }
.failure-notice code { background: ${THEME.colors.muted}; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.9em; }
.failure-notice .notice-meta { color: ${THEME.colors.mutedForeground}; font-size: 0.85rem; margin-bottom: 0; }

.header-top { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
.logo-link { text-decoration: none; }
.logo-link svg { height: 32px; width: auto; }
/* White-label org branding (#810): org logo image or name wordmark. */
.wl-logo { height: 32px; width: auto; max-width: 240px; object-fit: contain; }
.wl-wordmark { font-size: 1.1rem; font-weight: 600; color: ${THEME.colors.foreground}; }
.audited-url { font-size: 1.5rem; font-weight: 600; margin: 0.5rem 0; }
.audited-url a { color: ${THEME.colors.primary}; text-decoration: none; word-break: break-all; }
.audited-url a:hover { text-decoration: underline; }

.pages-list { padding-left: 1rem; }
.pages-list a { display: block; padding: 0.15rem 0; color: ${THEME.colors.primary}; text-decoration: none; overflow-wrap: break-word; word-break: break-all; }
.pages-list a:hover { text-decoration: underline; }
.pages-more, .pages-copy { margin-left: 1rem; }
.pages-copy textarea { display: block; width: 100%; max-width: 100%; margin-top: 0.4rem; padding: 0.5rem; font-family: ${THEME.fonts.mono}; font-size: 0.75rem; color: ${THEME.colors.foreground}; background: ${THEME.colors.muted}; border: 1px solid ${THEME.colors.border}; resize: vertical; }
/* #1136: hard-cap truncation disclosure — never a silent drop. */
.pages-truncated-note { font-size: 0.8rem; color: ${THEME.colors.mutedForeground}; font-style: italic; margin-bottom: 0.35rem; }

/* #1135: carried-forward (not re-crawled this run) provenance surfacing —
   reuses the existing primary/muted palette, no new accent color. */
.carried-badge, .carried-tag { display: inline-block; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; color: ${THEME.colors.primary}; background: ${THEME.colors.muted}; border: 1px solid ${THEME.colors.primary}; border-radius: 3px; padding: 0.05rem 0.35rem; margin-left: 0.5rem; }
.carried-tag { font-size: 0.6rem; margin-left: 0.4rem; vertical-align: middle; }
.carried-note { font-size: 0.8rem; color: ${THEME.colors.mutedForeground}; margin: 0.15rem 0 0.5rem; }
.carried-note-mixed { color: ${THEME.colors.primary}; }

details { margin: 0.5rem 0; }
details > summary { cursor: pointer; color: ${THEME.colors.primary}; font-size: 0.875rem; }
details > summary:hover { text-decoration: underline; }
details[open] > summary { margin-bottom: 0.5rem; }

.editor-summary-section { margin: 2rem 0; background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; padding: 1.25rem 1.5rem; }
.editor-summary-section h2 { font-size: 1.35rem; margin: 0 0 0.5rem; border: none; padding: 0; }
.editor-summary-note { font-size: 0.85rem; color: ${THEME.colors.mutedForeground}; margin-bottom: 1rem; font-style: italic; }
.editor-summary-prose { margin: 0 0 0.85rem; line-height: 1.6; }
.editor-summary-bigticket { margin: 0.5rem 0 1rem 1.25rem; padding: 0; }
.editor-summary-bigticket li { margin-bottom: 0.35rem; line-height: 1.5; }
.editor-summary-verdict { border-top: 1px solid ${THEME.colors.border}; padding-top: 0.85rem; font-size: 0.95rem; }

.domain-stats-section { margin: 2rem 0; }
.domain-stats-section h2 { margin-top: 0; }
.domain-stats-note { font-size: 0.85rem; color: ${THEME.colors.mutedForeground}; margin-bottom: 1rem; font-style: italic; }
.domain-stats-grid { display: flex; flex-wrap: wrap; gap: 0.75rem; }
.domain-stat { display: flex; flex-direction: column; min-width: 7rem; background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; padding: 0.6rem 0.85rem; }
.domain-stat-value { font-size: 1.35rem; font-weight: 700; line-height: 1.2; }
.domain-stat-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: ${THEME.colors.mutedForeground}; margin-top: 0.2rem; }
.domain-stats-positions { margin-top: 1rem; font-size: 0.85rem; color: ${THEME.colors.mutedForeground}; }
.domain-stats-positions-label { font-weight: 600; margin-bottom: 0.5rem; }
.position-chart { display: flex; flex-direction: column; gap: 0.35rem; max-width: 520px; }
.position-bar { display: flex; align-items: center; gap: 0.75rem; }
.position-band { width: 72px; flex-shrink: 0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: ${THEME.colors.mutedForeground}; }
.position-track { flex: 1; height: 16px; background: ${THEME.colors.muted}; overflow: hidden; }
.position-fill { height: 100%; background: ${THEME.colors.primary}; }
.position-count { min-width: 60px; flex-shrink: 0; white-space: nowrap; font-weight: 600; color: ${THEME.colors.foreground}; }

.tech-section { margin: 2rem 0; }
.tech-section h2 { margin-top: 0; }
.tech-note { font-size: 0.85rem; color: ${THEME.colors.mutedForeground}; margin-bottom: 1.25rem; font-style: italic; }
.tech-group { margin-bottom: 1.25rem; }
.tech-group-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: ${THEME.colors.mutedForeground}; margin-bottom: 0.5rem; font-weight: 600; }
.tech-badges { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.tech-badge { display: inline-flex; align-items: center; gap: 0.4rem; background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; padding: 0.35rem 0.6rem; font-size: 0.85rem; }
.tech-badge .tech-ver { color: ${THEME.colors.mutedForeground}; font-size: 0.72rem; }

.profile-section { margin: 2rem 0; }
.profile-section h2 { margin-top: 0; }
.profile-note { font-size: 0.85rem; color: ${THEME.colors.mutedForeground}; margin-bottom: 1.25rem; font-style: italic; }
.profile-grid { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; align-items: baseline; background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; padding: 1rem 1.25rem; }
.profile-label { font-size: 0.8rem; color: ${THEME.colors.mutedForeground}; white-space: nowrap; }
.profile-icon { display: inline-block; width: 13px; height: 13px; vertical-align: -2px; margin-right: 5px; opacity: 0.75; }
.profile-value { font-size: 0.9rem; word-break: break-word; }
.profile-value a { color: ${THEME.colors.primary}; text-decoration: none; }
.profile-value a:hover { text-decoration: underline; }
.profile-flags { margin-top: 0.9rem; display: flex; flex-wrap: wrap; gap: 0.4rem; }
.profile-flag { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: ${THEME.colors.accent}; border: 1px solid ${THEME.colors.border}; padding: 0.1rem 0.45rem; }
.cache-meta { margin: 1.5rem 0; font-size: 0.8rem; color: ${THEME.colors.mutedForeground}; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 0.75rem; }
.cache-meta .cache-meta-label { font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.cache-meta .cache-meta-note { font-style: italic; }

.screenshot-section { margin: 2rem 0; }
.screenshot-frame { background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; padding: 0.75rem; line-height: 0; }
.screenshot-frame img { display: block; width: 100%; max-width: 100%; max-height: 480px; object-fit: contain; object-position: top; }

.summary-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; flex-wrap: wrap; margin-top: 1rem; }
.site-identity { display: flex; align-items: flex-start; gap: 1rem; flex: 1 1 340px; min-width: 0; }
.site-favicon { width: 44px; height: 44px; border: 1px solid ${THEME.colors.border}; background-color: ${THEME.colors.card}; color: ${THEME.colors.mutedForeground}; display: grid; place-items: center; font-size: 1.1rem; font-weight: 650; flex-shrink: 0; }
.site-identity-text { min-width: 0; }
.site-title { font-size: 1.75rem; font-weight: 700; line-height: 1.2; margin: 0 0 0.35rem; word-break: break-word; }
.site-description { color: ${THEME.colors.mutedForeground}; font-size: 0.95rem; line-height: 1.5; margin: 0 0 0.5rem; }
.site-identity-text .audited-url { font-size: 0.95rem; font-weight: 500; margin: 0.15rem 0; }
.score-ring { flex-shrink: 0; display: block; background: ${THEME.colors.card}; border-radius: 50%; }
.score-failed { flex-shrink: 0; max-width: 220px; text-align: center; padding: 1rem 1.25rem; border: 2px solid ${THEME.colors.fail}; background: ${THEME.colors.card}; }
.score-failed-label { font-size: 1.5rem; font-weight: bold; color: ${THEME.colors.fail}; }
.footer-version { color: ${THEME.colors.mutedForeground}; }

.locked-section { margin: 3rem 0 1rem; padding: 1.5rem; border: 1px dashed ${THEME.colors.border}; background: ${THEME.colors.muted}; }
.locked-section h2 { font-size: 1.4rem; border: none; margin: 0 0 0.4rem; padding: 0; }
.locked-note { color: ${THEME.colors.mutedForeground}; font-size: 0.9rem; margin-bottom: 1rem; line-height: 1.5; }
.locked-note a { color: ${THEME.colors.primary}; text-decoration: none; }
.locked-note a:hover { text-decoration: underline; }
.locked-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.5rem; }
.locked-rule { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; background: ${THEME.colors.card}; border: 1px solid ${THEME.colors.border}; color: ${THEME.colors.mutedForeground}; font-size: 0.85rem; }
.locked-rule-icon { opacity: 0.6; flex-shrink: 0; }
.locked-rule-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

function Logo() {
  return (
    <svg
      width="200"
      height="32"
      viewBox="0 0 200 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(0, 0)">
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
      </g>
      <text
        x="40"
        y="22"
        fontFamily="JetBrains Mono, monospace"
        fontSize="16"
        fontWeight="600"
        fill="#3F3935"
      >
        squirrelscan
      </text>
    </svg>
  );
}

function SiteFavicon({ report }: { report: AuditReport }) {
  let host: string | null = null;
  try {
    host = new URL(report.baseUrl).hostname;
  } catch {}
  if (!host) return null;
  return (
    <div className="site-favicon" aria-hidden>
      {host.charAt(0).toUpperCase()}
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const grade = getScoreGrade(score);
  const color = getScoreColor(score);
  return (
    <svg
      className="score-ring"
      viewBox="0 0 120 120"
      width="132"
      height="132"
      role="img"
      aria-label={`Health score: ${score} out of 100`}
    >
      <circle cx="60" cy="60" r="52" fill="none" stroke={THEME.colors.muted} strokeWidth="8" />
      <circle
        cx="60"
        cy="60"
        r="52"
        fill="none"
        stroke={color}
        strokeWidth="8"
        strokeDasharray={`${(score / 100) * 2 * Math.PI * 52} ${2 * Math.PI * 52}`}
        strokeLinecap="round"
        transform="rotate(-90 60 60)"
      />
      <text
        x="60"
        y="54"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="34"
        fontWeight="bold"
        fontFamily={THEME.fonts.mono}
        fill={color}
      >
        {score}
      </text>
      <text
        x="60"
        y="82"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="13"
        fontFamily={THEME.fonts.mono}
        fill={THEME.colors.mutedForeground}
      >
        {grade}
      </text>
    </svg>
  );
}

// Failed/blocked audit (#489): no real audit happened — show the state in the
// ring's slot, never a grade (a 403/down/0-page site must not read as "A/100%").
// Label only: the statusReason renders once, in FailureNotice below (#802).
function ScoreFailed({ status }: { status: "failed" | "blocked" }) {
  const label = status === "blocked" ? "Blocked" : "Failed";
  return (
    <div className="score-failed" role="img" aria-label={`Audit ${label.toLowerCase()}`}>
      <div className="score-failed-label">{label}</div>
    </div>
  );
}

// Actionable explanation for a failed/blocked audit (#792). Replaces the
// misleading "✓ No issues found" and the "cloud service was unavailable" copy:
// a blocked run is the SITE refusing our crawler, not our infra breaking, so we
// say so plainly and tell the owner how to let the audit through.
// #935 requires byte-identical visible copy to before the extraction, so this
// keeps the report's original per-surface composition (CLI hint as a 3rd list
// item when blocked; folded into the 2nd paragraph when failed) instead of
// switching to the dashboard's separate-paragraph layout. The failed-case
// paragraph is still DERIVED from `notice.body[1]` (not a hardcoded copy) —
// only the trailing clause is local — so it can't drift from the shared
// builder the way a fully hardcoded duplicate would.
function FailureNotice({ report }: { report: AuditReport }) {
  const notice = getAuditFailureNotice(report.status, report.baseUrl);
  if (!notice) return null;
  return (
    <div className="failure-notice">
      <h2>{notice.heading}</h2>
      <p>{notice.body[0]}</p>
      {notice.tone === "blocked" ? (
        <>
          <p>{notice.stepsIntro}</p>
          <ul>
            {notice.steps.map((step, i) => (
              <li key={`${i}-${step}`}>{step}</li>
            ))}
            <li>
              Run the audit from a trusted network with <code>{notice.cliCommand}</code>.
            </li>
          </ul>
        </>
      ) : (
        <p>
          {(notice.body[1] ?? "").replace(/\.\s*$/, "")}, or run it locally with{" "}
          <code>{notice.cliCommand}</code>.
        </p>
      )}
      {report.statusReason && <p className="notice-meta">Reason: {report.statusReason}</p>}
    </div>
  );
}

// Small score ring for a group circle — same treatment as the overall
// ScoreRing at 84px, number only (grade lives on the overall ring).
function GroupRing({ score }: { score: number }) {
  const color = getScoreColor(score);
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <svg
      viewBox="0 0 80 80"
      width="84"
      height="84"
      role="img"
      aria-label={`Score: ${score} out of 100`}
    >
      <circle cx="40" cy="40" r={r} fill="none" stroke={THEME.colors.muted} strokeWidth="6" />
      <circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeDasharray={`${(score / 100) * c} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 40 40)"
      />
      <text
        x="40"
        y="42"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="24"
        fontWeight="bold"
        fontFamily={THEME.fonts.mono}
        fill={color}
      >
        {score}
      </text>
    </svg>
  );
}

// The 4 top-level group scores (#626) as circles — the only score breakdown
// shown (the per-category bars were dropped in the redesign). Display names
// derive from the group CODE, not the stored `name`, so renames apply to
// already-stored reports. Absent for failed/blocked or pre-#626 reports.
// Circles link to their issues section when the group has issues.
function GroupScores({ report, issueGroups }: { report: AuditReport; issueGroups: Set<string> }) {
  const groups = report.healthScore?.groups ?? [];
  if (groups.length === 0) return null;
  // #747: a signed-in quick run skips all cloud enrichment, so the scored ai
  // rules never run, the group aggregates zero weight, and scoring omits it —
  // which paying users read as broken plan gating. Render a locked Agents
  // placeholder with the coverage hint instead of silently dropping the slot.
  const signedIn = report.cloudPlan === "free" || report.cloudPlan === "paid";
  const lockedAi =
    signedIn && report.coverageMode === "quick" && !groups.some((g) => g.group === "ai");
  return (
    <div className="group-scores">
      {groups.map((g) => {
        const counts =
          g.failed > 0 || g.warnings > 0 ? (
            <>
              {g.failed > 0 && (
                <span className="fail">
                  {g.failed} error{g.failed === 1 ? "" : "s"}
                </span>
              )}
              {g.failed > 0 && g.warnings > 0 && " · "}
              {g.warnings > 0 && (
                <span className="warn">
                  {g.warnings} warning{g.warnings === 1 ? "" : "s"}
                </span>
              )}
            </>
          ) : (
            "no issues"
          );
        const body = (
          <>
            <GroupRing score={g.score} />
            <div className="group-circle-name" style={{ color: getGroupColor(g.group).text }}>
              {getGroupName(g.group)}
            </div>
            <div className="group-circle-counts">{counts}</div>
          </>
        );
        return issueGroups.has(g.group) ? (
          <a
            key={g.group}
            className="group-circle"
            href={`#group-${g.group}`}
            title={getGroupTitle(g.group)}
          >
            {body}
          </a>
        ) : (
          <div key={g.group} className="group-circle" title={getGroupTitle(g.group)}>
            {body}
          </div>
        );
      })}
      {lockedAi && (
        <div className="group-circle group-circle-locked" title={getGroupTitle("ai")}>
          <div className="group-ring-locked" aria-hidden>
            🔒
          </div>
          <div className="group-circle-name">{getGroupName("ai")}</div>
          <div className="group-circle-counts">
            not scored in quick coverage · re-run with -C surface or -C full
          </div>
        </div>
      )}
    </div>
  );
}

// Header logo slot: squirrelscan wordmark by default, or the org's own logo /
// name when white-labelled (#810). White-label drops the squirrelscan.com link
// entirely so the report carries no squirrelscan branding.
function HeaderBrand({ branding }: { branding?: ReportBranding }) {
  if (branding?.whiteLabel) {
    if (branding.orgLogoUrl) {
      return <img className="wl-logo" src={branding.orgLogoUrl} alt={branding.orgName ?? "Logo"} />;
    }
    if (branding.orgName) return <span className="wl-wordmark">{branding.orgName}</span>;
    return null;
  }
  return (
    <a
      href="https://squirrelscan.com"
      className="logo-link"
      target="_blank"
      rel="noopener noreferrer"
    >
      <Logo />
    </a>
  );
}

// Full-width header band (pixel-grid backdrop, matching the site's
// DecorativeHeader): logo, site identity, and the overall score ring.
function ReportHeader({ report, branding }: { report: AuditReport; branding?: ReportBranding }) {
  let host = report.baseUrl;
  try {
    host = new URL(report.baseUrl).hostname.replace(/^www\./, "");
  } catch {}
  const title = report.homepage?.title?.trim() || host;
  const description = report.homepage?.description?.trim();
  const score = report.healthScore?.overall;

  return (
    <div className="report-header">
      <div className="container">
        <div className="header-top">
          <HeaderBrand branding={branding} />
        </div>
        <div className="summary-header">
          <div className="site-identity">
            <SiteFavicon report={report} />
            <div className="site-identity-text">
              <h1 className="site-title">{title}</h1>
              {description && <p className="site-description">{description}</p>}
              <div className="audited-url">
                <a href={sanitizeUrl(report.baseUrl)} target="_blank" rel="noopener noreferrer">
                  {report.baseUrl}
                </a>
              </div>
              <div className="meta">
                {report.totalPages} page{report.totalPages === 1 ? "" : "s"} • Generated{" "}
                {formatHumanDateTime(report.timestamp)}
              </div>
              {/* Scan scope disclosure (#1180): the score always reads with its basis. */}
              {(() => {
                const scope = scanScopeLine(report);
                const cov = coverageLine(report);
                const hint = fullScanHint(report);
                return (
                  <>
                    {(scope || cov) && (
                      <div className="scan-scope">{[scope, cov].filter(Boolean).join(" ")}</div>
                    )}
                    {hint && <div className="scan-hint">{hint}</div>}
                  </>
                );
              })()}
            </div>
          </div>
          {/* `partial`/`completed`/absent fall through to the normal ring (#489). */}
          {report.status === "failed" || report.status === "blocked" ? (
            <ScoreFailed status={report.status} />
          ) : (
            score != null && <ScoreRing score={score} />
          )}
        </div>
      </div>
    </div>
  );
}

function ScreenshotSection({ report }: { report: AuditReport }) {
  const screenshot = screenshotImgSrc(report);
  if (!screenshot) return null;
  return (
    <div className="screenshot-section">
      <div className="screenshot-frame">
        <img src={screenshot} alt={`Screenshot of ${report.baseUrl}`} loading="lazy" />
      </div>
    </div>
  );
}

function SummaryStats({ report }: { report: AuditReport }) {
  return (
    <div className="summary-grid">
      <div className="stat-card">
        <div className="stat-value">{report.totalPages.toLocaleString()}</div>
        <div className="stat-label">Pages</div>
      </div>
      <div className="stat-card">
        <div className="stat-value pass">{report.passed.toLocaleString()}</div>
        <div className="stat-label">Passed</div>
      </div>
      <div className="stat-card">
        <div className="stat-value warn">{report.warnings.toLocaleString()}</div>
        <div className="stat-label">Warnings</div>
      </div>
      <div className="stat-card">
        <div className="stat-value fail">{report.failed.toLocaleString()}</div>
        <div className="stat-label">Failed</div>
      </div>
    </div>
  );
}

/**
 * Affected-pages disclosure for a single check (#1136). Shows up to
 * REPORT_PAGES_INLINE_CAP links inline; the rest sit behind a nested "show
 * all" details — but NEVER materializes more than REPORT_PAGES_HARD_CAP URLs
 * into the HTML at all (inline + nested + the copy textarea combined), with
 * the truncation explicitly disclosed. A slice-only "cap" (inline cap but an
 * unbounded nested list + an unbounded textarea duplicating the whole thing
 * again) would still let a check with thousands of affected pages blow up a
 * PUBLIC report's HTML size and parse/layout cost — the exact perf trap
 * #1136 exists to avoid, not reintroduce. Carried (not re-crawled this run)
 * pages get a small inline tag (#1135) once per-URL provenance is known. The
 * plain-text `<textarea readOnly>` is copy-paste only — no JS: this report
 * has no script beyond the CSP-hash-pinned screenshot-hide snippet, so a
 * "Copy" button with a click handler would be silently inert in the static
 * HTML.
 */
function PagesList({
  pages,
  carriedPages,
  count,
}: {
  pages: string[];
  carriedPages?: string[];
  /**
   * #1023 R-F: authoritative affected-page total. `pages` is a labeled sample
   * (already sampled for publish + hard-capped here); `count` (≥ pages.length)
   * is the true total, so the summary/"of N" note never understates a
   * folded/sampled check to just its retained example set.
   */
  count?: number;
}) {
  if (pages.length === 0) return null;
  const total = Math.max(count ?? 0, pages.length);
  const carriedSet = carriedPages && carriedPages.length > 0 ? new Set(carriedPages) : undefined;
  const materialized =
    pages.length > REPORT_PAGES_HARD_CAP ? pages.slice(0, REPORT_PAGES_HARD_CAP) : pages;
  // Any pages beyond what we actually materialized — whether clipped by the
  // hard cap or never sampled into `pages` in the first place.
  const hasMore = total > materialized.length;
  const inline = materialized.slice(0, REPORT_PAGES_INLINE_CAP);
  const overflow = materialized.slice(REPORT_PAGES_INLINE_CAP);
  const renderLink = (page: string, i: number) => (
    <a key={i} href={sanitizeUrl(page)} target="_blank" rel="noopener noreferrer">
      {getPathname(page) || "/"}
      {carriedSet?.has(page) && (
        <span className="carried-tag" title="Not re-checked this run">
          carried
        </span>
      )}
    </a>
  );
  return (
    <details open={total <= REPORT_COLLAPSE_THRESHOLD}>
      <summary>
        {total} page{total > 1 ? "s" : ""} affected
      </summary>
      <div className="pages-list">
        {hasMore && (
          <div className="pages-truncated-note">
            Showing {materialized.length.toLocaleString()} of {total.toLocaleString()} affected
            pages.
          </div>
        )}
        {inline.map(renderLink)}
        {overflow.length > 0 && (
          <details className="pages-more">
            <summary>+{overflow.length} more{hasMore ? "" : " — show all"}</summary>
            <div className="pages-list">
              {overflow.map((p, i) => renderLink(p, REPORT_PAGES_INLINE_CAP + i))}
            </div>
          </details>
        )}
        {materialized.length > REPORT_COLLAPSE_THRESHOLD && (
          <details className="pages-copy">
            <summary>
              Copy as plain text{hasMore ? ` (first ${materialized.length.toLocaleString()})` : ""}
            </summary>
            <textarea
              readOnly
              rows={Math.min(materialized.length, 10)}
              value={materialized.join("\n")}
            />
          </details>
        )}
      </div>
    </details>
  );
}

// Flat issues list: one section per group (anchor target for the score
// circles), rules in group → category-priority → weight order. No group or
// category headings — each rule carries its parent group as a small label.
function IssuesByGroup({ categories }: { categories: GroupedCategory[] }) {
  if (categories.length === 0) return null;
  const groups = groupCategoriesByGroup(categories);
  return (
    <>
      <h2>Issues</h2>
      {groups.map((group) => (
        <div key={group.code} id={`group-${group.code}`} className="group-section">
          {group.categories.map((category) => (
            <React.Fragment key={category.code}>
              {category.rules.map((rule) => {
                // Sample-union count — the denominator the carried rollup /
                // fully-carried check share with carriedPageCount (both known
                // only for sampled pages; #1135).
                const totalPages = ruleAffectedPageCount(rule.checks);
                // #1023 R-F / #1306: authoritative affected-page total for the
                // header. `count` is a max-based FLOOR (never a sum — that would
                // double-count pages shared across a rule's checks); `hasMore`
                // marks it as a lower bound when 2+ independently-truncated checks
                // could hide disjoint pages, so the header reads "N+" not "N".
                const rollup = ruleAffectedRollup(rule.checks);
                const affectedTotal = rollup.count;
                const carriedPageCount = ruleCarriedPageCount(rule.checks);
                const carriedRollup = ruleCarriedRollupLine(carriedPageCount, totalPages);
                const fullyCarried = carriedPageCount > 0 && carriedPageCount >= totalPages;
                return (
                  <React.Fragment key={rule.id}>
                    <details
                      className="rule-block"
                      style={{
                        borderLeftColor:
                          rule.severity === "error"
                            ? THEME.colors.fail
                            : rule.severity === "warning"
                              ? THEME.colors.warn
                              : THEME.colors.primary,
                      }}
                    >
                      <summary className="rule-summary">
                        <span
                          className="group-label"
                          title={getGroupTitle(group.code)}
                          style={{
                            color: getGroupColor(group.code).text,
                            background: getGroupColor(group.code).bg,
                            borderColor: getGroupColor(group.code).border,
                          }}
                        >
                          {group.name}
                        </span>
                        <span className="rule-name">{rule.name}</span>
                        {/* className keeps the raw severity (drives the .rule-severity.info
                            CSS color rule); the visible text uses severityLabel so info
                            reads as "recommendation" (CSS text-transform:uppercase renders
                            it "RECOMMENDATION", matching the ERROR/WARNING pills). */}
                        <span className={`rule-severity ${rule.severity}`}>
                          {severityLabel(rule.severity)}
                        </span>
                        <span className="rule-affected">
                          {affectedTotal}
                          {rollup.hasMore ? "+" : ""} page
                          {affectedTotal === 1 && !rollup.hasMore ? "" : "s"} affected
                          {fullyCarried && (
                            <span className="carried-badge" title="Not re-checked this run">
                              carried
                            </span>
                          )}
                        </span>
                      </summary>
                      <div className="rule-detail">
                        <div className="rule-detail-header">
                          <span className="rule-id">{rule.id}</span>
                          <a
                            href={getDocsUrl(rule.id)}
                            className="rule-docs-link"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            docs
                          </a>
                        </div>
                        {/* #1135: carried-forward provenance rollup + the "clean
                            everywhere re-checked, only carried pages still red"
                            note — both read from data the CLI/cloud merge
                            already stamps on checks, this is a pure surfacing. */}
                        {carriedRollup && <div className="carried-note">{carriedRollup}</div>}
                        {rule.mixedProvenanceNote && (
                          <div className="carried-note carried-note-mixed">
                            {rule.mixedProvenanceNote}
                          </div>
                        )}
                        {rule.description && (
                          <div className="rule-description">{rule.description}</div>
                        )}
                        {rule.solution &&
                          rule.checks.some((c) => c.status === "fail" || c.status === "warn") && (
                            <div className="rule-solution">
                              <div className="rule-solution-title">Solution</div>
                              {rule.solution}
                            </div>
                          )}
                        <div className="issue-list">
                          {rule.checks.map((check, idx) => {
                            // #1136 review: a site-scope check (blocked-links,
                            // duplicate-title, sitemap-*) stores its affected pages
                            // ONLY on `items[].sourcePages`, not `check.pages` — the
                            // old code fed `check.pages` alone into PagesList, so
                            // these checks got NO expand/copy affordance at all, just
                            // a dead 3-item preview with a non-interactive "+N more".
                            // checkAffectedPages unions both sources into one list so
                            // every check (page-scope or site-scope) gets the same
                            // expand/copy/provenance/cap treatment.
                            // #1023 R-F: `sample` is that union (a labeled example
                            // set); `count` is the authoritative affected-page total.
                            const ap = affectedPages(check);
                            // Items already covered by the unified PagesList above
                            // (pure page-URL ids with no sourcePages) are dropped
                            // from the items block so the same URL isn't listed
                            // twice; items with sourcePages or a non-URL id (a
                            // resource's own identity) still need their own row.
                            const visibleItems = check.items?.filter(
                              (item) => !isRedundantPageItem(item),
                            );
                            const hasVisibleItems = visibleItems && visibleItems.length > 0;
                            const carriedLabel = checkCarriedLabel(check);
                            // Partial carry (some but not all merged instances): a
                            // per-check fraction here would duplicate the rule-level
                            // rollup above, so only call it out when it diverges from
                            // "fully carried" (handled by carriedLabel) or "all fresh".
                            const partialCarried =
                              !carriedLabel && (check.carriedCount ?? 0) > 0
                                ? `${check.carriedCount} of ${check.count} carried from previous crawls.`
                                : null;

                            return (
                              <div key={idx} className="issue-item">
                                <div className={`issue-icon ${check.status}`}>
                                  {check.status === "fail" ? "✗" : "⚠"}
                                </div>
                                <div className="issue-content">
                                  <div className="issue-message">
                                    {check.message}
                                    {ap.count > 1 ? ` (${ap.count} pages)` : ""}
                                  </div>
                                  {(carriedLabel || partialCarried) && (
                                    <div className="carried-note">{carriedLabel ?? partialCarried}</div>
                                  )}
                                  {ap.sample.length > 0 && (
                                    <PagesList
                                      pages={ap.sample}
                                      count={ap.count}
                                      carriedPages={check.carriedPages}
                                    />
                                  )}
                                  {hasVisibleItems && (
                                    <details
                                      open={visibleItems!.length <= REPORT_ITEMS_COLLAPSE_THRESHOLD}
                                    >
                                      <summary>
                                        {visibleItems!.length} item
                                        {visibleItems!.length > 1 ? "s" : ""}
                                      </summary>
                                      <div className="pages-list">
                                        {visibleItems!.map((item, i) => {
                                          const label = item.label ?? item.id;
                                          const isUrl = isPageUrl(item.id);
                                          return (
                                            <div key={i} style={{ marginBottom: "0.5rem" }}>
                                              {isUrl ? (
                                                <a
                                                  href={sanitizeUrl(item.id)}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                >
                                                  {getPathname(item.id) || "/"}
                                                  {item.label ? ` — ${item.label}` : ""}
                                                </a>
                                              ) : (
                                                <span>{label}</span>
                                              )}
                                              {item.sourcePages && item.sourcePages.length > 0 && (
                                                <div
                                                  style={{
                                                    paddingLeft: "1rem",
                                                    fontSize: "0.8rem",
                                                  }}
                                                >
                                                  {item.sourcePages
                                                    .slice(0, REPORT_SOURCE_PAGES_PREVIEW)
                                                    .map((src, j) => (
                                                      <div key={j}>
                                                        from:{" "}
                                                        <a
                                                          href={sanitizeUrl(src)}
                                                          target="_blank"
                                                          rel="noopener noreferrer"
                                                        >
                                                          {getPathname(src) || "/"}
                                                        </a>
                                                      </div>
                                                    ))}
                                                  {/* #1136 review: this preview is capped for
                                                      readability, not truncated with a dead end —
                                                      the full list (expand + copy) is the unified
                                                      PagesList rendered above, covering this
                                                      item's sourcePages too via checkAffectedPages. */}
                                                  {item.sourcePages.length >
                                                    REPORT_SOURCE_PAGES_PREVIEW && (
                                                    <div>
                                                      +
                                                      {item.sourcePages.length -
                                                        REPORT_SOURCE_PAGES_PREVIEW}{" "}
                                                      more (see full list above)
                                                    </div>
                                                  )}
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </details>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </details>
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      ))}
    </>
  );
}

function Footer({ report, branding }: { report: AuditReport; branding?: ReportBranding }) {
  return (
    <div className="footer">
      <div className="footer-stats">
        <span className="pass">{report.passed.toLocaleString()} passed</span>
        <span className="warn">{report.warnings.toLocaleString()} warnings</span>
        <span className="fail">{report.failed.toLocaleString()} failed</span>
      </div>
      {/* White-label (#810) drops the "Generated by squirrelscan.com" credit. */}
      {!branding?.whiteLabel && (
        <div className="footer-branding">
          Generated by{" "}
          <a href="https://squirrelscan.com" target="_blank" rel="noopener noreferrer">
            squirrelscan.com
          </a>
          {report.generatorVersion && (
            <span className="footer-version"> · squirrel v{report.generatorVersion}</span>
          )}
        </div>
      )}
    </div>
  );
}

function TechnologiesSection({ report }: { report: AuditReport }) {
  const tech = report.technologies;
  if (!tech || tech.items.length === 0) return null;
  const summary = techChangeSummary(tech);
  return (
    <div className="tech-section">
      <h2>Technologies</h2>
      <div className="tech-note">
        Detected tech stack — informational, not part of the score.
        {summary ? ` ${summary}.` : ""}
      </div>
      {groupTechnologies(tech.items).map((group) => (
        <div className="tech-group" key={group.category}>
          <div className="tech-group-label">
            {group.emoji} {group.label}
          </div>
          <div className="tech-badges">
            {group.items.map((t) => {
              return (
                <span className="tech-badge" key={t.id}>
                  <span>{t.name}</span>
                  {t.version && <span className="tech-ver">{t.version}</span>}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// Single STATIC inline script that hides any `.screenshot-section` whose <img>
// fails to load. The screenshot is captured async/best-effort, so its URL may
// 404 until ready (or never resolve) — this prunes the empty frame at runtime.
//
// CSP posture: this is the ONLY inline script in a published report and its text
// is byte-stable, so it is whitelistable by hash without `script-src
// 'unsafe-inline'`. Keep it verbatim; if you change a single byte, recompute the
// hash below. We deliberately avoid per-element inline `onerror` handlers (the
// pre-#254 approach) because those require `unsafe-inline` and cannot be hashed.
//   script-src 'sha256-Fu8mj2B5SuCv4ph95rAxY9dudvmYaovfauNXB3wX6X0='
// Exported so a test can pin sha256(SCREENSHOT_HIDE_SCRIPT) to the CSP hash in
// the comment above — if the script body changes without updating the hash, a
// real CSP would silently block it in prod while everything else still passes.
export const SCREENSHOT_HIDE_SCRIPT =
  'for(var i,a=document.querySelectorAll(".screenshot-section img"),n=0;n<a.length;n++)(i=a[n]).addEventListener("error",function(){var s=this.closest(".screenshot-section");if(s)s.style.display="none"})';

function screenshotImgSrc(report: AuditReport): string | null {
  const url = report.screenshotUrl;
  // Backward-compatible: absent for local/offline runs and pre-feature reports —
  // renders nothing. Only http(s) URLs are allowed through.
  if (!url) return null;
  const safe = sanitizeUrl(url);
  if (safe === "#") return null;
  return safe;
}

function EditorSummarySection({ report }: { report: AuditReport }) {
  const es = report.editorSummary;
  if (!es) return null;
  const paragraphs = es.prose
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div className="editor-summary-section">
      <h2>Editor&apos;s summary</h2>
      <div className="editor-summary-note">{EDITOR_SUMMARY_NOTE}</div>
      {paragraphs.map((para, i) => (
        <p className="editor-summary-prose" key={i}>
          {para}
        </p>
      ))}
      {es.bigTicket.length > 0 && (
        <ul className="editor-summary-bigticket">
          {es.bigTicket.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
      {es.verdict && (
        <div className="editor-summary-verdict">
          <strong>Verdict:</strong> {es.verdict}
        </div>
      )}
    </div>
  );
}

function DomainStatsSection({ report }: { report: AuditReport }) {
  const stats = report.domainStats;
  if (!stats) return null;
  const rows = domainStatRows(stats.metrics);
  if (rows.length === 0) return null;
  const bands = allPositionBands(stats.metrics.positions);
  const hasPositions = bands.some((b) => b.count > 0);
  return (
    <div className="domain-stats-section">
      <h2>Domain stats</h2>
      <div className="domain-stats-note">{DOMAIN_STATS_NOTE}</div>
      <div className="domain-stats-grid">
        {rows.map((row) => (
          <div className="domain-stat" key={row.label}>
            <span className="domain-stat-value">{row.value}</span>
            <span className="domain-stat-label">{row.label}</span>
          </div>
        ))}
      </div>
      {hasPositions && (
        <div className="domain-stats-positions">
          <div className="domain-stats-positions-label">Organic positions</div>
          <PositionChart bands={bands} />
        </div>
      )}
    </div>
  );
}

// No client JS — inline-style widths required for renderToStaticMarkup (#491).
function PositionChart({ bands }: { bands: { label: string; count: number }[] }) {
  // max ≥ 1 so an empty array can't yield -Infinity and the 2% floor stays reachable.
  const max = Math.max(1, ...bands.map((b) => b.count));
  return (
    <div className="position-chart">
      {bands.map((b) => (
        <div className="position-bar" key={b.label}>
          <span className="position-band">{b.label}</span>
          <div className="position-track">
            <div
              className="position-fill"
              // empty band → no fill; else floor at 2% so a single-keyword band stays visible
              style={{ width: b.count === 0 ? "0%" : `${Math.max(2, (b.count / max) * 100)}%` }}
            />
          </div>
          <span className="position-count">{b.count.toLocaleString("en-US")}</span>
        </div>
      ))}
    </div>
  );
}

// Phosphor (react-icons/pi) per row — matches the dashboard's Site-profile icons.
const PROFILE_ICONS: Record<SiteProfileRowKey, IconType> = {
  type: PiTag,
  audience: PiUsersThree,
  identity: PiBuildings,
  contacts: PiAddressBook,
  socials: PiShareNetwork,
  domain: PiCalendarBlank,
};

function SiteProfileSection({ report }: { report: AuditReport }) {
  const meta = report.siteMetadata;
  if (!meta) return null;
  const rows = siteProfileRows(meta);
  const flags = siteProfileFlags(meta);
  return (
    <div className="profile-section">
      <h2>Site profile</h2>
      <div className="profile-note">{SITE_PROFILE_NOTE}</div>
      <div className="profile-grid">
        {rows.map((row) => {
          const Icon = PROFILE_ICONS[row.key];
          return (
            <React.Fragment key={row.key}>
              <div className="profile-label">
                <Icon className="profile-icon" aria-hidden /> {row.label}
              </div>
              <div className="profile-value">
                {row.url ? (
                  <a href={sanitizeUrl(row.url)} target="_blank" rel="noopener noreferrer">
                    {row.value}
                  </a>
                ) : (
                  row.value
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
      {flags && (
        <div className="profile-flags">
          {flags.split(" · ").map((flag) => (
            <span className="profile-flag" key={flag}>
              {flag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CacheSection({ report }: { report: AuditReport }) {
  const cs = report.cacheStats;
  if (!cs) return null;
  const byReason = cacheReasonsLabel(cs);
  // Quiet audit metadata, not a scored headline: a small muted inline line that
  // sits alongside the other run metadata (date/duration/pages).
  return (
    <div className="cache-meta">
      <span className="cache-meta-label">Cache</span>
      <span>
        {cacheHitRatePercent(cs)}% hit rate · {cs.hits.toLocaleString()}/{cs.total.toLocaleString()}{" "}
        hits · {formatBytes(cs.bytesSaved)} saved
        {byReason ? ` (${byReason})` : ""}
      </span>
      <span className="cache-meta-note">{CACHE_STATS_NOTE}</span>
    </div>
  );
}

// Bottom-of-report upsell / notice: cloud-gated rules that didn't run this audit.
// Messaging is audience-aware (#368): anonymous/local runs get the free-account
// signup upsell; signed-in runs ("free"/"paid") get a neutral "didn't run" notice
// — a paying user must never be told to "get a free account". An explicit --http
// opt-out (cloudMode "http") reads as a deliberate choice, never "unavailable".
// Cause precedence follows the audit pipeline (#747): a failed audit ran nothing
// at all; quick coverage never attempts cloud regardless of render mode; --http
// only matters when cloud would otherwise run. The "temporarily unavailable"
// copy is the last resort, reserved for surface/full runs that really tried.
function LockedRulesSection({
  report,
  branding,
}: {
  report: AuditReport;
  branding?: ReportBranding;
}) {
  // White-label reports (#810) omit the cloud upsell / account CTA entirely — it
  // references squirrelscan signup, credits, and the dashboard.
  if (branding?.whiteLabel) return null;
  // Audience logic (audit-failed / quick-coverage / --http opt-out / plan tier)
  // lives in the shared `lockedRulesMessage` helper (#780) so this and every
  // other renderer (llm/markdown/text) plus the CLI footer read the same copy.
  const msg = lockedRulesMessage(report);
  if (!msg) return null;
  return (
    <div className="locked-section">
      <h2>
        <span aria-hidden="true">🔒</span> {msg.heading}
      </h2>
      <p className="locked-note">
        {msg.action}
        {msg.cta && (
          <>
            {" "}
            <a href={msg.cta.url} target="_blank" rel="noopener noreferrer">
              {msg.cta.label}
            </a>
            .
          </>
        )}
      </p>
      <div className="locked-grid">
        {msg.rules.map((rule) => (
          <div className="locked-rule" key={rule.id}>
            <span className="locked-rule-icon" aria-hidden>
              🔒
            </span>
            <span className="locked-rule-name">{rule.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportPage({
  report,
  reportId,
  branding,
}: {
  report: AuditReport;
  reportId?: string;
  branding?: ReportBranding;
}) {
  const categoryIssues = groupIssuesByCategory(report.ruleResults);
  const hasIssues = categoryIssues.length > 0;
  // #792: a 0-page failed/blocked run has no issues, but "No issues found"
  // would read as a clean pass. The FailureNotice carries the real state, so
  // the no-issues tile renders nothing for these.
  const isFailedOrBlocked = report.status === "failed" || report.status === "blocked";
  // Group codes that have an issues section — those score circles become links.
  const issueGroups = new Set<string>(categoryIssues.map((c) => c.group));
  const score = report.healthScore?.overall;
  let baseUrlHost = report.baseUrl;
  try {
    baseUrlHost = new URL(report.baseUrl).hostname.replace(/^www\./, "");
  } catch {}
  // Only emit the hide-on-error script when a screenshot section is actually
  // rendered, so reports without one stay fully script-free.
  const hasScreenshot = screenshotImgSrc(report) !== null;

  // Shared by <meta name="description"> and og:description — health score plus
  // the 4 group scores (group names derive from codes, so renames apply to
  // stored reports; pre-#626 reports have no groups and skip that part).
  const scoreGroups = report.healthScore?.groups ?? [];
  const groupsPart =
    scoreGroups.length > 0
      ? ` · ${scoreGroups.map((g) => `${getGroupName(g.group)} ${g.score}`).join(" · ")}`
      : "";
  const metaDescription =
    score != null
      ? `Health score ${score} (${getScoreGrade(score)})${groupsPart} · ${report.totalPages} page${report.totalPages === 1 ? "" : "s"} audited`
      : `Website audit report · ${report.totalPages} page${report.totalPages === 1 ? "" : "s"} · ${report.failed} failed, ${report.warnings} warnings`;

  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{`Audit Report - ${baseUrlHost}`}</title>
        <meta name="description" content={metaDescription} />
        {reportId && (
          <>
            <meta property="og:type" content="website" />
            <meta property="og:title" content={`Audit Report - ${baseUrlHost}`} />
            <meta property="og:description" content={metaDescription} />
            <meta property="og:url" content={`https://reports.squirrelscan.com/${reportId}`} />
            <meta
              property="og:image"
              content={`https://reports.squirrelscan.com/${reportId}/og.png`}
            />
            <meta property="og:image:width" content="1200" />
            <meta property="og:image:height" content="630" />
            {/* White-label (#810): org name as site_name, or omit; OG image
                itself stays squirrelscan-branded (v1 non-goal). */}
            {branding?.whiteLabel ? (
              branding.orgName && <meta property="og:site_name" content={branding.orgName} />
            ) : (
              <meta property="og:site_name" content="squirrelscan" />
            )}
            <meta name="twitter:card" content="summary_large_image" />
          </>
        )}
        <style>{styles}</style>
      </head>
      <body>
        <ReportHeader report={report} branding={branding} />
        <div className="container">
          <FailureNotice report={report} />
          <GroupScores report={report} issueGroups={issueGroups} />
          <EditorSummarySection report={report} />
          <SummaryStats report={report} />
          <ScreenshotSection report={report} />
          <SiteProfileSection report={report} />
          <DomainStatsSection report={report} />
          <TechnologiesSection report={report} />
          {hasIssues ? (
            <IssuesByGroup categories={categoryIssues} />
          ) : isFailedOrBlocked ? null : (
            <div className="no-issues">✓ No issues found</div>
          )}
          <LockedRulesSection report={report} branding={branding} />
          {/* Cache reuse — quiet run metadata, pinned to the very bottom. */}
          <CacheSection report={report} />
          <Footer report={report} branding={branding} />
        </div>
        {hasScreenshot && <script dangerouslySetInnerHTML={{ __html: SCREENSHOT_HIDE_SCRIPT }} />}
      </body>
    </html>
  );
}

/**
 * Render audit report to HTML string.
 * Pure function - no file I/O.
 * Changing this output? Bump REPORT_HTML_VERSION (constants.ts) so cached HTML invalidates.
 */
export function renderHtml(report: AuditReport, options?: HtmlRenderOptions): string {
  return (
    "<!DOCTYPE html>" +
    renderToStaticMarkup(
      <ReportPage report={report} reportId={options?.reportId} branding={options?.branding} />,
    )
  );
}
