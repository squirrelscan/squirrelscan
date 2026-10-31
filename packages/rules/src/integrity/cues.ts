// The sign-in wording the integrity rules match, defined once (#1460).
//
// `signals.ts` decides whether a control's label is a sign-in affordance (`AUTH_LABEL`, `PROVIDER_BUTTON`), and
// `controls.ts` decides which windows of a long attribute are worth reading at all, from the same lists: a window that
// holds none of these phrases' first words cannot match either pattern. Both read the lists below, so a verb added here
// widens the pattern and the prefilter together.

/** Phrases that make a label a sign-in affordance by themselves. */
export const AUTH_LABEL_PHRASES = ["sign in", "log in", "login", "continue with", "verify"] as const;
/** The subset that says the control is a sign-in, not only a continuation. */
export const SIGN_IN_PHRASES = ["sign in", "log in", "login"] as const;
/** Verbs of a provider's own button, `<verb> with <provider>`; a space may be missing inside one (`signin`). */
export const PROVIDER_VERBS = ["continue", "sign in", "log in", "logon"] as const;
export const PROVIDER_BRANDS = ["google", "microsoft"] as const;

const spaced = (phrase: string): string => phrase.replace(/ /g, " ?");

export const AUTH_LABEL = new RegExp(`\\b(${AUTH_LABEL_PHRASES.join("|")})\\b`);
export const SIGN_IN_LABEL = new RegExp(`\\b(${SIGN_IN_PHRASES.join("|")})\\b`);
/**
 * "Continue with Google" / "Continue with Microsoft": the providers' own button wording. "Continue with Microsoft
 * account" is a link about an account, not the button (pub#696). A space is optional between the words, so a label
 * split by markup (`Sign<br>in with Goo<i>gle</i>`, read as `signin with google`) is the same cue; the boundaries at
 * each end are whole-word.
 */
export const PROVIDER_BUTTON = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${PROVIDER_VERBS.map(spaced).join("|")}) ?with ?(?:${PROVIDER_BRANDS.join("|")})(?![\\p{L}\\p{N}])(?! ?account)`,
  "u",
);

/** Every auth phrase the patterns above are built from, for the window prefilter. */
export const AUTH_CUE_PHRASES: readonly string[] = [...AUTH_LABEL_PHRASES, ...PROVIDER_VERBS];
