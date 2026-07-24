// Types
export type {
  ReleaseChannel,
  UserSettings,
  Platform,
  Arch,
  PlatformArch,
  ReleaseManifest,
  GitHubRelease,
  GitHubAsset,
  UpdateCheckResult,
  DoctorCheck,
  DoctorReport,
  InstallResult,
  UpdateResult,
} from "./types";

// Path utilities
export {
  getSquirrelPaths,
  getSettingsPath,
  getReleasePath,
  getBinaryPath,
  getSymlinkPath,
  detectPlatformArch,
  isBinInPath,
} from "./paths";
export type { SquirrelPaths } from "./paths";

// Settings management
export {
  loadSettings,
  saveSettings,
  updateSettings,
  shouldCheckForUpdates,
  DEFAULT_SETTINGS,
} from "./settings";

// Doctor checks
export { runDoctorChecks } from "./doctor";

// GitHub releases client
export {
  fetchReleases,
  fetchManifest,
  getLatestRelease,
  checkForUpdates,
  compareVersions,
  downloadBinary,
  REPO_OWNER,
  REPO_NAME,
} from "./releases";

// Updater
export {
  runBackgroundUpdateCheck,
  runInteractiveUpdate,
  checkOnly,
  installVersion,
  updateSymlink,
} from "./updater";
