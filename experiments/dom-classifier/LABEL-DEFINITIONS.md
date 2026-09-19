# Component label definitions

Decision rules for the `componentType` axis, written to be pasted verbatim into
both the Jev and the Luna prompt. Label names are exactly the
`allowedLabels.componentTypes` values in [taxonomy.json](taxonomy.json) and are
not changed here.

These rules exist because of a measured failure, not a hypothetical one. On the
75-page test split the two independent annotators agreed on the
`layout_container` versus `content_section` boundary only **30.6%** of the time,
and **33 of 34 disagreements were on `<footer>` and `<main>` alone**: one
annotator read a `<footer>` as a content section 29 times out of 33, the other
read it as a layout container 28 times out of 33. That is a convention clash, so
the fix is a convention. See
[diverse-corpus/ERROR-ANALYSIS-2026-09-19.md](diverse-corpus/ERROR-ANALYSIS-2026-09-19.md).

---

## Paste block: componentType decision rules

Pick exactly one `componentType` for the node. Work down the precedence ladder
and stop at the first rule that fires. Do not revisit an earlier step because a
later one looks like a better fit.

### Precedence

1. **A specific component**, if the node matches one of the named shapes below.
2. **`content_section`**, if the node is a section of the page's own content,
   with its own subject.
3. **`layout_container`**, if the node only groups or positions other things.
4. **`unknown`**, if there is genuinely no evidence. Abstention is a valid
   answer and is never penalised. Do not guess from a class name alone.

A more specific label always wins. A node that is both a grouping wrapper and a
navigation menu is `navigation_menu`. A node that is both a content section and
a card is `card`.

### The two rules that settle the common case

**`<footer>` and `<header>` elements, and any node whose role is `contentinfo`
or `banner`: label the site-wide chrome `layout_container`.** A site footer or
masthead groups links, legal text and contact details that belong to the whole
site, not to this page's subject. It is a container. Only label it
`content_section` if it carries substantive content about this page's own
subject, which is rare.

  - If the footer or header is dominated by a link menu, `navigation_menu` wins
    on precedence, because it is a specific component.

**`<main>` elements, and any node whose role is `main`: label it
`layout_container` when it only wraps the page's sections, and
`content_section` when it is itself the single body of content.** The test is
whether the node has one subject of its own or several. A `<main>` holding a
hero, three feature blocks and a call to action is a `layout_container`. A
`<main>` holding one article's prose is a `content_section`, or `article` if the
article shape below fires.

### `content_section` versus `layout_container`

Ask one question: **does this node have a subject of its own?**

- **`content_section`**: yes. The node presents one topic, and its heading, prose
  or media are about that topic. Removing it would remove content from the page.
- **`layout_container`**: no. The node exists to group, position, wrap or space
  other nodes. Removing it would change the arrangement, not the content. Its
  text is whatever its children happen to contain.

Tie-breakers, in order, when both still look plausible:

1. **Own heading.** A direct heading child that names the node's topic makes it
   `content_section`.
2. **Mixed subjects.** Children covering unrelated topics make it
   `layout_container`.
3. **Pure wrapper shape.** A single element child, or children that are
   themselves sections, makes it `layout_container`.
4. **Still tied:** choose `layout_container`. It is the weaker claim, and the
   ladder above means a genuine content section will normally have already
   matched a specific component or rule 1.

Do not use size, depth, child count or text length to decide this. Those
measurements were checked against the labels and they do not separate the two.

#### Abstract shapes

```
div > [ h2 "Pricing" , p , ul ]                      -> content_section
    one heading naming one subject, prose beneath it

div > [ section#pricing , section#faq , section#cta ] -> layout_container
    three unrelated subjects, the node itself has none

div > div > section > [ h2 , p ]                      -> layout_container
    single-child wrapper chain; the content lives further down

main > [ h1 "How we test" , p , p , figure ]          -> content_section
    one subject, so the main element is the body, not a wrapper

footer > [ nav , p "© 2026" , ul ]                    -> layout_container
    site chrome grouping links and legal text
```

### Specific components

Each fires only when its shape is present. When two fire, take the one listed
first.

**`navigation_menu`** A node whose main purpose is moving between destinations:
a menu, breadcrumb trail, pagination strip, table of contents or tab bar. The
test is link density and uniformity: most of its text is link labels, and the
links are siblings of the same shape. A `<nav>` element is almost always this.
Not a node that merely contains a link, and not prose with incidental links.

```
nav > ul > [ li>a , li>a , li>a ]                     -> navigation_menu
header > [ img , ul > li>a * 5 ]                      -> navigation_menu
p > [ text , a , text ]                               -> not navigation_menu
```

**`card`** One repeated teaser unit with its own link, title and usually an
image or summary, appearing beside siblings of the same shape. The repetition is
the signal. A single unit standing alone is a `card` only if it clearly has the
teaser shape; otherwise prefer `content_section`.

```
li > [ img , h3 , p , a "Read more" ]  (5 identical siblings) -> card
figure > [ img , figcaption > [ h3 , a ] ]                    -> card
div > [ h2 , p , p , p ]  (no siblings of this shape)         -> content_section
```

**`list`** A collection of short, uniform items with no per-item title-plus-link
teaser shape. Use this when the items are the content, not links to elsewhere.
A `<ul>` or `<ol>` of plain items is a `list`; a `<ul>` of navigation links is a
`navigation_menu`; a `<ul>` of teasers is `card` for the item and `list` only if
the question is about the wrapper.

```
ul > [ li "Fast" , li "Secure" , li "Open" ]          -> list
ol > li > [ h4 , p ] * 8                              -> list
ul > li > a * 6   (all link labels)                   -> navigation_menu
```

**`hero`** The single leading block at the top of the page, carrying the page's
headline, a short supporting line, and usually one or two prominent calls to
action or a large background image. There is at most one per page, and it comes
before the page's other sections. A second, later banner-shaped block is
`banner`, not `hero`.

```
section (first in main) > [ h1 , p , a.button , a.button ]  -> hero
div (first in main) > [ h1 , p , img (full width) ]         -> hero
section (mid page) > [ h2 , p , a.button ]                  -> content_section
```

**`article`** A complete piece of editorial or documentation content: the body
prose of one story, post, guide or reference page, usually with a heading and
several paragraphs. Use it for the content itself, not for a teaser pointing at
it, which is a `card`.

```
article > [ h1 , time , p * 12 ]                      -> article
div > [ h1 , p * 9 , figure , p * 4 ]                 -> article
article > [ h3 , p , a "Read more" ]  (one of many)   -> card
```

**`banner`** A strip that promotes, announces or notifies, spanning the content
width and separable from the page's own subject: a promotion bar, an
announcement strip, a cookie or consent bar, a subscription prompt. Not the
page's leading block, which is `hero`. Not paid third-party advertising, which
is `ad_unit`.

```
div (top of page) > [ p "Free shipping this week" , a ] -> banner
div > [ p "We use cookies" , button , button ]          -> banner
section (first in main) > [ h1 , p , a.button ]         -> hero
```

### Elements with no text

An `<img>`, `<iframe>`, `<video>`, `<audio>`, `<svg>` or `<input>` often carries
no text at all. Label it from its attributes and its container, not from the
empty text:

- `alt`, `title`, `aria-label` and `role` describe what it is.
- The `src` category says whether it is a known embed provider (`youtube`,
  `google`, `recaptcha`, and so on), the site's own asset (`same-site`) or an
  unrecognised third party. The host itself is never carried.
- An element with no attributes and no accessible name is `unknown`, not
  `image`. Do not upgrade a guess into a label.

```
img[alt="Product photo, front"]                       -> image
iframe[title="Install walkthrough", host=player.*]    -> video_player
iframe[no title, host=ads.*]                          -> ad_unit
img[alt="", 1x1]                                      -> unknown
```

---

## Notes for maintainers

- The `<footer>` and `<main>` rules above are conventions chosen to remove a
  measured disagreement. They are not derived from the taxonomy, and either
  could be inverted, as long as **both** annotator prompts carry the same text.
- After changing this file, re-run the component agreement check before
  training. If Jev and Luna still disagree below roughly 70% on the
  `layout_container` and `content_section` rows, the wording has not landed and
  a model trained on those labels will inherit the noise.
- `header` maps to `banner` in the tag baseline in
  `student-training/evaluate_luna.py`, and that mapping scored 0% on all 37
  `header` records. Any change to the header rule here should be reflected there
  before the baseline is quoted again.
