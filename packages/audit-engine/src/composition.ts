import type { DocumentFetcher } from "@squirrelscan/fetchers";

export type RuntimeKind = "cli" | "cloud" | "github-app";

export interface RuntimeCapabilities {
  jsRendering: boolean;
  externalPlugins: boolean;
  localFilesystem: boolean;
}

export interface AuditRuntimeComposition {
  kind: RuntimeKind;
  fetcher: DocumentFetcher;
  capabilities: RuntimeCapabilities;
}

export function createCliAuditRuntime(fetcher: DocumentFetcher): AuditRuntimeComposition {
  return {
    kind: "cli",
    fetcher,
    capabilities: {
      jsRendering: false,
      externalPlugins: true,
      localFilesystem: true,
    },
  };
}

export function createCloudAuditRuntime(fetcher: DocumentFetcher): AuditRuntimeComposition {
  return {
    kind: "cloud",
    fetcher,
    capabilities: {
      jsRendering: false,
      externalPlugins: false,
      localFilesystem: false,
    },
  };
}

export function createGithubAppAuditRuntime(fetcher: DocumentFetcher): AuditRuntimeComposition {
  return {
    kind: "github-app",
    fetcher,
    capabilities: {
      jsRendering: false,
      externalPlugins: false,
      localFilesystem: false,
    },
  };
}
