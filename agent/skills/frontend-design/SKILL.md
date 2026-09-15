---
name: frontend-design
description: Use when creating, restyling, or visually critiquing UI, including layout, typography, color, and requests to make it less generic.
---

# Frontend Design

Build minimal, clean, modern interfaces that make the primary task obvious. Achieve beauty through proportion, typography, alignment, spacing, and precise interaction states. Visual novelty is optional.

Follow explicit user direction and preserve the existing product language unless a redesign is requested. When asked for critique or proposals, deliver those without proceeding to implementation.

## Design the task before the layout

Establish what the user came to this view to do, from the brief, repository, and existing workflow. State it privately in one sentence. Identify what they need to see and the next meaningful action, if any. Make reasonable assumptions; ask only when missing information would materially change the design and cannot be inferred.

Build the smallest composition that makes that task clear. A feature being available does not mean it belongs on the current screen.

Choose the relationship between views deliberately. A collection can lead to a detail view; a selector can switch the current object; a split view can support frequent comparison or switching. Avoid showing a full collection above a full editor by default.

Give each action one clear home in the current view. Before adding a control, check whether navigation or another visible region already provides the same action. Reuse that entry point rather than introducing another selector, button, or link. Repeat an action only when it serves a distinct interaction need, such as a contextual action on a different object—not merely because another region could accommodate it.

Preserve required capabilities, but place secondary tasks where they are needed. Changes to established navigation or behavior must remain within the requested scope.

Scale planning to the change. For a new interface or substantial redesign, choose the composition before its palette and type treatment. Inspect relevant visual references when provided. Reuse existing tokens and components. For a new palette, name the semantic color values and their roles before implementation. For a focused change, plan only the affected decisions and tokens.

## Compose an obvious attention hierarchy

Give the view a clear focal area: the work itself and its relevant action. Keep global navigation, secondary actions, metadata, and help subordinate.

Make the reading order apparent through placement, grouping, scale, and contrast. Important content and its action should be visually adjacent. Use strong button emphasis for the current task, rather than automatically emphasizing creation actions.

Establish the current location and selected object clearly, then avoid repeating them in breadcrumbs, eyebrows, headings, cards, and status bars unless the repetition serves a distinct navigation need.

Use space to separate meaningful groups and keep related elements close. Constrain content to a width appropriate to its task. A wider viewport does not require wider controls, extra columns, or additional content.

Let unused space remain unused. Create breathing room by removing competing regions before increasing padding. Keep text comfortably readable; shrinking or fading it is not a substitute for deciding what belongs. Choose familiar, legible typography when it fits, with a clear type scale and readable line lengths.

## Show information at the moment it matters

Keep working-screen copy functional and diegetic: actual content, object names, actions, state, and necessary guidance in the user's vocabulary.

Default to task content, necessary labels, and controls. Add a subtitle or explanation only when it resolves a specific uncertainty that the interface cannot resolve through clear naming, placement, or state. If removing a string changes no understanding, decision, action, or recovery, omit it.

Give each fact one useful home. Show status beside the object it describes. Surface exceptional states prominently; keep routine success subordinate.

Keep consequential instructions and warnings beside the affected action and visible before commitment. Put optional background help on demand. Preserve information needed for accessibility or informed decisions.

Leave out slogans, mood-setting subtitles, decorative illustrations, and commentary about the product on working screens. Marketing copy belongs in explicitly requested marketing contexts.

Use concrete nouns, direct verbs, and sentence case. Name actions consistently through the flow: "Save changes" describes the action; "Publish" produces "Published." Errors explain what happened and how to recover. Empty states provide direction rather than mood.

## Use the minimum visual structure

Start with alignment, spacing, and typography. Add a divider, background, or container only when it clarifies a relationship that is otherwise unclear.

Choose rows, tables, cards, and panels according to the interaction. Replacing cards with rows is not simplification if the same competing regions and duplicated information remain.

Before building, remove any proposed region that does not support the current task or necessary navigation.

Use motion to explain a change or respond to an action. Keep non-user-triggered motion sparing and purposeful, and respect reduced-motion preferences.

## Color defaults

Explicit user direction takes priority, followed by the existing product palette. When neither supplies a palette, start with a restrained, Linear-inspired scheme anchored on Magic Blue (#5E6AD2).

Treat this as the preferred starting point for exploration. Keep the composition task-specific, and adapt colors when the brief or contrast requirements call for it.

Use these semantic starting values. This is an application palette inspired by [Linear](https://linear.app/brand#Colors), not its official token specification.

| Role | Dark | Light |
| --- | --- | --- |
| Canvas | #08090A | #F4F5F8 |
| Surface | #0F1011 | #FFFFFF |
| Raised surface | #141516 | #FFFFFF |
| Subtle divider | #23252A | #DFE1E8 |
| Primary text | #F7F8F8 | #222326 |
| Secondary text | #8A8F98 | #60646C |
| Primary action fill | #5E6AD2 | #5E6AD2 |
| Primary action hover | #525EC0 | #525EC0 |
| Text on primary action | #FFFFFF | #FFFFFF |
| Link / focus accent | #828FFF | #525EC0 |

Choose the theme from the existing interface, brief, and usage context. These alternatives do not require implementing both themes.

Keep most surfaces neutral. Use blue for the current task's primary action, selected states, links, and keyboard focus. Keep semantic status colors distinct, and communicate state through labels or icons as well.

When exploring alternatives, start with #5E6AD2; try #525EC0 for a deeper treatment or #7170FF for a brighter one. Compare them in the same composition, changing only the affected color tokens. Generate alternatives when requested or when a concrete visual problem remains unresolved.

Map chosen values into the project's existing semantic tokens or CSS variables. Define interaction states through those tokens.

Check actual foreground/background pairs: at least 4.5:1 for normal text and 3:1 for large text and necessary control or state indicators. Subtle dividers are decorative separation, not sufficient control outlines. Adjust tokens where needed while preserving the blue family.

## Visual review is an acceptance gate

For every implemented visual change, use the `agent-browser` skill to render the actual affected view and state. Wait for content, fonts, and layout to settle, capture screenshots, and open them with an image-capable tool. Code, DOM inspection, and saved but unviewed screenshots do not satisfy this requirement.

Inspect the whole viewport before checking details. Answer from the image:

- Where does the eye go first? Is that the intended task or content?
- Can the user identify the current object and next action, if any, without reading explanatory paragraphs?
- Are the relevant content and controls together and easy to discover?
- Do multiple visible controls perform the same action on the same scope? Consolidate them unless their separate placement serves a concrete user need.
- Which regions compete with the task? What can be removed or subordinated?
- Is space organizing the screen, or merely stretching its elements?
- Is necessary text readable, with sufficient contrast and no clipping or overflow?
- Does color reinforce the intended hierarchy, and do text, controls, selection, and focus remain distinguishable on their actual backgrounds?

If the composition fails these checks, revise its structure or content before polishing colors, borders, shadows, or spacing. A screenshot that contains all requested features can still be a failed design.

Exercise changed interactions directly. Check keyboard focus and reduced-motion behavior where applicable. Fix observed problems and inspect fresh screenshots of the final result, including relevant interaction states and representative supported narrow and wide layouts. Stop when concrete issues are resolved; cosmetic churn is not iteration.

If rendering or image inspection remains blocked after reasonable recovery, report the specific blocker and mark visual verification incomplete. Code review is not a substitute.

In the final response, briefly identify the views and states visually reviewed, any fixes made during review, and remaining verification gaps.
