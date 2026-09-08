// The wording for an audit whose data `self disk --prune` reclaimed (#1912).
//
// Its own module because both ends of the render path need it: the CLI gates in
// `controllers/report.ts` and the structural refusal in `reports/reconstruct.ts`,
// which that controller imports. Putting it in either one makes an import cycle.

/**
 * Why a reclaimed audit cannot be opened, phrased to slot after "Audit ".
 *
 * One definition so the sentence is identical wherever a user meets it — the
 * gate, the diff, the baseline resolver and the report builder.
 */
export function retiredAuditReason(retiredAt: number): string {
  return `data was reclaimed on ${new Date(retiredAt).toISOString().slice(0, 10)}`;
}
