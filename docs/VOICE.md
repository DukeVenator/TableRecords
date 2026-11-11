# House voice

This is the standing rule for how TableRecords writes: UI copy, error text, docs, and the files the
pipeline generates. Read it before you write a label, a toast, or a paragraph, and again after any
edit that touches prose. The rules below are the short version that keeps the docs consistent.

## Three registers

Same person, different amount of patience.

| Register | Where | Rules |
|---|---|---|
| Product | Buttons, labels, cards, empty states, dialogs | Second person, present tense, sentence case. Name the object and the next action. Contractions fine. No jargon, no field names, no exclamation marks. |
| System | Errors, warnings, job failures, toasts | What happened, what it means, what to do. One or two sentences. Never a field name. Never "invalid". Never blame. |
| Docs | README, `docs/`, release notes | The builder explaining a decision. First person allowed. Numbers over adjectives. Short sentences. No marketing. |

## Ten rules

1. A person should never see an identifier. Not `sttBeamSize`, not `rollContextBeforeMs`, not a
   `warning.code` chip.
2. Say what to do next. "Pick a voice channel first" beats "A voice channel must be selected".
3. Errors do not apologise and do not blame. No "Oops", "Whoops", "Sorry", or "Please".
4. No "successfully" or "failed to". Say what happened: "Saved 4 players", "The import stopped at
   row 12".
5. Sentence case everywhere, including buttons and headings. "Start recording", not "Start Recording".
6. No exclamation marks, except never.
7. Bold is a label, not emphasis. One bold phrase per section at most.
8. Specific beats reassuring. "3.09 GB" beats "large"; "no audio arrived" beats "something went
   wrong".
9. Jokes stay in Scribblespark's mouth, in the Sharp edges section, and nowhere near an error or a
   consent notice.
10. Cut the frame, keep the fact. "Two caveats: X and Y" beats "Two caveats I would rather flag than
    let you discover later".

## Before and after

Five real ones from the app, the docs, and the generated files.

```text
Before  The active engine reports ready.
After   Parrot is ready.
```

```text
Before  This dashboard has DASHBOARD_TOKEN enabled. Enter it once; it is exchanged for an HttpOnly
        session cookie and is never stored by the UI.
After   This dashboard is locked. Enter the token from your .env file. The browser keeps it for this
        session only.
```

```text
Before  sttBeamSize must be 1..10
After   Beam size runs from 1 to 10.
```

```text
Before  A compact, readable event log for a GM or a later writing pass. It contains no generated prose
        or summaries.
After   Event log for the GM. No summaries, just what happened.
```

```text
Before  2026-11-01 21:45 — **Preview navigation sidebar.** Markdown previews now render a sticky
        contents rail built from the document headings, plus a **Session moments** list for
        scene/break/combat/note markers with their timestamps and colours. … Added
        heading-extraction coverage; 105 tests.
After   2026-11-01 21:45 | Preview sidebar with heading and moment navigation | 105 tests
```

## Words to avoid

Three tiers. Tier 1A is a fail in user copy, Tier 1B is a clarity warning, Tier 2 only counts in
pairs. The lists below are specimens, not copy, so the detector is told to skip them.

<!-- avoid-ai-writing:ignore-start -->
Tier 1A, replace every hit in user copy: delve, tapestry, realm, paradigm, embark, beacon,
testament, robust, comprehensive, cutting-edge, leverage, pivotal, underscore, meticulous, seamless,
game-changer, watershed, nestled, vibrant, thriving, showcase, deep dive, unpack, bustling, intricate,
ever-evolving, holistic, actionable, impactful, learnings, best practices, at its core, synergy,
interplay, genuinely.

Tier 1B, a clarity edit and a warning, not a failure: utilize, in order to, due to the fact that,
serves as, boasts, presents, commence, ascertain, endeavor.

Tier 2, flagged only in pairs: harness, navigate, foster, elevate, unleash, streamline, empower,
bolster, spearhead, resonate, revolutionize, facilitate, underpin, nuanced, crucial, multifaceted,
ecosystem, myriad, plethora, encompass, catalyze, reimagine, cornerstone, paramount, poised,
burgeoning, nascent, quintessential, overarching, underpinning.

Two words this project uses on purpose: `verbatim` (the transcript term of art) and `deterministic`
(the product's guarantee). Do not flag either one.
<!-- avoid-ai-writing:ignore-end -->

## Checking it

The package is `avoid-ai-writing-detector`. Run it on the file you changed:

```powershell
npx --package avoid-ai-writing-detector avoid-ai-writing docs/VOICE.md --context technical
```

The gate is the default of 6 findings per file. Under the gate is a pass; a file that goes over it
needs a read of what it flagged, not an automatic rewrite. The detector measures shape, so a clean
score is not proof of anything and a finding is not evidence about who wrote the text.

Text between `<!-- avoid-ai-writing:ignore-start -->` and `<!-- avoid-ai-writing:ignore-end -->`
is skipped by the detector, which is why the word tiers above do not count against this file. Use the
pair only around quoted specimens, never around real copy, or you have switched the check off.

## Do not

- No invented personality. The dashboard has no character. Scribblespark does, and only she gets a
  joke. A failed import gets a fact.
- No manufactured stakes. Nothing is "in a world where" or "now more than ever". A missing token is a
  missing token.
- No performed candor. "Let's be honest" and "here's the thing" are not honesty. Say the thing.
- No invented specifics. Every number, name, and limit comes from the code or the spec. If the detail
  is missing, say so and leave the gap.
- No extra dashes. Proofreading does not add a dash for drama. Every before/after pair here removes
  something and adds nothing.
