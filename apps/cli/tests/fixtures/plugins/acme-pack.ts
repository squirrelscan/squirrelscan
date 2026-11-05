// A plugin with one page rule and one site rule, for the #1599 end-to-end tests.
// Plain objects only: the file is loaded from a scratch directory, not the repo.
export default {
  name: "Acme pack",
  version: "1.0.0",
  capabilities: ["rules"],
  register(ctx: { registerRule(rule: unknown): void }) {
    ctx.registerRule({
      meta: {
        id: "acme/page-title-note",
        name: "Page title note",
        description: "Flags every page, to prove a plugin page rule ran.",
        solution: "Nothing to fix.",
        category: "content",
        scope: "page",
        verdictScope: "page",
        severity: "warning",
        weight: 1,
      },
      run: () => ({
        checks: [
          {
            name: "page-title-note",
            status: "warn",
            message: "acme page finding",
            items: [{ id: "alpha" }, { id: "beta" }],
          },
        ],
      }),
    });
    ctx.registerRule({
      meta: {
        id: "acme/site-note",
        name: "Site note",
        description: "Flags the site, to prove a plugin site rule ran.",
        solution: "Nothing to fix.",
        category: "content",
        scope: "site",
        severity: "warning",
        weight: 1,
      },
      run: () => ({
        checks: [
          { name: "site-note", status: "warn", message: "acme site finding" },
        ],
      }),
    });
  },
};
