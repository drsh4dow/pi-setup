---
name: research
description: Investigate a question against primary sources in a background subagent and save the cited findings to the state folder. Use when the user wants a topic researched across sources or reading legwork delegated. For a single docs or API fact, use docs-search instead.
disable-model-invocation: true
user-invokable: false
---

# Research

Hand the reading to a **background subagent**, so you keep working while it reads. For one fact you need before your next step, look it up yourself with the **docs-search** or **web-search** skill instead. For why this codebase is the way it is, use the **why** skill.

## 1. Frame the question

Write the question in one or two sentences, with what the answer is for: the decision it informs, or the code it unblocks. Name the versions, platforms, or dates that change the answer. When the request is too vague to frame, ask the user one question first.

Pick the output path: `research/<YYYY-MM-DD>-<slug>.md` in the state folder, as an absolute path.

## 2. Launch the researcher

Start one delegate per the **subagents** skill, in the `researcher` role, with `bg_start`. Its assignment states:

- The framed question and what the answer is for.
- Any leads you already hold: links, files, names, error text.
- The skills to use: **web-search** and **docs-search**.
- The write scope: only the output path.
- The job:
  1. Investigate against **primary sources**: official docs, source code, specs, changelogs, and first-party APIs, not a secondary write-up of them. Follow every claim back to the source that owns it, and read the version the question names.
  2. Write the findings to the output path in this shape: the question; the answer in three sentences or fewer; the findings, each citing its source as a URL or `file:line` and the version or date read; the places where sources disagree, or where none could be found; and the list of sources.
- The done condition: every claim in the file cites a primary source the subagent read in this run.
- The report: the output path and the three-sentence answer.

## 3. Use the result

When the researcher finishes, read the file. Open the sources behind the claims your next decision rests on and check that they say what the file says. Then give the user the answer and the path.
