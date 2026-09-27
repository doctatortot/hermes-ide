# Hermes IDE — Visual System Audit & Redesign Proposal

**Date:** 2026-05-09
**Author:** Frontend design audit (post-v1.1.4)
**Status:** Proposal — not implemented. Companion prototype at `docs/design/preview/index.html`.

---

## Executive summary

Hermes IDE has a **better-than-average visual system** for an indie IDE. The existing token taxonomy ("ink", "rule", "paper", "brass", archetype paint), the warm-cool tension between brass and slate-blue, and the publication-flag masthead are all design-aware choices that put it ahead of the VS-Code-with-a-fresh-coat-of-paint crowd.

That said, three things are holding it back from being a *truly distinctive* surface:

1. **The type scale is over-compressed and uneven.** Seven size steps packed into a 9-pixel range (9px–18px) with irregular ratios. The agent-mode prose layer can't breathe; the chrome eats screen real estate at small sizes; on 4K displays everything is microscopic. Fixed pixels everywhere — no fluid scaling, no user-density preference.

2. **Newsreader is loaded but underutilized.** A genuinely beautiful serif sits in the font payload, restricted to "WebFetch / WebSearch excerpts ONLY". This is the single highest-leverage improvement available. Push it into agent prose, empty states, and editorial moments — Hermes goes from "another dark IDE" to "the Edward-Tufte-built-an-IDE" surface, instantly.

3. **No real light theme.** Six themes ship; all six are dark. The "designer (atelier)" theme is warm-dark, not light. A serious chunk of the audience — the prose-and-design-collab crowd, daylight workers, accessibility-conscious users — is being told to install a different IDE.

Plus a handful of system-level papercuts:

- 663 hard-coded `px` values across 72 component CSS files (200 font-size, 463 padding/margin) — token system isn't enforced.
- Spacing scale has gaps (no `--space-5` for 20px, no hero scale > 32px).
- Motion is sparse and uncoordinated — three keyframes total, no timing tokens, no choreographed key moments.
- Border-radius is monotone (3px almost everywhere). No softness axis.
- Six themes, but only the "tron" theme deeply customizes archetype paint. The others mostly swap colors. The archetype system is under-leveraged.

This proposal addresses each. **None of it is breaking.** All recommendations are additive — new tokens alongside the legacy ones, new themes alongside existing, the existing components keep working unchanged. Adoption can be incremental.

---

## What's working — preserve

Before any change, the system has real strengths to preserve:

- **Two-tier token taxonomy.** Legacy `--text-*` / `--bg-*` for the terminal chrome; `--ink-*` / `--bg-paper` / `--rule` for agent-mode prose surface. This lets the chrome stay dense-mono-IDE while the conversation reads like a book. Don't merge them.
- **The "archetype" rendering system.** Six paint modes (paper-cards, glass-cards, hairline-rules, crt-blocks, ribbon-rails, editorial-margin) selectable via tokens. Clever. Just under-used by most themes.
- **The masthead-as-publication-flag concept.** Reads as instrumentation, not chat. Keep.
- **The brass-vs-slate-blue warm/cool tension.** A genuine point of view. Don't water it down to neutral grays.
- **Three self-hosted variable fonts** with thoughtful display-vs-body roles. The infrastructure is there; the usage just needs to widen.

---

## Proposed changes, ranked by leverage

### 1. Type scale overhaul (highest leverage)

**Current:** Seven sizes, uneven ratios, all fixed px.
```
--text-xs: 9px        (1.111x to next)
--text-sm: 10px       (1.1x)
--text-base: 11px     (1.091x)
--text-md: 12px       (1.083x)
--text-lg: 13px       (1.154x)
--text-xl: 15px       (1.2x)
--text-2xl: 18px
```

The ratios shift with each step. There's no visual hierarchy because the differences are barely perceptible at small sizes (10 → 11 → 12 → 13 reads as one blob). Body copy at 11px is *aggressive* even for IDE chrome, and the agent timeline (which is meant to read as prose) inherits the same constraint.

**Proposed:** Modular scale at a 1.125× ratio (major second), anchored at 14px base, fluid via `clamp()`, with a `--user-zoom` multiplier and `--density` modifier.

```css
--user-zoom: 1;          /* 0.875 | 1 | 1.125 — accessibility setting */
--density: 1;            /* 0.875 | 1 | 1.125 — comfortable/compact/dense */
--type-scale-base: clamp(13px, 0.78vw + 11px, 15px);

--text-3xs:  calc(var(--type-scale-base) * 0.7  * var(--user-zoom) * var(--density));   /* ~10px — chip-only */
--text-2xs:  calc(var(--type-scale-base) * 0.79 * var(--user-zoom) * var(--density));   /* ~11px — micro labels */
--text-xs:   calc(var(--type-scale-base) * 0.86 * var(--user-zoom) * var(--density));   /* ~12px — chrome metadata */
--text-sm:   calc(var(--type-scale-base) * 0.93 * var(--user-zoom) * var(--density));   /* ~13px — small body */
--text-base: calc(var(--type-scale-base) * 1    * var(--user-zoom) * var(--density));   /* ~14px — primary body */
--text-md:   calc(var(--type-scale-base) * 1.13 * var(--user-zoom) * var(--density));   /* ~16px — emphasis */
--text-lg:   calc(var(--type-scale-base) * 1.27 * var(--user-zoom) * var(--density));   /* ~18px — section heads */
--text-xl:   calc(var(--type-scale-base) * 1.5  * var(--user-zoom) * var(--density));   /* ~21px — page titles */
--text-2xl:  calc(var(--type-scale-base) * 1.78 * var(--user-zoom) * var(--density));   /* ~25px — display */
--text-3xl:  calc(var(--type-scale-base) * 2.25 * var(--user-zoom) * var(--density));   /* ~32px — hero */
```

Effect:
- Agent prose at `--text-base` (≈14px) — comfortable for reading paragraphs.
- IDE chrome can opt into `--text-sm` or `--text-xs` — still dense, but consistent.
- A 4K display gets ~15px base via the `clamp()`; a 13" laptop gets ~13px. No squinting on either.
- "Compact" density users (the IDE veterans who liked v0.6.16) get the tight feel back via `--density: 0.875`.
- "Comfortable" density users (the prose-and-design-collab crowd) get `--density: 1.125` for breathing room.

**Migration:** Keep the old tokens as aliases for one release. New components use the new tokens. Sweep the 200 hard-coded `font-size: Xpx` over time.

### 2. Editorial typography for agent prose (highest distinctiveness)

Newsreader is already loaded. The variable font supports weights 200-800 + italic. Today it's gated to "WebFetch / WebSearch excerpts ONLY" — a single rare context.

**Proposed:** Newsreader becomes the prose voice of the agent timeline.

- Agent's **text replies** (the "TextBlock" component) — Newsreader 18px/1.55, weight 400, with optional italics for emphasis. *Reads like prose, not chat.*
- **Empty states** (welcome screen, "no sessions yet") — Newsreader display weight 600, large, with a serif drop-cap optional flourish.
- **Section titles in panels** — small-caps Newsreader 14px tracked +50, replacing the existing all-caps Inter.
- **Date / "Today" stamps in session list** — Newsreader italic, low contrast, like a magazine date stamp.

Mono and Inter retain their current jobs:
- **Mono** — code, tool calls, file paths, the cost meter, the mastthead, terminal mode (everything that says "this is computational").
- **Inter Tight** — chrome (buttons, labels, tabs, the topbar) — everything that says "this is the app".
- **Newsreader** — prose, headlines, editorial moments — everything that says "this is content / reading material".

The tension between mono (computation), sans (chrome), and serif (reading) gives the surface three voices instead of two. Vintage workshop instruments + clean control panel + a leather-bound notebook on the side.

### 3. Real light themes — two new

The existing six themes are all dark. Two new entries proposed:

#### `atelier-light`
A warm, parchment-toned light theme. Direct counterpart to the existing dark "designer/atelier". Targets the prose-and-design-collab crowd. Heavy use of Newsreader, generous whitespace, warm brass accents preserved. The tool-card archetype defaults to `editorial-margin` (no card chrome, just generous gutters). Imagine a designer's notebook page rather than a code editor.

```
--bg-paper:    #f6f0e6;      /* parchment */
--bg-0:        #ede4d4;      /* page edge */
--bg-1:        #f6f0e6;      /* surface */
--bg-2:        #fbf6ec;      /* card */
--rule:        #d8c9af;      /* hairline */
--ink-primary: #2c2520;      /* warm near-black */
--ink-secondary: #6b5c48;    /* warm gray */
--accent:      #8b4513;      /* saddle brown — letterpress */
--brass:       #b8842a;      /* darker brass for light bg contrast */
```

#### `studio-light`
A cool, clean institutional light theme. The "Bauhaus design studio" feel — heavy on hairline rules, big blocky chrome, restrained accent. Targets the daylight worker who wants light mode but not warm/parchment. Tool-card archetype: `hairline-rules` (no card backgrounds, just thin separators).

```
--bg-paper:    #fafafa;
--bg-0:        #f0f0f0;
--bg-1:        #ffffff;
--bg-2:        #f6f6f6;
--rule:        #d4d4d4;
--ink-primary: #0e0e0e;
--ink-secondary: #595959;
--accent:      #0066cc;
--brass:       #aa6e1a;
```

Both light themes opt out of the page-grain SVG noise (or use a much subtler grain) and the CRT scanline overlay — both are distractingly visible on light surfaces.

### 4. Spatial system completion + density modes

**Current scale:** 4, 8, 12, 16, 24, 32. Six steps, irregular jumps.

**Proposed scale:** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96. Eleven steps, predictable progressions. Add `--space-0: 2px` and `--space-px: 1px` for hairline cases.

Plus: Density modifier scales the *whole* spatial system (`--density: 0.875 | 1 | 1.125`) — same control point as the type scale, so density is a single user setting that scales both vertical rhythm and font sizes. Three named modes:

- **Compact** — `--density: 0.875` — the v0.6.16 feel, dense IDE pro mode.
- **Standard** — `--density: 1` — current default.
- **Comfortable** — `--density: 1.125` — for design collab, larger displays, reduced eye strain.

Surfaces it as `Settings > Appearance > Density`.

### 5. Motion language

**Current:** Three keyframes (`paletteIn`, `slideInRight`, `pulse`) and ad-hoc transitions sprinkled across components. Standard easing is browser default (`ease`).

**Proposed:** Five timing tokens + four easing tokens + four named choreographies.

```css
/* Timing — for "how fast" */
--motion-instant:  60ms;     /* hover, color change */
--motion-fast:    160ms;     /* button press, chip swap */
--motion-base:    260ms;     /* panel slide, modal */
--motion-slow:    420ms;     /* page transition, theme switch */
--motion-cinema:  720ms;     /* hero animation, onboarding */

/* Easing — for "how it feels" */
--ease-out-soft:   cubic-bezier(0.22, 1, 0.36, 1);    /* default; smooth deceleration */
--ease-in-out:     cubic-bezier(0.65, 0, 0.35, 1);    /* symmetric */
--ease-spring:     cubic-bezier(0.34, 1.56, 0.64, 1); /* slight overshoot, "kachunk" */
--ease-anticipate: cubic-bezier(0.68, -0.55, 0.27, 1.55); /* full bounce */
```

Four key choreographies the system commits to:

1. **Composer focus glow** — when the input is focused, a brass-tinted highlight slides up the left margin of the composer over `--motion-base` with `--ease-out-soft`. Subtle, not disco.
2. **Tool-call complete pulse** — when a tool finishes, the card edge gets a 1-frame brightness pulse on the family color, then fades over `--motion-slow`. Eyes catch the completion without the tool jumping.
3. **Theme switch crossfade** — `--motion-slow` opacity blend on the entire app. Currently swaps instantly, which is jarring.
4. **Session switch shared element** — the session avatar chip in the sidebar morphs into the masthead avatar over `--motion-base` with `--ease-spring`. (Requires View Transitions API where supported, falls back to crossfade.)

These four are *the moments* — not micro-everything. Restraint matters; one well-orchestrated transition per major state change beats sixty hover wobbles.

### 6. Surface materials (theme-pickable)

Today themes pick colors. Add a *material* layer they can also pick:

```css
--material-paper:  url("data:image/svg+xml;...");    /* SVG noise grain */
--material-glass:  rgba(15,20,28,0.72) backdrop-filter blur(14px);
--material-velvet: linear-gradient(140deg, var(--bg-1) 0%, var(--bg-paper) 100%);
--material-metal:  /* subtle horizontal striations + shadow */
--material-flat:   solid;   /* current default */
```

Themes pick their material per surface:
- `--surface-page` (the conversation backdrop)
- `--surface-card` (tool cards, modals)
- `--surface-chrome` (topbar, status bar)

This is what makes a theme *feel* different beyond color. The "tron" theme already does this (cyan rail) — but it's hand-coded, not tokenized. Codify it.

### 7. Border radius scale + softness

**Current:** Almost everything is 3px. `--radius-pill: 10px` is the only departure.

**Proposed:** Define a softness axis with five steps and use it consistently.

```css
--radius-none:    0;
--radius-xs:      2px;       /* tags, chips */
--radius-sm:      4px;        /* buttons, inputs */
--radius:         6px;        /* cards, panels */
--radius-lg:     10px;        /* modals, hero cards */
--radius-pill: 9999px;        /* round pill */
```

Themes can shift the whole system softer/sharper:
- "hacker" / "tron" → `--radius-multiplier: 0` (everything is sharp-cornered, CRT feel)
- "designer" / "atelier-light" → `--radius-multiplier: 1` (default soft)
- A future "playful" theme → `--radius-multiplier: 1.5` (everything noticeably rounded)

### 8. Token usage hygiene

**Current state:** 663 hard-coded pixel values across components. 200 hard-coded `font-size: Xpx`. 463 hard-coded `padding: Xpx`/`margin: Xpx`.

**Proposed:** A linting + sweep effort.

- Add a stylelint rule: warn on `font-size: Xpx`, `padding: Xpx ...` outside the token files. Tokens are the source of truth.
- One-time migration sweep: convert hard-coded values to nearest token. Where the value doesn't fit, either add a new token or accept the value as legitimate one-off (rare).
- Track via a `docs/design/token-coverage.md` report generated weekly.

This is unglamorous but pays compounding dividends — when the type scale changes, every component changes with it instead of needing 200 manual edits.

### 9. Empty states + welcome ceremony

The CLAUDE.md mentions a "workshop-atelier hero for the 0→1 moment" added in PR #268. Look at this with fresh eyes. The empty state is a brand moment — it's the first thing every new user sees, and (per UX research) the place where users decide "is this for me?".

**Proposed:** Three empty-state archetypes the themes pick from:

- **Workshop bench** (current dark themes) — keep, polish. Add a slow rotating mechanical-blueprint motif behind the call-to-action. Brass accents on hover.
- **Letterpress page** (atelier-light) — Newsreader display + a hand-drawn brass-ink illustration. The empty state reads like a journal page invitation. Italic flourishes on the kicker text.
- **Studio sheet** (studio-light) — Bauhaus geometric primitives, bold uncluttered type, plenty of negative space.

All three open with a coordinated 800ms entrance: kicker fades in, headline strokes in (using `clip-path` reveal), CTA scales in with `--ease-spring`. *One* delightful moment per new session.

### 10. Status bar reimagining

The status bar is prime real estate but currently a flat row of metadata. Treat it as the **dashboard rail** of the app:

- Left third: live activity heartbeat (current agent state with a soft phosphor pulse — green when ready, brass when active, red on error). Animated SVG, low-key.
- Center: cwd · branch · git dirty/clean indicator. Mono. Truncates middle, never end.
- Right third: cost meter as a *real meter* (small horizontal bar showing remaining budget) + theme switcher microbutton + density toggle.

This makes the status bar feel like an instrument cluster, not an afterthought.

---

## Component-level callouts

### Agent timeline (`AgentSessionView.css`, 2079 lines)

This is the centerpiece of the product. A few targeted ideas:

- **User messages:** instead of "soft accent-tinted card", consider a *flush-left margin bar in brass* with the body text indented and set in Newsreader. Looks like a quoted passage in a manuscript. Conveys "the user is interjecting" without a card.
- **Tool cards:** the `editorial-margin` archetype is the move. Hairline-only separators, generous left/right padding, family-color (file/exec/search/web/error) only as a tiny dot before the verb (`◆ Read`, `● Run`, `▲ Search`). No card backgrounds at all in the editorial flow.
- **Thinking blocks:** italicize them in Newsreader at lower contrast. Currently they're treated as code; they're more "narrator's aside".
- **Diff cards:** keep mono (this is computational). But add tasteful side-bar context: filename in display sans above, line range as a chip, then the diff itself.

### Composer

- The "smart box" inner card is well-built. Polish: replace the current top resize handle (1px dashed) with a *brass* hairline that becomes a brass glow on focus.
- Send button: currently functional. Make it more crafted — a brass-stroked icon button that fills with brass on hover, with an `--ease-spring` press animation.
- Keyboard shortcut hint: "⌘ Enter" set in Newsreader italic kicker style, low contrast, right-aligned. Currently mono — fine, but Newsreader gives it warmth.

### Settings

A natural home for the new `density` and `theme + light theme` settings. Reorganize as:

- **Appearance** (theme picker grid with 8 thumbnails — 6 dark + 2 light — like the macOS Settings appearance pane)
- **Typography** (density slider, font scale slider, optional dyslexia-friendly switch that swaps Inter Tight for Atkinson Hyperlegible if loaded)
- **Motion** (slider for motion intensity: off / subtle / standard / cinema)

Settings should *demonstrate* the change live in a small preview pane above the controls. "Tweak and see" beats "tweak and apply".

---

## What to do first

Recommended landing order (each step is independently shippable):

1. **Add new type tokens alongside legacy.** No component changes yet. Available for new code. (1 day)
2. **Build the prototype** — `docs/design/preview/index.html` (companion to this doc) — for stakeholder review. (Done; see prototype.)
3. **Push Newsreader into agent prose.** This is the single highest-leverage visible change. Two-component edit: `TextBlock.tsx` + `AgentSessionView.css` prose section. Big perceived quality jump for tiny implementation cost. (~½ day)
4. **Ship one new light theme** — `atelier-light` is the bigger market reach. (1 day)
5. **Density modes** — settings + density token. (1 day)
6. **Motion tokens + four key choreographies.** (1 day)
7. **Surface materials.** (1 day)
8. **Token usage sweep** (ongoing, behind a stylelint rule).

Total to a fully-realized v1.2 visual system: ~6-8 focused days, none of them in a critical path. All additive. No user-disrupting churn.

---

## Companion artifacts

- `docs/design/preview/index.html` — interactive prototype demonstrating type scale, density, motion, atelier-light theme, editorial-typography agent timeline. Open in any browser.
- `docs/design/preview/tokens-v2.css` — the proposed token file as it would land.

---

## Closing note

The system has good bones. None of this proposal asks you to throw anything away. The biggest wins — Newsreader-for-prose and the type scale overhaul — are *additive*, behind feature flags or new token names, and can land in a single afternoon each.

The one thing I'd push back on if I had to pick a fight: ship a real light theme. Hermes-as-IDE is dark-only by default; Hermes-as-craftspace is dark *and* light, and the audience for the latter is much larger than the former. Don't let "I prefer dark" be the reason a designer-collaboration tool can't be used in daylight.
