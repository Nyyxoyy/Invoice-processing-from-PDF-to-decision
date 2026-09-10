# Bicycle Design System

Design system for **Bicycle** — an agentic BI / conversational analytics product. The brand is built around an AI search bar that drills into revenue, data, connections and models in natural language, paired with data-heavy dashboards and tables.

The source of truth is the Figma file **Design System.fig**, mounted as a virtual filesystem at `/` (pages like `/Colors`, `/Typography`, `/Object-and-Spacings`, `/Icons`, `/Buttons`, `/AI-Chat`, `/Sidebar`, `/Table`, …).

The uploaded `bicycle logo_reverse.svg` provided the reversed wordmark (see `assets/bicycle-logo-reverse.svg`; a dark variant is in `assets/bicycle-logo.svg`).

---

## Index

| Path | What's there |
|---|---|
| `colors_and_type.css` | All color tokens, type scale, spacing, radius, shadow. |
| `styles.css` | Global entry — imports `colors_and_type.css`. **Link this first.** |
| `components/` | Exported components (see index below). |
| `thumbnail.html` | Homepage tile for the design system. |
| `assets/` | Logo (light + reverse), sample imagery placeholders. |
| `fonts/` | **Outfit** brand font files (9 weights, TTF). Loaded via `@font-face` in `colors_and_type.css`. |
| `preview/` | Small HTML cards for the Design System tab. |
| `ui_kits/bicycle-app/` | Hi-fi recreation of the Bicycle app (left rail + top nav, AI search bar, table, dashboard). |
| `CLAUDE.md` | Project rules — **every prototype must include both the left nav and top nav.** |
| `SKILL.md` | Agent Skill entrypoint. |

---

## Components

Each component lives in `components/<Name>/` with a `.jsx`, a `.d.ts`, and an `@dsCard` preview. Read them off the bundle:

```html
<script src="_ds_bundle.js"></script>
<script>const { Button, TopNav } = window.BicycleProductDesignSystem_2f8c56;</script>
```

**App chrome** — required on every screen (see `CLAUDE.md`):

- **`Sidebar`** — 72px left icon rail; feature items on top, Profile/Help pinned bottom. Also exports `SIDEBAR_ITEMS`, `SIDEBAR_FOOTER_ITEMS`.
- **`TopNav`** — agent switcher, optional page label, persona chip (expanded or compact), workspace chip, assistant avatar.

**Components:**

- **`Button`** — primary / secondary / text / danger, `sm` + `md`. Medium-weight labels, `fa-regular` icons, filled surfaces (no outline strokes).
- **`Badge`** — status pill in 6 tones.
- **`Toast`** — success / warning / danger / info; leading icon aligns to the heading row.
- **`DataTable`** — dark table, tabular numerals, `delta` / `currency` / `muted` cell kinds, row hover.
- **`ConnectionCard`** — data-source tile with status badge and row count.
- **`AISearchBar`** — the signature prompt composer: attach / annotate on the left, mode dropdown + voice + send on the right.
- **`ModeMenu`** — Fast / Balanced / Deep reasoning picker. Also exports `MODES`.

---

## Content fundamentals

**Voice.** Matter-of-fact, analyst-forward, lightly technical. The product talks in the second person ("your revenue", "drill down"), but UI copy frequently drops the subject entirely — imperative verbs ("Ask anything", "Run query", "Attach files", "Annotate"). No marketing exuberance — closer to the tone of a SQL console or a notebook.

**Casing.** Sentence case everywhere — body, button labels, menu items, table headers. Title Case only for proper nouns and the product name "Bicycle". Never ALL CAPS (no micro‑caps labels).

**Punctuation.** Terse. No trailing periods on buttons, labels, menu items, chip text, or single-sentence helper copy. Ellipses only where a real pause is implied (`Searching…`). Use en‑dash for numeric ranges.

**Numbers.** Tabular figures (`font-variant-numeric: tabular-nums`) everywhere data appears — tables, metrics, inline KPIs. Abbreviate with `k / m / b` lowercase. Currency symbols hug the number (`$1.2m`), no space.

**Naming of AI modes.** The system names reasoning effort as `Fast`, `Balanced`, `Deep` — descriptive adjectives, not marketing names. Sub‑copy describes the *behavior* ("Quick & direct", "Smart, well‑reasoned", "Thorough, multi‑step reasoning").

**Example copy** pulled from the Figma:

- Prompt placeholder: *"Drill down revenue trends by city and carrier for the last 4 days"*
- Mode labels: `Fast` / `Balanced` / `Deep`
- Mode actions: `Attach files`, `Annotate`, `Prompts`, `Dictate`, `Submit`
- Radius doc: *"Radius should scale with component prominence — the more important or interactive the element, the softer the curvature."*
- Icon doc: *"Always check Font Awesome first before introducing a custom icon."*

**Emoji.** Not used. Status and semantic color (plus Font Awesome glyphs) carry the signal.

**Vibe.** Serious analyst tool with a warm brand accent. Dark by default; data is the main subject of every screen.

---

## Visual foundations

### Brand palette
- **Brand green `#00C19F`** — the "bb" mark, reserved for the logo and high-emphasis accents (AI mode pips, positive deltas on data viz, primary status).
- **Primary blue `#1463B8`** — primary buttons, links, selected states. Its lighter variants (`#0083C1` hover, `#39ACFF` focus ring) do all the focus/hover lifting.
- **Neutrals** run an 8-step dark scale from canvas `#15202B` → surfaces `#212B36` / `#2F3842` → borders `#3B444D`/`#4A505C` → text `#B7BCC9`/`#F4F4F4`. There is no separate "light" palette; the system was designed dark-first.
- **Semantic** red (`#DB1C02` / `#FF4F36`), yellow (`#E6A516`), green (`#3BB443`). A broader support set — violet, magenta, pink, purple, emerald, orange‑brown — is reserved for data categoricals.

### Typography
**Outfit** is the single UI font, loaded locally from `fonts/` in all 9 weights (Thin 100 → Black 900). Workhorse weights are 400 / 500 / 600 / 700. A Menlo-class mono (we ship `JetBrains Mono` as the closest Google Fonts match — **flag:** original Menlo is Apple-system only).system‑only) for code/SQL. Metrics and tables use tabular numerals.

Scale: 10 / 12 / 14 / 16 / 18 / 20 / 32. The workhorse body is **14/20**; captions **12/16**; UI titles **16/22 @500**; headings **18/28 @500**. Very tight letter-spacing (`-0.01em`) on headings.

### Spacing & layout
Radii: **4 / 8 / 12 / 16 / 24** (s / default / large / xl / xxl). Buttons and inputs default to `8` (`large` used on prominent containers, `24` on hero surfaces). Spacing tokens echo the same scale (4 / 8 / 12 / 16 / 24). Borders are crisp: default `1px`, emphasis `1.5px`, focus/error `2px`.

Layouts are rectilinear and dense — tables, sidebars, composers. No hand-drawn illustrations, no textures, no repeating patterns. Backgrounds are flat dark surfaces, sometimes with a subtle violet-tinted documentation frame (`rgba(138,56,245,0.2)` in Figma annotations only — not a product color).

### Motion
Fast, utilitarian. 120–200ms ease-out on hover, 160ms ease on menu/dropdown open, no bounces, no stagger, no parallax. Focus rings fade in on keyboard nav, not on click.

### States
- **Hover**: surface lightens one step (`700 → 600`); primary blue shifts to `#0083C1`.
- **Active/pressed**: no scale transform — the color deepens a step instead.
- **Focus**: 2px `#39ACFF` ring (blue-300), no glow.
- **Selected**: full primary fill; for menu rows, a 4px accent bar + muted fill.
- **Disabled**: 40% opacity on fg, no bg change.

### Cards & elevation
Cards are `bg-raised` (`#212B36`) on canvas, `1px` border `--border`, radius `8–12`, and `--shadow-card` (a single‑step `0 1px 2px rgba(0,0,0,.25)`). Modals and menus add `--shadow-menu` (`0 2px 12px rgba(0,0,0,.30)`). No inner shadows, no gradient borders, no glassmorphism.

### Transparency / blur
Used sparingly. Table header fill is `rgba(108,132,157,0.12)` — a translucent neutral. Protection gradients / capsules are not part of the system. No backdrop-blur.

### Imagery
Product visuals are data (tables, charts, graph nodes), not photography. When illustrations are needed (empty states) they should be line-based monochrome glyphs, not painterly illustrations. Any photography should be cool/blue-toned, high contrast, used full-bleed only in marketing contexts.

---

## Iconography

**Primary library: Font Awesome 7 Pro** — used at **regular weight** throughout the Figma. All UI glyphs (chevrons, search, send, attach, annotate, sidebar items, status) are Font Awesome instances. **House rule: icons inside buttons are always `fa-regular`**, never solid. Status-pill dots / state icons may use solid when the glyph is only available in solid (FA6 Free gap).tances.

> ⚠️ **Substitution flagged.** Font Awesome 7 Pro requires a Pro license; the public CDN only ships Font Awesome 6 Free. The UI kits in this repo reference **Font Awesome 6 Free** (solid + regular) as the closest publicly-available substitute — a handful of Pro-only glyphs (like `duotone` styles) may render as a different weight. Swap in the Pro kit URL when available.

CDN used:
```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
```

**Custom SVGs** are the documented second choice. They must match Font Awesome proportions (stroke weight, corner radius) and be stored inline or as component icons. The logo mark is the only custom SVG shipped here.

**Emoji / unicode icons** are not used in UI chrome.

---

## Files not yet added

- Font Awesome **7 Pro** assets (license-gated) — currently substituted with FA6 Free. Please drop a FA7 Pro kit into `fonts/` if you have one.
- `Menlo` is Apple-system only; replaced with `JetBrains Mono`. Flag for review.
