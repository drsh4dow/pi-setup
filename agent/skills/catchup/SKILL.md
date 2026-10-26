---
name: catchup
description: "Catch the user up on what changed in this chat since their last message, in plain words and small visuals. List every item waiting on them with what they need to decide it from the reply alone. Use for /skill:catchup."
disable-model-invocation: true
user-invokable: true
---

# Catchup

Catch the user up on what changed in this chat since the last message they wrote before `/skill:catchup`, and help them understand each change, not only where it stands. Then lay out every call waiting on them so they can make it from your reply alone. Notifications and subagent results are not their messages. Assume the user remembers their last message and nothing after it.

Use [`/bro`](../../prompts/bro.md)'s voice, not its task: plain words, short sentences, no jargon, like one person catching up another. Say what changed for the user, not how you did it. Say "the tests pass", not "CI is green". Leave out hashes, file paths, commands, build numbers, and test counts unless the user needs one to act. Call each PR, branch, or agent by a name the user would know, not by a label you invented. If a fact needs context to make sense, give the context or leave the fact out.

## Gather what changed

Keep this turn read-only. Make visuals only from what you already have: do not change code, start an app or a job, or post anything. Collect your own work since that message, reports from subagents, and messages from anyone else in this chat. Check the current state of each PR, CI run, or agent this chat touched. Check each number you will show against the facts it comes from, and say so when you correct one.

An action item is a call or step only the user can take, such as a product choice, an approval, an irreversible action, or access you lack. Include any still waiting on the user, even one raised before their last message. A question someone in the chat asked that only the user can answer, such as a bot asking who owns a ticket, is a call, and so is a default you chose on the user's behalf that they may want changed. Work you can still do yourself is not an action item. Never make up a call to fill the reply. A step the user did not ask for and the work does not need is not an action item, unless it is irreversible and waiting on the user: give it one line and no visual.

One call can cover many items, such as each PR in a set awaiting merge. For each item, collect its link, what it changes for users, the evidence behind your pick, its risk, and your pick. Write "unknown" for a fact the call needs that you do not know. Leave out a link you do not have.

## Write the reply

Spend words on the calls, not on the story. Keep what happened under 100 words, not counting pictures, and shorter when less happened. Leave out work that changed nothing for the user. Give each item about 30 words. The reply grows with the number of items: two items need well under 150 words in all, not counting pictures, and thirty need far more. Never cut items or shrink them to stay under a word count: no count in place of a list, and no link in place of an item. A link can add depth, but the reply alone must be enough to decide.

Open with one short sentence that names what waits on the user, or says nothing does. The action items give the detail. If nothing happened and nothing waits on the user, say so and stop.

Then show what happened, pictures first. Embed inline the screenshots and videos the work produced, then any diagram that explains a change. Then sum up in one short bullet per thing the user asked for: what came of it, and whether it is done, still running, failed, or not checked. Write each line the way you would say it out loud: "Search was slow from a missing index", not "Search review: done" or "Slow search: missing index". Name any bug found and fixed on the way. Each line must stay true when read alone. Never mark something done that still waits on the user, and leave out anything the action items say. Under the summary, give at most three short lines that change what the user knows or must do. Then name in one line any work left that you can do yourself.

Then list the action items. Ask the call the user owns, such as merge, approve, or pick, and give your pick. A step you would take first goes in your pick. So does anything that must happen first, and anything that cannot be undone. Give the number or link of each PR, issue, or agent a call is about, also in a call between options.

Fit the shape to the call. A call about one item is one bullet: the call, your pick, what it changes for users, the evidence behind your pick, and its risk, with the item named once. When items share a call, write the call and your pick once, then give each item its own bullet, riskiest first: its link and name, what it changes for users, the evidence behind your pick, and its risk. An item that is also part of a call between options, such as a PR that can merge once the user picks, still gets its own full bullet in the shared call. Name an item's pick only where it differs from the call's. Give each item's risk even when it is low, such as "Low risk: only the colors change." Say what waiting costs only when it is more than a delay, such as a deadline or lost data.

For a call between options, give every option the work weighed, each with what it gets the user and what it costs, and the current state when there is one. Those costs are the call's risk, so add no separate risk line, unless the user must also merge or approve the item: then give the item's own risk too, as for any merge. When the screenshots above show the options, write each option's gain and cost under its screenshot.

## Visuals

A visual is a picture: a screenshot, a video, a Mermaid diagram, a chart or diagram from `scripts/visualize.ts`, or a generated image. A Markdown table is not a visual, even with before and after columns.

When something is easier to grasp as a picture than as sentences, draw it: how a design or system works, a PR stack or dependency chain with each PR's state, a before and after of a fix, or options side by side. Never draw a status list, a list of action items, or boxes with nothing connecting them. Never give a fact twice, in text or across visuals.

Keep each visual small enough to read at a glance: at most six boxes, with at most eight words in each. Write labels as plain words a person would say, not tags like "Tests: pass". A fact that needs a sentence belongs in the text, or nowhere.

Embed screenshots and videos inline when the change is visible, not only as links. If a visible change has none, mark its summary line "No screenshot yet," and say there what changed on screen. Draw diagrams and charts from facts you have: a Mermaid diagram for how things connect and a `scripts/visualize.ts` chart for numbers. Never invent a number, and never draw or generate a picture of a screen you did not capture. Link only artifacts that exist.

To embed a screenshot or chart in Pi, read its image file with the `read` tool, which shows the picture in the chat. A video cannot play in the chat, so link its file. Run `node <skill dir>/scripts/visualize.ts --help` for how to draw a chart, and write its files in the state folder.
