/**
 * Shared upgrade-messaging for plan-gated API error codes (#739). No CLI
 * command consumes `team_plan_required` yet (there's no `squirrel` invite
 * command today — invites are dashboard-only), but any surface that receives
 * it from the API should print the same message rather than a raw error
 * code, so this lives centrally for the first caller to use.
 */
import { PRICING_URL } from "@/constants";

export function teamPlanRequiredMessage(): string {
  return `This requires the Team plan.\nSee ${PRICING_URL} to upgrade.`;
}
