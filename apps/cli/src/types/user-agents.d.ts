declare module "user-agents" {
  interface UserAgentData {
    userAgent: string;
    platform: string;
    deviceCategory: "desktop" | "mobile" | "tablet";
    screenWidth: number;
    screenHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    appName: string;
    vendor: string;
    connection: unknown;
  }

  interface UserAgentInstance {
    data: UserAgentData;
    userAgent: string;
    platform: string;
    deviceCategory: "desktop" | "mobile" | "tablet";
    toString(): string;
    random(): UserAgentInstance;
  }

  type FilterFunction = (data: UserAgentData) => boolean;
  type Filter = FilterFunction | RegExp | string | object | Filter[];

  class UserAgent implements UserAgentInstance {
    constructor(filters?: Filter);
    data: UserAgentData;
    userAgent: string;
    platform: string;
    deviceCategory: "desktop" | "mobile" | "tablet";
    toString(): string;
    random(): UserAgentInstance;
  }

  export default UserAgent;
}
