# Merge danger audit

Rate how much damage a change does if it fails. The failure is given: assume
every changed part misbehaves in the worst way its code allows. Correctness is
out of scope; spend the effort on reach.

## Trace each changed part

Read each changed part and the code that calls it or that it calls. Record,
with `file:line`:

- **Reach:** the data it writes or deletes, the messages it sends, the
  external systems it calls, the permissions it grants, and the users and
  paths it serves.
- **Detection:** what notices the failure and how soon: a crash, CI, an
  alert, a user, or nothing.
- **Recovery:** whether a revert undoes the damage, or what persists.

Mitigations in the code limit reach: a flag that is off by default, a
transaction, a dry-run mode, an additive migration. Count them.

The trace is done when every changed file is accounted for.

## Rate

Rate the part with the widest damage; the change takes its level. The
highest matching level wins, and cases under Calibration outrank these rules.

- **low:** a revert undoes the damage, and CI or the author sees it before
  users do. No data, security, money or contract is in reach. Docs, tests,
  dev tooling, copy. Review: auto-merge once CI passes.
- **medium:** a revert undoes the damage, but users or operators hit it
  first: a broken screen, a failing job, a slower endpoint. Review: normal
  review of the diff.
- **high:** any of damage a revert leaves behind; data loss or corruption;
  auth, permissions or secrets; money; personal data; an outage of a core
  path; wrong results that nothing would flag. Review: every line read by a
  reviewer who knows the area, and no auto-merge.

A two-way door is one that a revert fully undoes. Migrations, deletions,
backfills, published contracts and sent messages make a door one-way.

## Report

Change nothing. Return these three lines, one sentence each:

```markdown
**Severity:** <low, medium or high>. <The worst case in one sentence.>

**Door:** <one-way or two-way>. <What a revert cannot undo, if anything.>

**Blast radius:** <What the damage reaches: a screen, a job, API consumers,
or a data set.>
```

Then list the parts with the widest reach, widest first, each with its reach,
detection and recovery and their `file:line` references.

## Calibration

Cases the user re-rated: what the diff did, the level, and why.
