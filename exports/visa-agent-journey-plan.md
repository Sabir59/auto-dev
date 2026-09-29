# Visa AI Agent — Journey Plan

## What the samples got right
Tone and copy voice are exactly right for the concept ("I'll extract everything
automatically," "You're confirming what I've prepared — not filling it out
yourself"). Good individual patterns worth keeping: document-row-with-status,
AI chat bubble + quick-reply chips, conflict-detection card (Fix this / Keep
as is), review summary table, editable-details accordion, applications hub
with status pills.

## What was wrong, ambiguous, or missing
1. No clear discovery→chat handoff — Home's input and the Chat screen don't
   visibly connect.
2. Two competing "what does the AI need" surfaces (flat Documents checklist
   vs. chat) with no stated relationship between them.
3. **Contradiction**: the "ready" screen claims "Your application is ready"
   while simultaneously listing 2 unresolved attention items. Fixed by never
   allowing both messages on screen at once — attention items OR ready, not both.
4. **Biggest gap**: no agent-execution state exists at all — nothing shows the
   AI actually operating the visa website, no OTP/CAPTCHA handoff, no
   submitted/receipt state. This is the core of the product concept and was
   entirely missing.
5. Ambiguous consequential action: "Confirm & continue" on the true submit
   step. Renamed to "Confirm & Submit Application."
6. Duplicated Review screen (two near-identical copies).
7. Bottom-nav active-tab highlighting was inconsistent/wrong across samples
   for screens in the same flow.
8. Progress dots present but uncounted/inconsistent — replaced with a named
   stage label (no fixed dot-count wizard, since the AI's questioning is
   progressive, not a fixed N steps).
9. "18 AI credits today" — unrelated monetization/gamification signal, dropped
   as out-of-scope noise.

## Final journey (screens/states actually built)
Home (empty / active-app) → AI Chat (clarify) → Documents (checklist) →
Validate (conflict found / resolved) → Summary (attention / ready) →
Review & Confirm → **Submitting (agent working)** → **Human action needed
(OTP/CAPTCHA)** → **Submitted (receipt)** · with **Applications Hub** (list +
empty state) and **Details/Edit** (accordion override) reachable throughout,
plus a minimal **Error** state and a minimal **Profile** stub (deliberately
undeveloped — not part of the core concept).

## Components
Button (primary/secondary/ghost/destructive), StatusPill, DocumentRow,
RequirementAlert (warning/success), ChatBubble (AI/user), QuickReplyChip,
SummaryRow, BottomNav (fixed 3-tab: Home/Applications/Profile, correct active
state per screen), AppCard (for the hub list), ProgressStage (named stage
label, not dots).

## Palette (sampled from the reference images / prior verified extraction —
theme transfer intentionally out of scope, internal consistency only)
bg #F7F6F3 · ink #18181A · muted #78776F · primary #3D4EE8 ·
warning-bg #FEF3C7 · warning-border #EAC488 · amber-text #D9790E ·
destructive-action #D97706 · success-bg #DCFCE7 · success-text #166534 ·
white #FFFFFF · speak-btn-bg #EEEDE9
