# UI prototype

Build enough of the interface to answer the user's layout or interaction question. Use the project's components, styling, and realistic data density when they help the comparison.

## Placement

Prefer the existing page's context when that exposes constraints such as navigation, available space, or neighboring controls. Use a clearly named throwaway route only when no existing page fits.

Isolate the entire prototype from production. On an existing route, retain the normal rendering unless a development-only prototype gate is active. A hidden switcher alone does not prevent prototype variants from rendering. New prototype routes must also be unavailable in production.

Keep existing read-only data access where appropriate. Use local state or a stub for mutations that are outside the prototype's scope.

## Variants

Create multiple variants only when their differences answer a real design choice. Vary structure or interaction rather than colors alone. There is no fixed variant count.

When comparison needs a switcher, keep it local to the prototype. A URL parameter can make variants shareable; a small labeled control is sufficient. Preserve unrelated query parameters and avoid intercepting keyboard input used by the page.

## Deliver

Run the prototype and inspect the relevant interaction. Provide its URL, the question answered, and remaining decisions. Keep the artifact available for review. Follow [SKILL.md](SKILL.md) for cleanup and scope; production integration or branch archival requires an implementation or archival request.
