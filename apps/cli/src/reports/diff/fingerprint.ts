import { createHash } from "node:crypto";

import { KEY_SEPARATOR } from "@/constants";
import { normalizeUrl } from "@/utils/url";

export type IssueTargetType = "item" | "page" | "check";

export function normalizeTargetId(id: string, baseUrl: string): string {
  const raw = id.trim();
  if (!raw) return raw;

  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return normalizeUrl(raw);
    }

    if (raw.startsWith("/")) {
      const resolved = new URL(raw, baseUrl).toString();
      return normalizeUrl(resolved);
    }
  } catch {
    return raw;
  }

  return raw;
}

export function fingerprintForIssue(
  ruleId: string,
  checkName: string,
  targetType: IssueTargetType,
  targetId: string
): string {
  const input = [ruleId, checkName, targetType, targetId].join(KEY_SEPARATOR);
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
