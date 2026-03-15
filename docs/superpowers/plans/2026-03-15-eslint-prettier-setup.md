# ESLint + Prettier Setup — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ESLint, Prettier, and a pre-commit hook (husky + lint-staged) to enforce code quality and consistent formatting.

**Architecture:** ESLint 9 flat config with typescript-eslint recommended rules, Prettier for formatting, eslint-config-prettier to prevent conflicts, husky + lint-staged for pre-commit enforcement.

**Tech Stack:** ESLint 9, typescript-eslint 8, Prettier 3, husky 9, lint-staged 16

**Spec:** `docs/superpowers/specs/2026-03-15-eslint-prettier-setup-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `eslint.config.js` | ESLint flat config (recommended rules + prettier compat) |
| Create | `.prettierrc` | Prettier formatting options |
| Create | `.prettierignore` | Paths Prettier should skip |
| Create | `.husky/pre-commit` | Git pre-commit hook that runs lint-staged |
| Modify | `package.json` | Add devDependencies, scripts, lint-staged config |
| Modify | `.gitignore` | Add `.eslintcache` |

---

## Chunk 1: Tooling Setup

### Task 1: Install devDependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install ESLint + Prettier packages**

```bash
npm install -D eslint @eslint/js typescript-eslint eslint-config-prettier prettier
```

- [ ] **Step 2: Install husky + lint-staged**

```bash
npm install -D husky lint-staged
```

- [ ] **Step 3: Verify installation**

```bash
npx eslint --version
npx prettier --version
```

Expected: ESLint v9.x, Prettier 3.x

---

### Task 2: Create ESLint config

**Files:**
- Create: `eslint.config.js`

- [ ] **Step 1: Create `eslint.config.js`**

```js
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'output/', 'node_modules/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
);
```

- [ ] **Step 2: Verify ESLint runs without config errors**

```bash
npx eslint src/config.ts
```

Expected: Either clean output or lint warnings/errors (not a config crash).

---

### Task 3: Create Prettier config

**Files:**
- Create: `.prettierrc`
- Create: `.prettierignore`

- [ ] **Step 1: Create `.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 2: Create `.prettierignore`**

```
dist/
output/
```

(Prettier reads `.gitignore` by default, so `node_modules/`, `demos/`, `.tools/`, `test-results/`, `demo-results/` are already excluded.)

- [ ] **Step 3: Verify Prettier runs**

```bash
npx prettier --check "src/config.ts"
```

Expected: Reports whether file is formatted or not (no crash).

---

### Task 4: Add npm scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add lint and format scripts to `package.json`**

Add these to the `"scripts"` block:

```json
"prepare": "husky",
"lint": "eslint --cache src/",
"lint:fix": "eslint --cache --fix src/",
"format": "prettier --write \"src/**/*.ts\"",
"format:check": "prettier --check \"src/**/*.ts\""
```

- [ ] **Step 2: Verify scripts work**

```bash
npm run lint
npm run format:check
```

Expected: Both run without script errors. May report lint/format issues in existing code — that's fine for now.

---

### Task 5: Set up husky + lint-staged

**Files:**
- Create: `.husky/pre-commit`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Initialize husky**

```bash
npx husky init
```

This creates `.husky/` directory and adds `"prepare": "husky"` to package.json (already added in Task 4, so verify it's not duplicated).

- [ ] **Step 2: Overwrite `.husky/pre-commit` with lint-staged command**

`husky init` creates a default `pre-commit` with `npm test`. Replace its entire contents with:

```bash
npx lint-staged
```

- [ ] **Step 3: Add lint-staged config to `package.json`**

Add to the root of `package.json`:

```json
"lint-staged": {
  "**/*.ts": ["eslint --fix", "prettier --write"]
}
```

- [ ] **Step 4: Add `.eslintcache` to `.gitignore`**

Append `.eslintcache` to `.gitignore`.

- [ ] **Step 5: Commit tooling setup**

```bash
git add eslint.config.js .prettierrc .prettierignore .husky/ package.json package-lock.json .gitignore
git commit -m "chore: add ESLint, Prettier, husky, and lint-staged"
```

---

## Chunk 2: Format Existing Code

### Task 6: Lint and format the codebase

**Files:**
- Modify: all `src/**/*.ts` files

- [ ] **Step 1: Run ESLint auto-fix**

```bash
npm run lint:fix
```

Review output. If there are errors that can't be auto-fixed (e.g., `no-unused-vars`, `no-explicit-any`), fix or suppress them manually on a case-by-case basis.

- [ ] **Step 2: Run Prettier**

```bash
npm run format
```

- [ ] **Step 3: Verify everything is clean**

```bash
npm run lint && npm run format:check
```

Expected: Both pass with no issues.

- [ ] **Step 4: Verify TypeScript compilation**

```bash
npm run build
```

Expected: Clean compilation, no errors.

- [ ] **Step 5: Run existing tests to make sure nothing broke**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 6: Commit formatted code**

```bash
git add src/
git commit -m "chore: lint and format codebase"
```

---

### Task 7: Verify pre-commit hook works

- [ ] **Step 1: Make a trivial change to a source file** (e.g., add a blank line)

- [ ] **Step 2: Stage and commit**

```bash
git add src/config.ts
git commit -m "test: verify pre-commit hook"
```

Expected: lint-staged runs ESLint + Prettier on the staged file before commit succeeds.

- [ ] **Step 3: Revert the test commit**

```bash
git reset HEAD~1
git checkout -- src/config.ts
```
