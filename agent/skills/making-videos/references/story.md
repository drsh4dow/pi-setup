# Story and script

## Shapes

Pick the shape that fits the one sentence the viewer should leave with.

| Kind | Shape |
| --- | --- |
| Demo of a change | Today, step by step. Then the same steps with the change. Then the two side by side, one row per step. Close on what is not wired yet and what to try first. |
| Walkthrough | One journey end to end. On each screen: what you see, what you do, what happens behind it, with its source. |
| Tutorial | For each command or step: when and why you use it, doing it, and reading what came back. |
| Promo | The problem in one picture, the thing, three or four proofs from real artifacts, how to start. Build on one picture per scene rather than cutting to unrelated ones. |
| Proof clip | The setup, the action, the result, the receipt. Captions only, under a minute. |
| Explainer or recap | What the viewer saw, why it happened, what was done. Lead with the root cause. |

## script.json

```json
[{"id": "t1", "chapter": "today", "show": "Each morning starts on the broker sites.", "say": "Each morning starts on the broker sites."},
 {"id": "w2", "chapter": "workspace", "show": "Clone 3y-harness and run bin/sync.", "say": "Clone three-Y harness and run bin sync."}]
```

- `show` is the caption. `say` is what the voice reads, spelled the way it should sound (`V-O-B`, `agents dot M-D`). Omit `say` when the two match. Keep the same sentences and clause breaks in both.
- One sentence per line, so each caption is one sentence and each action has its own line.
- Name the action in the line that performs it, and the first time, where the control is ("Click Approve, at the right end of the row."). The take fires the action on that word.
- When a new screen appears, give it a line about what it shows before the next action, so it stays up long enough to read.
- When a result takes time, cut the wait and say the measured time ("DealFlow answers within a minute").
- Use the viewer's words. Define a term the first time it is spoken. Never put an internal name, enum value or ticket key on screen without saying what it means.
- A line claims only what its frame shows. A fact the frame cannot show, such as the deployed commit or the signed-in account, goes on screen or out of the line.
- Write so speech recognition hears it as written: the sync check compares captions with what it hears.

## CLAIMS.md

One row per line that states a fact or shows a number:

| Line | Claim | Source | Shown at |
| --- | --- | --- | --- |
| d5 | A standup prep opened seven files | `bin/facts.py` over session `…/2026-10-29.jsonl`, rows 12-18 | 0:38 |

- A source is a file and line, a run id with its output, or a receipt the take wrote. A mention is not a read: a promo once said an agent read 4 files when it read 7, because the counter matched paths instead of file content.
- Quote real lines verbatim when the video shows a file.
- When the picture is staged, drawn, or a stand-in, the row says so, and so does the video.
