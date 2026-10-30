<!--
Short is fine. What changed, why, and what you ran — not a narrative of how
the work went. See CONTRIBUTING.md.
-->

## What and why

## How it was verified

<!--
"Tests pass" is not verification. For a fix: what did you break on purpose to
watch the new test fail? For a feature: what did you actually exercise?
-->

## Checklist

- [ ] A test fails without this change (I checked by breaking the fix)
- [ ] `pnpm typecheck && pnpm test:unit` green
- [ ] Unbuilt behaviour is marked `it.fails` with `ROADMAP:` / `GAP:`, not left red
- [ ] Docs updated in this PR if the change makes any of them wrong
- [ ] No new `pnpm lint` errors
- [ ] Dependencies pinned exactly (no `^` / `~`), and justified above if new
