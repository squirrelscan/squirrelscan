import type { SquirrelPlugin } from "@squirrelscan/rules";

const plugin: SquirrelPlugin = {
  name: "Example Plugin",
  version: "1.0.0",
  capabilities: ["rules", "listeners"],
  register(ctx) {
    ctx.registerRule({
      meta: {
        id: "custom/example-rule",
        name: "Example Rule",
        description: "Example plugin rule",
        category: "content",
        scope: "page",
        severity: "warning",
        weight: 1,
      },
      run() {
        return { checks: [] };
      },
    });

    ctx.registerListener("audit:started", () => {});
  },
};

export default plugin;
