declare module "user-agents" {
  export default class UserAgent {
    constructor(...args: unknown[]);
    toString(): string;
    random(): UserAgent;
  }
}
