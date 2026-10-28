// eeat/contact-page - Contact page with multiple methods

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";
import { getPathname } from "@squirrelscan/utils";

import { describeSectionPage, findInPageSection } from "../shared/inpage-section";
import { findLinkedUncrawledPage, linkedUncrawledCheck } from "../shared/linked-uncrawled-page";

const isContactPath = (url: string): boolean =>
  EEAT_PAGE_PATTERNS.contact.some((p) => p.test(getPathname(url)));

export const contactPageRule: Rule = {
  meta: {
    id: "eeat/contact-page",
    name: "Contact Page",
    description: "Checks for contact page with multiple contact methods",
    solution:
      "A contact page with multiple contact methods builds trust. Include: email address or contact form, phone number (if applicable), physical address, and social media links. Make contact information easy to find from any page. For local businesses, include business hours. Response time expectations are also helpful. A Contact page your pages link to but the crawl did not fetch (an excluded path, or past the page limit) is reported as linked but not crawled rather than missing, and its contact methods are not checked. On a single-page site, a Contact section (an element whose id is contact, contact-us or a localised slug, linked from the page as #contact) counts as the Contact page when it has an email or phone link or a form.",
    category: "eeat",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "contact-page",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Look for contact page by multilingual URL pattern, then fall back to
    // the page-level Schema.org `ContactPage` @type when the URL slug isn't
    // recognized (e.g. an unknown localized path). See issue #121.
    //
    // Note: we deliberately do NOT fall back on `ContactPoint`. ContactPoint
    // is a property value embedded in Organization schema (often via @graph)
    // that appears on the homepage / every page, so it is not a reliable
    // signal that THIS page is the contact page.
    let contactPage: {
      url: string;
      links: (typeof pages)[0]["parsed"]["links"];
    } | null = null;

    for (const page of pages) {
      const matchesUrl = isContactPath(page.url);
      const matchesSchema = page.parsed.schemas.hasType("ContactPage");
      if (matchesUrl || matchesSchema) {
        contactPage = { url: page.url, links: page.parsed.links };
        break;
      }
    }

    if (!contactPage) {
      // #1208: a one-page site's Contact is a section of the homepage.
      const section = findInPageSection(pages, EEAT_PAGE_PATTERNS.contact);
      if (section) {
        const where = `${describeSectionPage(section.url)} (#${section.id})`;
        checks.push(
          section.hasContactMethod
            ? {
                name: "contact-page",
                status: "pass",
                message: `Contact section found on ${where}`,
                value: `${section.url}#${section.id}`,
              }
            : {
                name: "contact-page",
                status: "info",
                message: `Contact section exists on ${where} but has no email, phone or form`,
                value: "Add a mailto: or tel: link, or a contact form",
              },
        );
        return { checks };
      }
      // pub#740: a Contact page the pages link to but the crawl never fetched
      // is unverified, not missing. Its contact methods cannot be read.
      const linked = ctx.site ? findLinkedUncrawledPage(ctx.site, { href: isContactPath }) : null;
      checks.push(
        linked
          ? linkedUncrawledCheck("contact-page", "Contact page", linked)
          : {
              name: "contact-page",
              status: "warn",
              message: "No Contact page found",
              value: "Create /contact page",
            },
      );
      return { checks };
    }

    checks.push({
      name: "contact-page",
      status: "pass",
      message: "Contact page exists",
      value: contactPage.url,
    });

    // Check for contact methods
    const hasEmail = contactPage.links.some((l) => l.url.startsWith("mailto:"));
    const hasPhone = contactPage.links.some((l) => l.url.startsWith("tel:"));

    const methods: string[] = [];
    if (hasEmail) methods.push("email");
    if (hasPhone) methods.push("phone");

    if (methods.length >= 2) {
      checks.push({
        name: "contact-methods",
        status: "pass",
        message: `Contact page has multiple contact methods`,
        items: methods.map((method) => ({ id: method })),
      });
    } else if (methods.length === 1) {
      checks.push({
        name: "contact-methods",
        status: "info",
        message: "Contact page has limited contact methods",
        value: "Consider adding email, phone, and address",
      });
    }

    return { checks };
  },
};
