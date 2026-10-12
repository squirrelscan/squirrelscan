# common-misspellings-data.ts

`common-misspellings-data.ts` maps a misspelling to its correction for the
`content/common-misspellings` rule. It exports one string, `COMMON_MISSPELLINGS`,
with one `misspelling correction` pair per line, sorted by misspelling. It is
parsed on first use, not at startup.

## Licence

The list was written for squirrelscan and is MIT, like the rest of this package.
It is not copied or derived from any published misspelling list. The well-known
lists (Wikipedia's "Lists of common misspellings", and codespell, misspell,
typos and cspell, which all trace back to it) are CC BY-SA or derived from it, so
none of them was used as a source, a candidate list or a filter.

## How it was made

The 523 entries (2026-10-13) were written by typo class:

- `ie` and `ei` swapped: `recieve`, `beleive`, `wierd`.
- A doubled consonant written single, or a single one doubled: `accomodate`,
  `occured`, `untill`, `tommorow`.
- Suffixes confused: `-ance`/`-ence`, `-ant`/`-ent`, `-able`/`-ible`, `-ful`/`-full`,
  `-ally`/`-aly`: `independant`, `existance`, `availible`, `usefull`, `basicly`.
- An unstressed vowel written wrong: `seperate`, `definately`, `grammer`.
- Letters dropped or added: `enviroment`, `goverment`, `arguement`, `truely`.
- Two letters swapped in a very common word: `teh`, `thier`, `becuase`, `goign`.
- Words often misspelt on websites: `adress`, `pasword`, `shiping`, `infomation`.

Some `ie`/`ei` and suffix candidates came from a throwaway script, which is not
kept. It took every SCOWL word (US or British) of size 20 or below that is at
least five letters long. It swapped one `ie` for `ei` (or `ei` for `ie`), or
replaced one ending (`-ance`/`-ence`, `-ant`/`-ent`, `-able`/`-ible`, `-ely` to
`-ly`, `-ally` to `-ly`, `-ful` to `-full`), and kept the results that are no word
in either list below. Each entry kept was chosen individually as a misspelling
people actually make.

Left out on purpose:

- Misspellings that are also surnames or brands (`sargent`, `greif`).
- Real words in other languages (`posible`, `profesional`), which pages with a
  wrong `lang="en"` would report.
- Misspellings one letter from two different words (`eigth` for eight or eighth,
  `preceed` for precede or proceed), because the correction would be a guess.

## Checking it

`scripts/check-common-misspellings.ts` checks every line:

- it is two lowercase words, and the lines are sorted with no duplicates;
- the correction is a common English word: SCOWL size 60 or below, in the US,
  British, Canadian or Australian spelling;
- the misspelling is no word at all in either list below, so a valid spelling in
  any variant (`colour`, `organise`, `judgement`) is never reported;
- no correction is itself listed as a misspelling.

```sh
# in a scratch directory, not this repo
bun add wordlist-english@1.2.1 an-array-of-english-words@2.0.0
# then, from the repo root
bun run scripts/check-common-misspellings.ts <scratch>/node_modules/wordlist-english \
  <scratch>/node_modules/an-array-of-english-words/index.json
```

The two word lists are used only by the check. They are not dependencies of this
repo and nothing from them is shipped:

| Input | Version | Licence |
| --- | --- | --- |
| [`wordlist-english`](https://github.com/jacksonrayhamilton/wordlist-english) | 1.2.1 | MIT package. Its words are [SCOWL](http://wordlist.aspell.net/) 2016 lists, Copyright Kevin Atkinson, under SCOWL's permissive notice (its `Copyright` file). |
| [`an-array-of-english-words`](https://github.com/words/an-array-of-english-words) | 2.0.0 | MIT package. Its words come from the [Letterpress word list](https://github.com/lorenbrichter/Words), CC0. |

Adding an entry: write it yourself (do not copy from a published list), keep the
file sorted, run the check, and update the entry count pinned in
`packages/rules/tests/common-misspellings.test.ts`.

## Using it

The data is a plain TypeScript string, not a JSON import, so it loads the same in
every runtime that imports the rules: the compiled CLI, the test runner and a
Workers bundle. The string is parsed into a map the first time an English page is
scanned. The rule's page scan runs during the crawl in streamed audits.
