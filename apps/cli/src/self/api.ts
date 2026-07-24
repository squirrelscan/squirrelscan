export const DEFAULT_API_URL = "https://api.squirrelscan.com";

export function getApiUrl(): string {
  return process.env.SQUIRREL_API_SERVER ?? DEFAULT_API_URL;
}
