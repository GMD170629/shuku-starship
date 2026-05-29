# Agent Working Guidelines

## Functional Bug Triage

When the user reports that a feature does not work, do not treat the named action as an isolated checklist item. Treat it as an example of a broader capability area and audit the adjacent behaviors that a user would naturally expect.

For every reported broken interaction:

1. Identify the underlying user intent and feature surface.
2. List the expected interaction variants for that surface.
3. Check which variants are already implemented, partially implemented, or missing.
4. Fix the reported issue and any closely related missing behaviors unless the scope would become risky or unrelated.
5. In the final response, name the broader capability area that was checked, not only the literal symptom.

Example: if the user says EPUB left/right page turning and swipe page turning do not work, expand the investigation to the full reader navigation surface:

- Keyboard shortcuts: left/right arrows, space/page keys where appropriate, and escape for dismissing overlays if the UI supports it.
- Pointer navigation: left/right page zones, center tap to show or hide controls, toolbar buttons, progress slider, and table-of-contents jumps.
- Touch navigation: horizontal swipe, tap zones, scroll behavior in scrolled mode, and PWA standalone behavior.
- Focus boundaries: whether events are captured by iframes, overlays, controls, or embedded reader content.
- State recovery: whether hidden controls can always be shown again after immersive mode.
- Reader parity: whether EPUB, comic, PDF, and text readers offer comparable navigation affordances where the format allows.

Use this same "reported symptom -> expected capability set -> implementation audit" pattern for other feature areas such as upload/import, search/filtering, library organization, settings, progress sync, offline/PWA behavior, and mobile layouts.
