---
name: recall
description: "Use when need to recall something from other chat or your own after a compaction episode"
disable-model-invocation: false
user-invokable: false
---

# Recall

Keep it tight and on-topic. Read only what the in-scope threads need, then stop.

As chat sessions are huge, use a subagent to answer your question about a particular chat and avoid polluting your context window.

Transcripts are Pi session files at `~/.pi/agent/sessions/--<slug>--/<timestamp>_<uuid>.jsonl`, where `<slug>` is the workspace path with the leading slash dropped and each "/" turned into "-" (so `/Users/you/proj` becomes `Users-you-proj`). The current chat is `$PI_SESSION_FILE`. Every line is one JSON entry. Chat turns are `message` entries whose `message.role` is `user`, `assistant`, or `toolResult`, and a subagent chat has a `session_info` entry whose name starts with `subagent:`.
