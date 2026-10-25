# 2026-10 Nested a11y containers

squirrelscan/repo#3066. `a11y/aria-text` ran `querySelectorAll("*")` once per `role="text"` element. `a11y/aria-hidden-focus` did the same per `aria-hidden` container, and walked up the ancestors of every descendant as well. So a page that nests those elements made the first quadratic and the second cubic in the nesting depth. Both now do one walk:

- `aria-text` counts each element's focusable descendants as the difference of a running counter between entering and leaving the element.
- `aria-hidden-focus` reads each container's findings from the run of reportable elements between its entry and exit positions in a single pre-order walk.

The output is identical. A parity test runs the previous implementations as an oracle on 600 seeded random pages (`packages/rules/tests/a11y-nesting-parity-3066.test.ts`).

## How

`bun benchmarks/harness/a11y-nesting.ts 1000 5000 20000`. Each page nests N levels of the container, with a focusable link beside each next level. The timing is the rule's `run` only, the minimum of 3, and does not include parsing.

Machine: Apple Silicon laptop (macOS, arm64), Bun 1.4.0, run at low priority (`nice 19`) under the shared heavy-command lock.

## Results

| rule | nesting | before | after |
|---|---:|---:|---:|
| `a11y/aria-text` | 1,000 | 1,259 ms | 8 ms |
| `a11y/aria-text` | 5,000 | 35,328 ms | 23 ms |
| `a11y/aria-text` | 20,000 | not run | 86 ms |
| `a11y/aria-hidden-focus` | 1,000 | 55,628 ms | 22 ms |
| `a11y/aria-hidden-focus` | 5,000 | not run (cubic: hours) | 150 ms |
| `a11y/aria-hidden-focus` | 20,000 | not run | 386 ms |

The parse itself takes 9 s at 20,000 levels: the parser has its own depth cost, tracked separately. The audit-engine golden baseline (518 pages, 309 rules) is unchanged.
