# Web Display Visual Optimization — Phase 2: Button & Border Fixes

## Problem

Button elements (Open, Add, Plan, Review Changes, Planning) and some bordered text elements display incorrectly:
- Buttons show browser default styles: grey `rgb(107,107,107)` background, `2px outset` borders
- `--ide-button-*` CSS variables are undefined → `bg-ide-button-background` etc. resolve to nothing
- Tailwind's preflight (form element reset) is not applied in `#chat-viewport` scope

## Affected IDE CSS Classes

| Class | CSS Variable | Purpose |
|---|---|---|
| `bg-ide-button-background` | `--ide-button-background` | Primary button bg |
| `bg-ide-button-hover-background` | `--ide-button-hover-background` | Primary button hover |
| `bg-ide-button-secondary-background` | `--ide-button-secondary-background` | Secondary button bg |
| `bg-ide-button-secondary-hover-background` | `--ide-button-secondary-hover-background` | Secondary button hover |
| `bg-ide-chat-background` | `--ide-chat-background` | Chat area bg |
| `bg-ide-editor-background` | `--ide-editor-background` | Editor area bg |
| `text-ide-button-color` | `--ide-button-color` | Button text |
| `text-ide-button-secondary-color` | `--ide-button-secondary-color` | Secondary button text |
| `text-ide-link-color` | `--ide-link-color` | Link color |
| `text-ide-text-color` | `--ide-text-color` | General text |

## Proposed Changes

### [MODIFY] [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/server.js)

**`captureComputedVars()`**: Add all `--ide-*` variable names to the extraction list

### [MODIFY] [index.html](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/public/index.html)

**`applyCascadeStyles()`**: 
1. Add Tailwind preflight button/form reset rules scoped to `#chat-viewport`
2. Falls back to reasonable dark-theme default values if `--ide-*` vars are still missing

## Verification

- Screenshot comparison of buttons before/after
- Buttons should have transparent/subtle backgrounds, no browser default outset borders
