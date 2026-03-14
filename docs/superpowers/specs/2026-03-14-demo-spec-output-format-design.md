# Demo Spec Output Format

## Context

The Continia Banking product repo has a skill that navigates the AL codebase, understands pages, fields, actions, and captions, and produces demo spec files. This demo-generator repo consumes those files to record and post-process demo videos.

This document defines the output format the product-repo skill must produce.

## Design Decision

Single YAML file combining a valid bc-replay recording with demo metadata under a `demo:` key. bc-replay ignores unknown fields, so both coexist cleanly in one file.

## Format

### bc-replay Recording Fields

Standard bc-replay page script fields. The product-repo skill generates these from AL source knowledge.

```yaml
description: How to set up a bank connection in Continia Banking
name: Setup Bank Connection
start:
  profile: BUSINESS MANAGER
timeout: 120
steps:
  - type: action
    target:
      - page: Role Center
    caption: Bank Connections
    description: Open <caption>Bank Connections</caption>
  - type: action
    target:
      - page: Bank Connection List
    caption: New
    description: Select <caption>New</caption>
  - type: input
    target:
      - page: Bank Connection Card
      - field: Bank Name
    value: Danske Bank
    description: Input <value>Danske Bank</value> into <caption>Bank Name</caption>
  - type: action
    target:
      - page: Bank Connection Card
    caption: OK
    description: Close the page
```

#### bc-replay Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | Yes | Human-readable description of the recording |
| `name` | string | No | Display name (shown in test results) |
| `start.profile` | string | No | BC role center profile to start with (only sub-key bc-replay reads from `start`) |
| `timeout` | number | No | Timeout in seconds (default: 120). Only set if recording needs more time |
| `steps` | array | Yes | Ordered array of step objects |
| `test.skip` | string | No | Skip the recording with a reason message |
| `test.fixme` | string | No | Mark as fixme (known issue) with a reason |
| `test.fail` | string | No | Mark as expected-to-fail with a reason |

#### Step Types

**action** — click a button/action:
```yaml
- type: action
  target:
    - page: PageName
  caption: ButtonCaption
  description: Human-readable description
```

**input** — enter a value in a field:
```yaml
- type: input
  target:
    - page: PageName
    - field: FieldCaption
  value: ValueToEnter
  description: Human-readable description
```

**scope** — group steps:
```yaml
- type: scope
  description: Group description
  steps: [...]
```

**include** — include another recording:
```yaml
- type: include
  file: ./relative-path.yml
```

### Demo Metadata Fields

Additional metadata under a `demo:` key, consumed by the demo-generator for post-processing (Phase 2) and in-product delivery (Phase 3).

```yaml
demo:
  schemaVersion: 1
  feature: Bank Connections
  targetPage:
    id: 70146385
    name: Bank Connection List
  app: banking-dk
  narration: |
    In this video, we'll show you how to set up a new bank connection
    in Continia Banking. You'll learn how to navigate to the Bank
    Connections page, create a new connection, and configure the
    basic settings.
  stepNarration:
    0: First, open the Bank Connections page from the Role Center.
    1: Click New to create a new bank connection.
    2: Enter the name of your bank.
    3: Close the card to save your changes.
  tags: [banking, setup, connections]
  audience: new-users
  locale: da-DK
  prerequisites:
    - Continia Banking app is installed and licensed
```

#### Metadata Field Reference

| Field | Type | Required | Phase | Description |
|-------|------|----------|-------|-------------|
| `demo.schemaVersion` | number | Yes | 1 | Format version (current: `1`). Allows the demo-generator to detect and handle format changes |
| `demo.feature` | string | Yes | 1 | Feature name, used for file naming and grouping. File name is the kebab-case form of this value |
| `demo.targetPage.id` | number | Yes | 3 | BC page ID where the demo video will be shown |
| `demo.targetPage.name` | string | Yes | 3 | BC page name (human-readable) |
| `demo.app` | string | Yes | 1 | Source app directory name in the Continia Banking monorepo (e.g., `banking-dk`, `banking-w1`, `Common`) |
| `demo.narration` | string | No | 2 | Overall narration text for TTS (plain text, no markup) |
| `demo.stepNarration` | map<int, string> | No | 2 | Per-step narration keyed by flat step index (plain text). Indices count only top-level steps; `scope` contents are not individually indexed |
| `demo.tags` | string[] | No | 3 | Categorization tags |
| `demo.audience` | string | No | 3 | Target audience (e.g., `new-users`, `admins`) |
| `demo.locale` | string | No | 2 | Locale for sample data language and TTS voice |
| `demo.prerequisites` | string[] | No | 4 | Data or setup required before the recording can succeed (e.g., "A bank account must exist") |

## Complete Example

```yaml
# bc-replay recording
description: How to set up a bank connection in Continia Banking
name: Setup Bank Connection
start:
  profile: BUSINESS MANAGER
timeout: 120
steps:
  - type: action
    target:
      - page: Role Center
    caption: Bank Connections
    description: Open <caption>Bank Connections</caption>
  - type: action
    target:
      - page: Bank Connection List
    caption: New
    description: Select <caption>New</caption>
  - type: input
    target:
      - page: Bank Connection Card
      - field: Bank Name
    value: Danske Bank
    description: Input <value>Danske Bank</value> into <caption>Bank Name</caption>
  - type: action
    target:
      - page: Bank Connection Card
    caption: OK
    description: Close the page

# Demo metadata
demo:
  schemaVersion: 1
  feature: Bank Connections
  targetPage:
    id: 70146385
    name: Bank Connection List
  app: banking-dk
  narration: |
    In this video, we'll show you how to set up a new bank connection
    in Continia Banking. You'll learn how to navigate to the Bank
    Connections page, create a new connection, and configure the
    basic settings.
  stepNarration:
    0: First, open the Bank Connections page from the Role Center.
    1: Click New to create a new bank connection.
    2: Enter the name of your bank.
    3: Close the card to save your changes.
  tags: [banking, setup, connections]
  audience: new-users
  locale: da-DK
  prerequisites:
    - Continia Banking app is installed and licensed
```

## File Naming Convention

Files produced by the product-repo skill should be named:

```
<feature-kebab-case>.yml
```

Examples:
- `bank-connections-setup.yml`
- `payment-journal-import.yml`
- `bank-reconciliation.yml`

These files go in the `demo-specs/` directory of this repo.

## Consumption

The demo-generator reads these files and:

1. **Phase 1**: Passes the file directly to bc-replay for video recording (bc-replay reads the standard fields, ignores `demo:`)
2. **Phase 2**: Reads `demo.narration` and `demo.stepNarration` for TTS and subtitle generation
3. **Phase 3**: Reads `demo.targetPage` to wire up in-product video delivery
