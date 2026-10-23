# Journal format

The journal is a file of JSON lines. The first line is a header,
`{"v":<version>}`. Every later line is a record, `{"op":"<op>","job":{...}}`,
that holds the whole job as it was right after the operation. Replay keeps
the last record of each job, so no record needs another to make sense.

## Versions

`journalVersion` is the version this build writes and the newest it reads.
A build refuses a journal with a newer header before it reads a single
record:

    replay journal jobs.journal: journal version 2 is newer than 1, the newest this build reads

That refusal is what makes a rollback safe. Without it, an older build
reading a newer journal fails halfway through replay on an op or state it
doesn't know, or, worse, loads a job with a field it doesn't know and drops
that field the next time it writes the job. So every change to what a line
can hold bumps the version, and `testdata/` keeps a journal written by each
previous version, so we know newer builds still read it.

| Version | Change                                      |
| ------- | ------------------------------------------- |
| 1       | first format: enqueue, lease, extend, complete, fail, expire |
