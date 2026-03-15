# Guide for the Demo Spec Generation Skill

This guide is for the Claude Code skill in the Continia Banking product repo that analyzes the AL codebase and generates demo spec YAML files. The demo-generator consumes these files to produce narrated screen recordings.

## How the Demo Generator Works (What the Skill Needs to Know)

The generator uses **Playwright** to control a real Chromium browser. It:

1. Opens BC directly on a specific page (via numeric page ID in the URL)
2. Finds buttons/actions by their **exact visible text** on the page
3. Clicks them with a real browser click (visible in the video with an animated cursor)
4. Waits between steps so narration audio can play
5. Records everything as video, then composes with TTS narration and subtitles

**This means**: every step in the YAML must map to exactly one visible UI interaction. The generator cannot "know" about BC's internal structure — it only sees what's rendered on screen.

## Required Detail Level

### Page IDs: Be Explicit and Numeric

The generator navigates by appending `?page=<id>` to the BC URL. Page names are ignored for navigation.

```yaml
# CORRECT — generator can navigate here
start:
  pageId: 388            # numeric ID, used for URL navigation
  page: Bank Acc. Reconciliation List   # informational only

# WRONG — generator cannot navigate
start:
  page: Bank Acc. Reconciliation List   # ignored, browser stays on Role Center
```

**The skill must resolve page IDs from the AL source.** Look for `page <id> "<name>"` declarations. For standard BC pages referenced by name (like `Page::"Bank Acc. Reconciliation List"`), the skill needs to know or look up the standard page ID.

### Button Captions: Exact Visible Text

The generator finds elements by the text the user sees on screen. The caption must match **exactly**.

```yaml
# CORRECT — matches what's visible on the page
caption: Post
caption: Change Statement No...
caption: Show More Columns
caption: Page

# WRONG — these don't exist as visible text
caption: PostReconciliation    # internal AL action name
caption: ChangeStatementNo     # code identifier
caption: ShowMoreColumns       # camelCase won't match
```

**How the skill should determine captions:**
1. Look at the AL action's `Caption` property — that's what BC displays
2. If the action has `CaptionML`, use the English (`ENU`) value
3. If the caption includes `%1` or other placeholders, use the static part only
4. Include ellipsis if the caption has it: `Change Statement No...` not `Change Statement No`

### Menu Hierarchy: Every Click is a Separate Step

In BC, actions can be nested inside action groups (Promoted, Page, Process, etc.). If an action is inside a group, the user must first click the group tab, then the action. **Each click = one step.**

```yaml
# CORRECT — two steps for a nested action
# The "Show More Columns" action lives under the "Page" action bar tab
- type: action
  caption: Page
  description: Open the Page action bar
- type: action
  caption: Show More Columns
  description: Click Show More Columns

# WRONG — one step for a nested action (generator can't find it)
- type: action
  caption: Show More Columns    # not visible until "Page" tab is clicked first
```

**How the skill should determine the menu path:**

Look at where the action is defined in the AL page:

```al
actions
{
    area(Processing)        // → visible as top-level tab "Process" or "Home"
    {
        action(PostAction)
        {
            Caption = 'Post';   // → directly clickable, one step
        }
    }
    area(Navigation)        // → visible as top-level tab "Navigate" or "Page"
    {
        group(ShowGroup)
        {
            Caption = 'Show';
            action(ShowMoreColumns)
            {
                Caption = 'Show More Columns';   // → needs: Page → Show More Columns
            }
        }
    }
}
```

**Area-to-tab mapping in BC's action bar:**
| AL `area()` | BC visible tab name |
|---|---|
| `area(Processing)` | Usually under "Home" or "Process" |
| `area(Navigation)` | Usually under "Page" or "Navigate" |
| `area(Reporting)` | Usually under "Report" |
| `area(Creation)` | Usually under "New" |
| `area(Promoted)` | Directly visible in the action bar (no tab click needed) |

If the action is in `area(Promoted)`, it's directly clickable — one step. Otherwise, the skill must generate a step to click the tab first.

**Nested groups add more clicks:**
```al
area(Navigation)           // → click "Page"
{
    group(ShowGroup)       // → if this renders as a submenu, click "Show"
    {
        action(MyAction)   // → click "My Action"
    }
}
```

Not all groups render as submenus — some are just visual grouping. **When unsure, generate the full path and note in the description that it may need adjustment.** The generator will retry by re-opening parent menus if a caption isn't found.

### Opening Records from a List: Use `row`, Not `caption: Edit`

BC list pages don't have an "Edit" button. Users click the primary key field (leftmost link) to open the record.

```yaml
# CORRECT — clicks the first record's primary key link
- type: action
  target:
    - page: Bank Acc. Reconciliation List
  row: 1
  description: Open the first reconciliation

# WRONG — "Edit" doesn't exist on BC list pages
- type: action
  caption: Edit
  description: Open a reconciliation
```

### Input Fields: Use the Field Caption

```yaml
- type: input
  target:
    - page: Bank Connection Card
    - field: Bank Name          # field caption from AL
  value: Danske Bank            # value to type
  description: Enter the bank name
```

The `field` value should be the field's `Caption` property from AL, not the field name or variable name.

## Narration Text: How Detailed

### `demo.narration` (Overall)

Not used when `stepNarration` is present. Keep it as a fallback/summary.

### `demo.stepNarration` (Per-Step) — This is What Matters

Each entry is spoken by the TTS voice while the corresponding step's result is visible on screen. The audio duration **controls the video pacing** — longer narration = longer pause on that step.

**Guidelines:**
- **UI-only steps (menu clicks, tab switches)**: Keep brief — 1 sentence. The viewer just needs to know what's happening.
- **Feature steps (the actual action)**: Be detailed — explain what it does and what the user will see. This is the teaching moment.
- **Row clicks (opening a record)**: Brief context about what we're opening.

**Example — good pacing:**
```yaml
stepNarration:
  0: First, open an existing bank account reconciliation from the list.
  1: Open the Page action bar to access page-level actions.
  2: >-
    Click Show More Columns to reveal additional fields on the statement
    lines, such as Account Type, Account Number, End To End I.D., Payment
    Batch I.D., and more. These extra columns give you a detailed view of
    each bank statement line during reconciliation.
```

Step 0 (row click): ~4 seconds of narration → 4.5s video delay
Step 1 (menu click): ~3 seconds → 3.5s delay
Step 2 (feature): ~16 seconds → 16.5s delay — the viewer has time to see the columns appear

**Abbreviation handling**: The generator automatically expands common BC abbreviations before sending to TTS:
- `No.` → "Number"
- `Acc.` → "Account"
- `Id` → "I.D."
- `Pmt.` → "Payment"
- `Jnl.` → "Journal"
- etc.

So the skill can write `Account No.` in the narration text — it will be spoken as "Account Number". But for clarity, writing it out is also fine.

**Do NOT include:**
- Markup like `<caption>`, `<value>` — these are for the `description` field, not narration
- Timestamps or "at this point" — the timing is automatic
- "Click on the button labeled..." — just say what the user should do naturally

### `description` field (Per-Step)

This is NOT spoken. It's for logging/debugging. Can include `<caption>` markup.

```yaml
description: Click <caption>Show More Columns</caption> to reveal additional fields
```

## Toggle Actions: State Awareness

Some BC actions toggle between two states (e.g., "Show More Columns" / "Show Fewer Columns"). The generator clicks whatever text is visible. **The skill should note the expected state in prerequisites:**

```yaml
demo:
  prerequisites:
    - The statement lines must be in "fewer columns" mode (default state)
```

If the environment is in the wrong state, the button text won't match and the click will fall back to a less visible method.

## Complete Example for the Skill to Produce

```yaml
# bc-replay recording
description: How to show additional columns on the Bank Account Reconciliation page
name: Show More Columns on Bank Acc. Reconciliation
start:
  profile: BUSINESS MANAGER
  page: Bank Acc. Reconciliation List
  pageId: 388
steps:
  # Step 0: Open a record from the list
  - type: action
    target:
      - page: Bank Acc. Reconciliation List
    row: 1
    description: Open the first reconciliation

  # Step 1: Navigate to the action bar tab
  # "Show More Columns" is in area(Navigation) → needs "Page" tab click
  - type: action
    target:
      - page: Bank Acc. Reconciliation
    caption: Page
    description: Open the Page action bar

  # Step 2: Click the actual feature action
  - type: action
    target:
      - page: Bank Acc. Reconciliation
    caption: Show More Columns
    description: Click <caption>Show More Columns</caption> to reveal additional fields

# Demo metadata
demo:
  schemaVersion: 1
  feature: Show More Columns
  targetPage:
    id: 379
    name: Bank Acc. Reconciliation
  app: import
  narration: |
    In this video, we show you how to display additional columns on the
    Bank Account Reconciliation page.
  stepNarration:
    0: First, open an existing bank account reconciliation from the list.
    1: Open the Page action bar to access page-level actions.
    2: >-
      Click Show More Columns to reveal additional fields on the statement
      lines, such as Account Type, Account No., End To End Id, Payment
      Batch Id, and more. These extra columns give you a detailed view of
      each bank statement line during reconciliation.
  tags: [import, reconciliation, columns, ui]
  audience: new-users
  locale: da-DK
  prerequisites:
    - Continia Banking app is installed and licensed
    - At least one bank account reconciliation exists with imported bank statement lines
    - Statement lines are in default "fewer columns" mode
```

## Checklist for the Skill

Before outputting a spec, verify:

- [ ] `start.pageId` is a resolved numeric page ID (not just a name)
- [ ] Every caption matches the AL `Caption` property exactly (including ellipsis, spacing)
- [ ] Actions inside `area(Navigation)` or `area(Processing)` have a preceding tab-click step
- [ ] Nested groups that render as submenus have their own click step
- [ ] List page navigation uses `row: 1`, not `caption: Edit`
- [ ] `stepNarration` has an entry for every step index (0-based), with brief text for UI steps and detailed text for feature steps
- [ ] Narration text reads naturally when spoken aloud — no code artifacts, no markup
- [ ] `prerequisites` lists all data/state the environment must have
- [ ] Toggle actions note the expected starting state in prerequisites

## What the Skill Does NOT Need to Worry About

- **TTS voice/speed**: Handled by the generator based on `demo.locale`
- **Video timing**: Automatically calculated from narration audio duration
- **Subtitle formatting**: Generated automatically from `stepNarration` text
- **Login/authentication**: Handled by the generator from `.env` config
- **Cursor animation**: Automatic — the generator animates a cursor to each click target
- **BC language/locale**: DemoPortal environments render English captions regardless of locale
