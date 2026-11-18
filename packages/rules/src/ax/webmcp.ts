// ax/webmcp - report declarative WebMCP tool declarations (<form toolname tooldescription>) found in the raw
// HTML and flag declarations that cannot become a valid tool. WebMCP is an early browser preview, so everything
// here is informational: a site without it loses nothing, and a bad declaration is a score-neutral warn.
// Imperative registration (navigator.modelContext in script) is detected in inline scripts but never validated.

import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { elementSelector } from "../element-path";

/**
 * squirrelscan's validity check for a toolname: 1 to 64 characters of letters, digits, `_`, `.` or `-`. It mirrors
 * the tool-name conventions of MCP clients, which reject spaces and most punctuation. The WebMCP explainer does not
 * fix a charset, so this is our rule and not a standard.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Longest inline script text read for the imperative-API probe. */
const MAX_SCRIPT_SCAN = 500_000;
const DESCRIPTION_SNIPPET = 80;
const MAX_TOOL_ITEMS = 50;

const RELATED_RULES = [
  "a11y/button-name",
  "a11y/aria-input-field-name",
  "a11y/aria-required-children",
  "a11y/aria-required-parent",
  "a11y/aria-hidden-focus",
  "a11y/aria-roles",
  "a11y/form-labels",
  "perf/cls-hints",
  "security/form-captcha",
];

export type WebMcpProblemKind =
  | "empty-name"
  | "invalid-name"
  | "missing-description"
  | "duplicate-name"
  | "toolname-on-non-form"
  | "unnamed-control"
  | "conflicting-param-types";

export interface WebMcpTool {
  name: string;
  description: string;
  params: string[];
  autosubmit: boolean;
  element: Element;
}

export interface WebMcpProblem {
  kind: WebMcpProblemKind;
  /** The tool name as written (may be empty). */
  tool: string;
  message: string;
  element: Element;
}

export interface WebMcpScan {
  tools: WebMcpTool[];
  problems: WebMcpProblem[];
}

const NON_PARAM_INPUT_TYPES = new Set(["submit", "button", "reset", "image", "hidden"]);

function controlType(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "select" || tag === "textarea") return tag;
  return (el.getAttribute("type") ?? "text").trim().toLowerCase() || "text";
}

/** Controls that can be a tool parameter: input/select/textarea, minus buttons, images and hidden inputs. */
function paramControls(form: Element): Element[] {
  return [...form.querySelectorAll("input, select, textarea")].filter(
    (el) => el.tagName.toLowerCase() !== "input" || !NON_PARAM_INPUT_TYPES.has(controlType(el)),
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/**
 * A form action safe to show in a report: the query string and fragment are dropped (they can carry tokens
 * or personal data), and so is any userinfo (`user:password@`) in the authority of an absolute or
 * protocol-relative URL. Tabs and newlines are removed first, as a browser does when it parses the action.
 */
export function redactFormAction(raw: string): string {
  const action =
    raw
      .replace(/[\t\n\r]/g, "")
      .trim()
      .split(/[?#]/)[0] ?? "";
  // Protocol-relative, or a scheme followed by any run of slashes (browsers accept "https:/u:p@h" too).
  const m = /^((?:[a-z][a-z0-9+.-]*:[\\/]*)|[\\/]{2,})(.*)$/i.exec(action);
  if (!m) return action;
  const prefix = m[1] ?? "";
  const rest = m[2] ?? "";
  const sep = rest.search(/[\\/]/);
  const authority = sep === -1 ? rest : rest.slice(0, sep);
  if (authority.includes("@")) return prefix + rest.slice(authority.lastIndexOf("@") + 1);
  // An unencoded "/" or "\\" in a password ends the authority early ("user:pa/ss@host"). Treat a later "@"
  // as the end of userinfo when the text before the first separator is user:password, not host:port.
  const at = rest.lastIndexOf("@");
  if (at !== -1 && authority.includes(":") && !/:\d*$/.test(authority))
    return prefix + rest.slice(at + 1);
  return action;
}

/** Pure validation over a parsed document: collect every `form[toolname]` and the problems with the declarations. */
export function scanWebMcpDeclarations(doc: Document): WebMcpScan {
  const tools: WebMcpTool[] = [];
  const problems: WebMcpProblem[] = [];
  const seen = new Set<string>();

  for (const form of doc.querySelectorAll("form[toolname]")) {
    const rawName = form.getAttribute("toolname") ?? "";
    const description = (form.getAttribute("tooldescription") ?? "").trim();
    const controls = paramControls(form);

    const named = new Map<string, Set<string>>();
    for (const control of controls) {
      const name = (control.getAttribute("name") ?? "").trim();
      const hasToolMeta =
        control.hasAttribute("required") ||
        control.hasAttribute("toolparamdescription") ||
        control.hasAttribute("toolparamtitle");
      if (!name) {
        if (hasToolMeta) {
          problems.push({
            kind: "unnamed-control",
            tool: rawName,
            message: `<${control.tagName.toLowerCase()}> in tool "${clip(rawName, 64)}" is required or described but has no name, so it cannot appear in the tool schema`,
            element: control,
          });
        }
        continue;
      }
      const types = named.get(name) ?? new Set<string>();
      types.add(controlType(control));
      named.set(name, types);
    }
    for (const [name, types] of named) {
      // A radio or checkbox group shares one name by design and has one type, so only a mix of types conflicts.
      if (types.size > 1) {
        problems.push({
          kind: "conflicting-param-types",
          tool: rawName,
          message: `Parameter "${clip(name, 64)}" in tool "${clip(rawName, 64)}" is declared by controls of conflicting types (${[...types].sort().join(", ")})`,
          element: form,
        });
      }
    }

    tools.push({
      name: rawName.trim(),
      description,
      params: [...named.keys()],
      autosubmit: form.hasAttribute("toolautosubmit"),
      element: form,
    });

    if (rawName.trim() === "") {
      problems.push({
        kind: "empty-name",
        tool: rawName,
        message: "A form has an empty toolname, so it has no tool name",
        element: form,
      });
    } else {
      if (!TOOL_NAME_PATTERN.test(rawName)) {
        problems.push({
          kind: "invalid-name",
          tool: rawName,
          message: `toolname "${clip(rawName, 64)}" is not 1 to 64 characters of letters, digits, _, . or -`,
          element: form,
        });
      }
      if (seen.has(rawName)) {
        problems.push({
          kind: "duplicate-name",
          tool: rawName,
          message: `toolname "${clip(rawName, 64)}" is declared by more than one form on this page`,
          element: form,
        });
      }
      seen.add(rawName);
    }
    if (description === "") {
      problems.push({
        kind: "missing-description",
        tool: rawName,
        message: `Tool "${clip(rawName, 64)}" has no tooldescription, or it is empty`,
        element: form,
      });
    }
  }

  for (const el of doc.querySelectorAll("[toolname]:not(form)")) {
    problems.push({
      kind: "toolname-on-non-form",
      tool: el.getAttribute("toolname") ?? "",
      message: `toolname is set on a <${el.tagName.toLowerCase()}> element, but only a <form> can declare a declarative tool`,
      element: el,
    });
  }

  return { tools, problems };
}

function hasVisibleControls(form: Element): boolean {
  return paramControls(form).length > 0;
}

function isImperativeScript(doc: Document): boolean {
  for (const script of doc.querySelectorAll("script:not([src])")) {
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    if (type.includes("json") || type === "importmap" || type === "speculationrules") continue;
    const text = (script.textContent ?? "").slice(0, MAX_SCRIPT_SCAN);
    if (!text.includes("navigator.modelContext")) continue;
    if (text.includes("registerTool") || text.includes("provideContext")) return true;
  }
  return false;
}

// linkedom types Element without `dataset`, so read data-* attributes directly.
function dataAttr(el: Element, key: string): string | null {
  return el.getAttribute(`data-${key}`);
}

const CHALLENGE_SELECTOR = ".g-recaptcha, .h-captcha, .frc-captcha, .cf-turnstile";

/**
 * A visible challenge: a reCAPTCHA, hCaptcha, Friendly Captcha or Turnstile widget element. Not visible when
 * data-size="invisible", when Turnstile has data-appearance="interaction-only", or when the class sits on a
 * button or input (the invisible-binding pattern, where the submit control triggers the check).
 */
function visibleChallengeProvider(el: Element): string | null {
  const cls = ` ${(el.getAttribute("class") ?? "").toLowerCase()} `;
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "input") return null;
  if ((dataAttr(el, "size") ?? "").trim().toLowerCase() === "invisible") return null;
  if (cls.includes(" frc-captcha ")) return "Friendly Captcha";
  if (cls.includes(" g-recaptcha ")) return "reCAPTCHA";
  if (cls.includes(" h-captcha ")) return "hCaptcha";
  if (cls.includes(" cf-turnstile ")) {
    return (dataAttr(el, "appearance") ?? "").trim().toLowerCase() === "interaction-only"
      ? null
      : "Turnstile";
  }
  return null;
}

function schemaWarn(
  problems: WebMcpProblem[],
  selectorOf: (el: Element) => Pick<CheckItem, "selector">,
  hasTools: boolean,
): CheckResult {
  const n = problems.length;
  const consequence = hasTools
    ? `; agents may not be able to use ${n === 1 ? "that tool" : "those tools"}`
    : "";
  return {
    name: "webmcp-tool-schema",
    status: "warn",
    message: `${n} WebMCP declaration problem${n === 1 ? "" : "s"} found${consequence}`,
    value: String(n),
    items: problems.slice(0, MAX_TOOL_ITEMS).map((p, i) => ({
      id: `${p.kind}:${p.tool.slice(0, 64) || i}`,
      label: p.message,
      ...selectorOf(p.element),
    })),
    details: {
      problems: problems
        .slice(0, MAX_TOOL_ITEMS)
        .map((p) => ({ kind: p.kind, tool: p.tool, message: p.message })),
      ...(n > MAX_TOOL_ITEMS ? { additional: n - MAX_TOOL_ITEMS } : {}),
    },
  };
}

export const webmcpRule: Rule = {
  meta: {
    id: "ax/webmcp",
    name: "WebMCP",
    description:
      "Reports declarative WebMCP tools (form toolname and tooldescription) found in the page HTML and flags declarations with an invalid schema. Informational: a site without WebMCP loses no score",
    solution:
      "WebMCP lets a page offer actions to a browsing agent. Declaratively, a <form> becomes a tool with toolname and tooldescription attributes, and its named controls become the input schema (toolparamtitle and toolparamdescription refine them). Imperatively, script calls navigator.modelContext.registerTool or provideContext. Give every tool form a toolname of 1 to 64 letters, digits, _, . or - (squirrelscan's validity check), a plain-language tooldescription, and a name on every control that belongs in the schema. Agents also need the page to work for them as an accessibility tree: see a11y/button-name, a11y/aria-input-field-name, a11y/aria-required-children, a11y/aria-required-parent, a11y/aria-hidden-focus, a11y/aria-roles and a11y/form-labels, which report those findings, and perf/cls-hints for layout shift. This rule does not repeat them. Keep the abuse protection security/form-captcha asks for, but on a tool form use an invisible or agent-tolerant check: an agent acting for a person cannot solve a visible challenge.",
    category: "ax",
    scope: "page",
    verdictScope: "page",
    severity: "info",
    weight: 1,
    itemSelectors: true,
    checks: [
      {
        name: "webmcp-declarative-tools",
        outcome: "clean",
        clears: ["webmcp-forms-without-tools", "webmcp-imperative", "webmcp-tool-form-challenge"],
      },
      { name: "webmcp-declarative-tools", outcome: "skipped" },
      { name: "webmcp-tool-schema", outcome: "problem" },
      { name: "webmcp-tool-schema", outcome: "clean", clears: ["webmcp-tool-schema"] },
      { name: "webmcp-forms-without-tools", outcome: "problem" },
      { name: "webmcp-imperative", outcome: "problem" },
      { name: "webmcp-tool-form-challenge", outcome: "problem" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) {
      return {
        checks: [
          {
            name: "webmcp-declarative-tools",
            status: "skipped",
            message: "No parsed document, so WebMCP declarations were not checked",
          },
        ],
      };
    }

    const selectorOf = (el: Element) =>
      ctx.wantsItemSelectors ? { selector: elementSelector(el) } : {};
    const checks: CheckResult[] = [];
    const { tools, problems } = scanWebMcpDeclarations(doc);

    if (tools.length > 0) {
      checks.push({
        name: "webmcp-declarative-tools",
        status: "info",
        message: `Found ${tools.length} declarative WebMCP tool${tools.length === 1 ? "" : "s"} in the page HTML`,
        value: String(tools.length),
        items: tools.slice(0, MAX_TOOL_ITEMS).map((t) => ({
          id: t.name || "(unnamed)",
          label: `${t.name || "(unnamed)"}: ${clip(t.description, DESCRIPTION_SNIPPET) || "(no description)"}`,
          ...selectorOf(t.element),
        })),
        details: {
          tools: tools.slice(0, MAX_TOOL_ITEMS).map((t) => ({
            name: t.name,
            description: t.description,
            params: t.params,
            autosubmit: t.autosubmit,
          })),
          relatedRules: RELATED_RULES,
        },
      });

      if (problems.length > 0) {
        checks.push(schemaWarn(problems, selectorOf, true));
      } else {
        checks.push({
          name: "webmcp-tool-schema",
          status: "pass",
          message:
            "Every declarative WebMCP tool has a valid name, description and parameter schema",
        });
      }
    } else {
      checks.push({
        name: "webmcp-declarative-tools",
        status: "info",
        message: "No declarative WebMCP tools",
        value: "0",
        details: { tools: [], relatedRules: RELATED_RULES },
      });
      // A toolname on a non-form element is a mistake even when no form declares a tool.
      if (problems.length > 0) checks.push(schemaWarn(problems, selectorOf, false));
    }

    const plainForms = [...doc.querySelectorAll("form:not([toolname])")].filter(hasVisibleControls);
    if (plainForms.length > 0) {
      checks.push({
        name: "webmcp-forms-without-tools",
        status: "info",
        message: `${plainForms.length} form${plainForms.length === 1 ? "" : "s"} on this page ${plainForms.length === 1 ? "is" : "are"} not declared as WebMCP tools. Add toolname and tooldescription to the forms that represent tasks an agent should be able to do`,
        value: String(plainForms.length),
        items: plainForms.slice(0, MAX_TOOL_ITEMS).map((f, i) => {
          const action = redactFormAction(f.getAttribute("action") ?? "");
          return {
            id: f.getAttribute("id") || f.getAttribute("name") || `form-${i + 1}`,
            label: action ? `form posting to ${clip(action, 80)}` : "form",
            ...selectorOf(f),
          };
        }),
      });
    }

    if (isImperativeScript(doc)) {
      checks.push({
        name: "webmcp-imperative",
        status: "info",
        message:
          "An inline script registers WebMCP tools through navigator.modelContext. Detected but not validated: external scripts and runtime registration are not checked from the raw HTML",
      });
    }

    const challenged: { tool: WebMcpTool; providers: string[] }[] = [];
    for (const tool of tools) {
      const providers = new Set<string>();
      for (const el of tool.element.querySelectorAll(CHALLENGE_SELECTOR)) {
        const provider = visibleChallengeProvider(el);
        if (provider) providers.add(provider);
      }
      if (providers.size > 0) challenged.push({ tool, providers: [...providers].sort() });
    }
    if (challenged.length > 0) {
      checks.push({
        name: "webmcp-tool-form-challenge",
        status: "info",
        message: `${challenged.length} WebMCP tool form${challenged.length === 1 ? " has" : "s have"} a visible challenge widget. An agent acting for a person cannot pass a visible challenge. Keep the abuse protection that security/form-captcha asks for, but use an invisible or agent-tolerant check on this form`,
        value: String(challenged.length),
        items: challenged.map(({ tool, providers }) => ({
          id: tool.name || "(unnamed)",
          label: `${tool.name || "(unnamed)"}: ${providers.join(", ")}`,
          ...selectorOf(tool.element),
        })),
        details: { relatedRules: ["security/form-captcha"] },
      });
    }

    return { checks };
  },
};
