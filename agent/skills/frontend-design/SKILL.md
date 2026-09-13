---
name: frontend-design
description: Use when creating, restyling, or visually critiquing UI, including layout, typography, color, and requests to make it less generic.
---

# Frontend Design

Make deliberate, opinionated visual choices grounded in the product, audience, and primary task. Aim for a recognizable identity and clear hierarchy. When extending an existing interface, preserve its design language unless the user asks to change it.

## Ground your designs in the subject matter

Establish the subject, audience, and primary task from the brief, repository, and existing interface. Make reasonable assumptions; ask only when missing information would materially change the design and cannot be inferred. Briefly state consequential assumptions.

The subject's industry, materials, and vernacular are where distinctive visual choices come from — a design for a toy for girls aged 8–11 will be very aesthetically different from a dashboard for financial analysts. Build with the brief's real content and subject matter throughout.

## Design principles

Make the first viewport serve the page's purpose. An expressive landing page can lead with the most characteristic thing in the subject's world: a headline, image, animation, live demo, or interaction. A task-oriented interface should prioritize orientation, useful information, and the primary action. Be deliberate with your choice: a big number with a small label, supporting stats, and a gradient accent is the default treatment, so only use it if that's truly the best option.

Typography carries the personality of the page. You don't need a different typeface for display or headline text and body content: use one family or two, and if two, make them clearly distinct.

Choose your typefaces deliberately, not the default families you would reach for on any other project, and establish hierarchy through a clear type scale, intentional weights, widths, and spacing. When type is used as a headline or visual element, use the type treatment itself as an active part of the design, not a neutral delivery vehicle for the content.

Default to line lengths of less than 80 characters. Serif typefaces can have slightly longer line lengths; give serif body text slightly more line-height than a sans-serif.

Avoid these default typographic treatments; they are the commonest tells of a generated page:

- Accenting just a single word or phrase in a headline, like putting one word in italic/bold or a different color.
- Using all caps for labels.
- Adding unnecessary typographic labels above content.

Visual structure is information. Structural devices like outlines, borders, numbering, eyebrows, dividers, labels, etc., encode useful information about the content rather than decorate it. Many generic designs use numbered markers (01 / 02 / 03), but that's only appropriate if the content actually is a sequence — like a stepped process or a timeline. Before adding numbered markers, check the content really is a sequence.

Use non-user-triggered motion sparingly and deliberately, only to draw attention. A single orchestrated moment — one page-load sequence or one reveal — lands better than scattered effects; fade-and-slide-up entrances on each section and hover transitions on every card are the generic default and read as AI-generated. Motion that answers a person's action (opening, expanding, confirming) is welcome when it shows what changed.

Consider written content carefully. Often a design brief may not contain real content, and it's up to you to come up with copy and placeholder content. Copy can make a design feel as templated as the design itself. See the below section on writing for more guidance.

## Process: plan, review against the brief, build, critique

For calibration, AI-generated design right now clusters around some traits:

1. a warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta or warm-clay accent (often near #D97757);
2. a near-black background with a single bright acid-green or vermilion accent;
3. a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns;
4. the SaaS-card kit: content chopped into identical rounded cards, one border-radius on everything regardless of hierarchy, the same soft grey shadow (rgba(0,0,0,.1)) under each, and gradient washes as decoration;
5. template chrome that appears whatever the subject: a tracked-out ALL-CAPS eyebrow label above every heading; meta strings joined with middle dots ('A · B · C'); labels built as 'WORD — fragment' with a spaced em dash; tinted near-black (#0B0B0B, #111) standing in for black; a monospace face for small data labels; a '→' appended to link and button text.

These traits are legitimate when they fit the subject or existing design language. The brief's own words always win, including when it asks for one of these looks. Where it leaves an axis free, choose for a subject-specific reason rather than habit.

Scale planning to the change. For a new interface or substantial redesign, choose a compact direction before implementation:

- Color: a core palette with named values.
- Type: typefaces and their roles.
- Layout: composition, hierarchy, and alignment. Use wireframes or alternatives when they resolve a real layout question.
- Character: one visual idea tied to the subject.

Reuse existing tokens and components where appropriate. For a focused change, plan only the affected decisions.

Check that the direction serves the primary task, respects the brief, and gives each major visual choice a concrete rationale. Revise choices that lack one, then build. Keep planning concise. When asked for critique or proposals, deliver those without proceeding to implementation.

When writing the code, be careful of structuring your CSS selector specificities. It's easy to generate CSS classes that cancel each other out (especially with a type-based selector like .section and an element-based selector like .cta). This can happen often with padding/margin between sections.

## Restraint and self-critique

Spend your boldness in one place. Let one element be the memorable thing, keep everything around it quiet and disciplined, and cut any decoration that does not serve the brief.

For implemented visual changes, inspect the affected view in a browser when available. Use screenshots to assess composition and hierarchy; exercise changed interactions directly. Check representative narrow and wide viewports, readable contrast, keyboard focus, and reduced-motion behavior where applicable.

Fix observed issues and recheck affected areas. Expand verification only for a concrete unresolved concern. Report what could not be visually verified.

## More on writing in design

Words appear in a design for one reason: to make it easier to understand and use. They are design content, not decoration. Bring the same intentionality and minimalism to copywriting that you would bring to spacing and color. Before writing anything, ask what the design needs to say, and how it can best be said to help the person navigate the experience.

Write from the end user's perspective. Name things by what users will understand in simple language, not by how the system is built. A user manages notifications, not webhook config. Describe what something is or does in plain terms rather than selling it. Being specific and legible to new users is always better than being clever.

Use active voice as default. A CTA says exactly what happens when it is used: "Save changes," not "Submit." An action keeps the same name through the whole flow, so the button that says "Publish" produces a toast that says "Published." The vocabulary of an interface is the signposting for someone navigating the product. Cohesion and consistency are how people learn their way around.

Treat failure and emptiness as moments for direction, not mood. Explain what went wrong and how to fix it, in the interface's voice rather than a person's. Errors don't apologize, and they are never vague about what happened. An empty screen is an invitation to act.

Keep the tone conversational: plain verbs, sentence case, no filler, with tone matched to the brand and the audience. Let each written element do exactly one job.
