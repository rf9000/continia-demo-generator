# Demo Spec Authoring Guide

How to write YAML demo specs that the demo-generator can actually record as watchable videos.

## How the Player Works

The player uses **Playwright** to control a real Chromium browser. It:

1. Opens BC at a specific page URL (via `start.pageId`)
2. Authenticates with username/password
3. Waits for BC to fully load
4. Executes each step as a **real Playwright click** (visible in the browser, captured by video)
5. Waits 2 seconds between steps so the video shows each state
6. Waits 3 seconds after the last step to capture the final result

This means every step must correspond to a **single, visible UI interaction** — one click, one input. The player finds elements by their visible text on the page.

## File Structure

```yaml
# bc-replay recording
description: <one-line description of what this demo shows>
name: <display name>
start:
  profile: BUSINESS MANAGER
  page: <BC page name>       # informational — not used for navigation
  pageId: <numeric page ID>  # REQUIRED — used to navigate directly via URL
steps:
  - <step 1>
  - <step 2>
  - ...

# Demo metadata
demo:
  schemaVersion: 1
  feature: <feature name>
  targetPage:
    id: <page ID where video will be shown in-product>
    name: <page name>
  app: <app directory name>
  narration: |
    <overall narration text for TTS>
  stepNarration:
    0: <narration for step 0>
    1: <narration for step 1>
  tags: [...]
  audience: new-users
  locale: da-DK
  prerequisites:
    - <data/setup required before recording>
```

## The `start` Section

### `start.pageId` — REQUIRED

The numeric BC page ID. The player navigates directly to `<bc-url>/?page=<pageId>`. Without this, the browser stays on the Role Center and nothing works.

```yaml
start:
  pageId: 388   # Bank Acc. Reconciliation List
```

**How to find page IDs:**
- In BC: navigate to the page, press Ctrl+Alt+F1 (page inspection), look for "Page ID"
- In AL source: check page objects for their ID number
- Common pages: Customer List (22), Vendor List (27), Item List (31)

### `start.page` — Informational Only

The page name as a human-readable label. The player does NOT use this for navigation — it's for documentation and for the product-repo skill to track which page the recording starts on.

### `start.profile` — Optional

The BC role center profile. Appended to the URL as `?profile=BUSINESS+MANAGER`. Usually `BUSINESS MANAGER` for most demos.

## Step Types

### Action: Click a Button

For clicking toolbar buttons, menu items, and actions visible on the current page.

```yaml
- type: action
  target:
    - page: Bank Acc. Reconciliation
  caption: Post
  description: Post the reconciliation
```

**Critical: `caption` must match the EXACT visible text on the button.** The player searches for the text using these strategies in order:
1. Button/menuitem/link with exact accessible name match
2. Button/menuitem/link with partial name match
3. Any element containing the text
4. Elements in the top navigation bar

**To find the right caption:** Open BC in a browser, navigate to the page, and note the exact button text. On DemoPortal environments, buttons typically render in English even when the locale is Danish.

### Action: Click a Row in a List

For opening a record from a list page. Do NOT use `caption: Edit` — BC list pages don't always show an Edit button. Instead, use `row`:

```yaml
# By position (1-indexed)
- type: action
  target:
    - page: Bank Acc. Reconciliation List
  row: 1
  description: Open the first reconciliation

# By text match (preferred when the row content is known)
- type: action
  target:
    - page: General Journal Batches
  row: "PMT JNL"
  description: Select the PMT JNL batch
```

`row: 1` clicks the first data row (1-indexed). `row: "PMT JNL"` scans all rows and clicks the first one containing that text in any cell. **Prefer text matching** when the target row has a known name — it's resilient to data ordering changes.

### Action: Open a Dropdown Menu, Then Click a Sub-Action

If an action lives inside a dropdown/submenu, you need **two separate steps**: one to open the menu, one to click the item inside it.

```yaml
# Step 1: Open the menu
- type: action
  target:
    - page: Bank Acc. Reconciliation
  caption: Page
  description: Open the Page menu

# Step 2: Click the action inside the menu
- type: action
  target:
    - page: Bank Acc. Reconciliation
  caption: Show More Columns
  description: Click Show More Columns to reveal additional fields
```

**Common parent menus in BC:** `Page`, `Process`, `Report`, `Navigate`, `More options`

To discover the menu structure: open the page in BC, look at the action bar, and note which actions are top-level vs inside dropdown menus.

### Action: Click Assist Edit on a Field

For clicking the "..." (assist edit) button on a field to open a lookup/modal dialog. This is common for fields like "Batch Name", "Bank Account No.", etc. that open a selection page when the dots are clicked.

```yaml
- type: action
  target:
    - page: Payment Journal
  caption: Batch Name
  assistEdit: true
  description: Click assist edit on Batch Name to open batch selection
```

**`caption`** is the field label (not a button caption). The player will:
1. Locate the field by its caption label
2. Click the field value to give it focus (reveals the "..." button)
3. Click the assist-edit "..." button

**When to use this vs `type: input`:** Use `assistEdit` when the goal is to open a lookup/selection dialog. Use `type: input` when the goal is to type a value directly into the field.

### Input: Fill a Field

For entering values into fields. Uses BC's internal API (field location in BC's DOM is complex).

```yaml
- type: input
  target:
    - page: Bank Connection Card
    - field: Bank Name
  value: Danske Bank
  description: Enter the bank name
```

**`field`** must match BC's internal field caption (English). **`value`** is what gets typed.

## Things That Do NOT Work

### Search/Tell Me Navigation

Do NOT use the Search overlay pattern. BC's search is a floating popup that doesn't register as a page — the player cannot interact with it reliably.

```yaml
# DON'T DO THIS
- type: action
  target:
    - page: Role Center
  caption: Search
```

**Instead:** Use `start.pageId` to navigate directly to the target page.

### `caption: Edit` on List Pages

BC list pages don't always show an "Edit" button. The standard way to open a record is to click the row.

```yaml
# DON'T DO THIS
- type: action
  target:
    - page: Some List
  caption: Edit

# DO THIS
- type: action
  target:
    - page: Some List
  row: 1
```

### Assuming Button Captions Match the Locale

Even when `demo.locale` is `da-DK`, DemoPortal environments often render button captions in **English**. Always verify the actual visible text on the environment you're recording against.

## Step Narration Indexing

`demo.stepNarration` maps step indices to narration text. **Indices are 0-based and count every step** — including menu-opening steps.

If your steps are:
```yaml
steps:
  - row: 1                    # index 0
  - caption: Page             # index 1
  - caption: Show More Columns # index 2
```

Then narration should be:
```yaml
stepNarration:
  0: Open an existing bank account reconciliation from the list.
  1: Open the Page menu in the action bar.
  2: Click Show More Columns to reveal additional fields on the statement lines.
```

## Prerequisites Section

List the **data and setup** that must exist in the BC environment before the recording can succeed. The player does not create test data — it expects it to be there.

Be specific:
```yaml
prerequisites:
  - Continia Banking app is installed and licensed
  - At least one bank account reconciliation exists with status "Open"
  - The reconciliation has imported bank statement lines
```

## Complete Example

```yaml
# bc-replay recording
description: How to show additional columns on the Bank Account Reconciliation page
name: Show More Columns on Bank Acc. Reconciliation
start:
  profile: BUSINESS MANAGER
  page: Bank Acc. Reconciliation List
  pageId: 388
steps:
  - type: action
    target:
      - page: Bank Acc. Reconciliation List
    row: 1
    description: Open the first reconciliation

  - type: action
    target:
      - page: Bank Acc. Reconciliation
    caption: Page
    description: Open the Page menu

  - type: action
    target:
      - page: Bank Acc. Reconciliation
    caption: Show More Columns
    description: Click Show More Columns to reveal additional fields

# Demo metadata
demo:
  schemaVersion: 1
  feature: Show More Columns
  targetPage:
    id: 379
    name: Bank Acc. Reconciliation
  app: import
  narration: |
    In this video, we'll show you how to display additional columns on the
    Bank Account Reconciliation page. By clicking Show More Columns, you can
    see fields such as Account Type, Account No., and more.
  stepNarration:
    0: Open an existing bank account reconciliation from the list.
    1: Open the Page menu in the action bar.
    2: Click Show More Columns to reveal the additional fields on the statement lines.
  tags: [import, reconciliation, columns, ui]
  audience: new-users
  locale: da-DK
  prerequisites:
    - Continia Banking app is installed and licensed
    - At least one bank account reconciliation exists with imported bank statement lines
```

## Checklist Before Submitting a Spec

- [ ] `start.pageId` is set to the correct numeric page ID
- [ ] All `caption` values match the **exact visible button text** on the target environment
- [ ] Assist-edit steps use `assistEdit: true` with the **field label** as caption
- [ ] Actions inside dropdown menus have **two steps** (open menu + click item)
- [ ] List row navigation uses `row: N`, not `caption: Edit`
- [ ] `stepNarration` indices match the actual step positions (0-based, counting every step)
- [ ] `prerequisites` lists all data that must exist in the environment
- [ ] You've manually verified the flow works by clicking through it in a browser
