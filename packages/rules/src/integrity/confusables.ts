import { BRAND_SPECS } from "./brand-specs";
import { AUTH_CUE_PHRASES } from "./cues";

// The look-alike fold of the integrity cue matcher (#784, #1410): what a label is read as when a kit swaps letters for
// characters that draw the same, splices invisible blanks into a word, or writes a digit for a letter.
//
// The table is a hand list, not the whole UTS #39 skeleton (about six thousand entries, most of them for scripts and
// symbols that no cue contains). The cues are ASCII words (`sign in`, `log in`, `continue with`, the brand lexicon), so only
// the characters that can stand for one of their letters matter, and a character that is not mapped makes the cue not
// match: the limit is that a look-alike nobody listed is a way past it, which is why the table grows with the evasions
// found. Each entry below was chosen as a character that draws like a Latin letter of a cue, not copied from a data file.

/** Characters that render as nothing: soft hyphens, zero-width spaces and joiners, variation selectors, and the braille blank (U+2800). */
export const INVISIBLE = /\p{Default_Ignorable_Code_Point}|⠀/gu;

/**
 * Latin letters other scripts draw the same: the Cyrillic, Greek and Armenian look-alikes a kit swaps in so a
 * word-bounded cue does not match, plus the dotless i. Applied after NFKC (which folds fullwidth and
 * styled letters) and lower-casing, so these are lower-case forms.
 */
export const CONFUSABLES: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic
  ...Object.entries({ а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h", ԛ: "q", ԝ: "w", ӏ: "l", ѵ: "v", ѡ: "w", ԍ: "g", к: "k", т: "t", н: "h", м: "m", ү: "y", ь: "b", в: "b", п: "n", г: "r" }),
  // Greek (NFKC turns the lunate sigma U+03F2 into the final sigma U+03C2, so both map to c)
  ...Object.entries({ ο: "o", α: "a", ι: "i", ν: "v", ρ: "p", υ: "u", χ: "x", ε: "e", κ: "k", τ: "t", β: "b", η: "n", ω: "w", μ: "u", γ: "y", ϲ: "c", ς: "c" }),
  // Armenian
  ...Object.entries({ օ: "o", ս: "u", ո: "n", հ: "h", ց: "g", ք: "p", ա: "a" }),
  // Latin look-alikes and small capitals
  ...Object.entries({ ɡ: "g", ı: "i", ɩ: "i", ɑ: "a", ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n", ᴏ: "o", ᴘ: "p", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z", ǝ: "e", ȷ: "j" }),
]);
export const CONFUSABLE_RUN = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

/** Digits kept as a letter's stand-in: 0 is o, 3 is e, 5 is s, and 1 is i or l. Others (2, 4, 6, 7, 8, 9) are numbers. */
const DIGIT_LETTERS: Readonly<Record<string, string>> = { "0": "o", "3": "e", "5": "s" };
const FOLDABLE_DIGIT = /[0135]/;
/** Whether a text has a digit that could stand for a letter: the cheap test before any digit fold. */
export const hasFoldableDigit = (text: string): boolean => FOLDABLE_DIGIT.test(text);
const TOKEN = /[\p{L}\p{N}]+/gu;
const LETTER = /\p{L}/u;

/** The words the cues are made of, from the lists the rules match: a swapped digit is resolved to the reading that is one of them. */
const CUE_WORDS: ReadonlySet<string> = new Set(
  [...AUTH_CUE_PHRASES, ...BRAND_SPECS.flatMap((spec) => [...spec.lexicon, ...spec.actionCues]), "with", "account"].flatMap((phrase) => phrase.split(" ")),
);

/** The cue words by length: a swapped-digit token can only be a cue word of its own length. */
const CUE_WORDS_BY_LENGTH: ReadonlyMap<number, string[]> = (() => {
  const byLength = new Map<number, string[]>();
  for (const word of CUE_WORDS) byLength.set(word.length, [...(byLength.get(word.length) ?? []), word]);
  return byLength;
})();

/**
 * One word that mixes letters and digits, with the digits read as the letters they stand for. `1` is `i` or `l`: the reading
 * that is a word of a cue is used (`s1gn` is `sign`, `g00g1e` is `google`, `1og1n` is `login`); a word that is neither way
 * one is read with `i`, and never folded further. A cue word of the token's length is compared letter by letter with each
 * `1` standing for `i` or `l`: no candidate is built, and a token longer than every cue word is read with `i` at once.
 */
function foldToken(token: string): string {
  if (!FOLDABLE_DIGIT.test(token) || !LETTER.test(token)) return token;
  let base = "";
  let hasOne = false;
  for (let k = 0; k < token.length; k++) {
    const ch = token[k]!;
    if (ch === "1") hasOne = true;
    base += DIGIT_LETTERS[ch] ?? ch;
  }
  if (!hasOne) return base;
  for (const word of CUE_WORDS_BY_LENGTH.get(base.length) ?? []) {
    let matches = true;
    for (let k = 0; k < word.length && matches; k++) {
      const ch = base[k]!;
      matches = ch === "1" ? word[k] === "i" || word[k] === "l" : ch === word[k];
    }
    if (matches) return word;
  }
  return base.replaceAll("1", "i");
}

/**
 * The readings of `text`: as written, and with the digits of every word that mixes letters and digits read as the letters they
 * stand for, when that differs (`Office365 login` is read as written, `S1gn 1n` is read as `sign in`, and a cue that contains
 * a digit, such as `office 365`, is not lost to the fold). A number on its own (`1995`, `10`, `5`) and a word with only other
 * digits (`24h`) are not touched. Linear: one pass over the words, each compared with the cue words of its own length, and only a word with a
 * foldable digit and a letter. The caller bounds the length it hands in.
 */
export function digitForms(text: string): string[] {
  if (!FOLDABLE_DIGIT.test(text)) return [text];
  const folded = text.replace(TOKEN, foldToken);
  return folded === text ? [text] : [text, folded];
}
