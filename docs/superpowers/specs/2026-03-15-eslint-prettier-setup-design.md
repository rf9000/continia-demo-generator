# ESLint + Prettier Setup

**Date:** 2026-03-15
**Status:** Proposed

## Goal

Add industry-standard linting and formatting to the project to catch bugs and enforce consistent code style.

## Tools

| Tool | Version | Purpose |
|------|---------|---------|
| `eslint` | ^9 | Linting (flat config) |
| `@eslint/js` | ^9 | ESLint recommended rules |
| `typescript-eslint` | ^8 | TypeScript-aware ESLint rules |
| `eslint-config-prettier` | ^10 | Disables ESLint formatting rules that conflict with Prettier |
| `prettier` | ^3 | Code formatting |
| `husky` | ^9 | Git hook management |
| `lint-staged` | ^16 | Run linters on staged files only |

## Configuration

### ESLint (`eslint.config.js`)

Flat config format (ESM). Three layers:
1. `@eslint/js` recommended — catches unused vars, unreachable code, etc.
2. `typescript-eslint` recommended — TypeScript-aware syntax rules (not type-checked; fast)
3. `eslint-config-prettier` — turns off formatting rules

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

No custom style rules beyond what "recommended" provides.

### Prettier (`.prettierrc`)

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

### Pre-commit hook (husky + lint-staged)

`lint-staged` config in `package.json`:
```json
{
  "lint-staged": {
    "**/*.ts": ["eslint --fix", "prettier --write"]
  }
}
```

Husky `.husky/pre-commit` runs `npx lint-staged`.

### npm scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `prepare` | `husky` | Install git hooks on `npm install` |
| `lint` | `eslint --cache src/` | Run ESLint on all source |
| `lint:fix` | `eslint --cache --fix src/` | Auto-fix ESLint issues |
| `format` | `prettier --write "src/**/*.ts"` | Format all source |
| `format:check` | `prettier --check "src/**/*.ts"` | Check formatting (CI) |

### Ignored paths

`.prettierignore`: `dist/`, `output/` (Prettier reads `.gitignore` by default, so `node_modules/`, `demos/`, `.tools/`, `test-results/`, `demo-results/` are already covered).

`.eslintcache` added to `.gitignore`.

## Implementation order

1. Install devDependencies
2. Create `eslint.config.js`
3. Create `.prettierrc`
4. Create `.prettierignore`
5. Add npm scripts to `package.json`
6. Run `npx husky init` (creates `.husky/` dir and `prepare` script)
7. Write `.husky/pre-commit`
8. Add `lint-staged` config to `package.json`
9. Add `.eslintcache` to `.gitignore`
10. Run `lint:fix` + `format` on existing code, fix any errors
11. Commit formatting changes separately

## Approach for existing code

After setup, run `lint:fix` and `format` once to bring all files into compliance. Existing code may have `no-explicit-any` or `no-unused-vars` findings — fix or suppress on a case-by-case basis. Committed as a single "chore: lint and format codebase" commit.

## What this does NOT include

- CI integration (can add later)
- Editor config (`.vscode/settings.json` etc.)
- Strict type-checked rules (no-explicit-any, explicit return types)
- Prettier for non-TS files (JSON/YAML — can add later)
