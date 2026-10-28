// Finds the child session of a launch that no record in its parent names, such as a `bg_start`
// launch whose stderr went to a file: the session Pi started under the name the launcher gave it.

import type { Launch } from "./launches.ts";

/** A session whose head gives it a name, and when it started. */
export interface NamedSession {
  readonly id: string;
  readonly name: string;
  /** Milliseconds since the epoch. */
  readonly startedAt: number;
}

/**
 * Joins each launch with no child session to a session carrying the name the launch gives its
 * child: the earliest that no other launch took and that started at or after the call, and
 * before the launching session's next later call under that name. So a retried launch takes its
 * own child, and launches one call made under one name take one child each. A launch with no
 * time or no name stays unjoined.
 */
export function namedChildJoiner(sessions: readonly NamedSession[]) {
  const byName = Map.groupBy(
    sessions.toSorted((a, b) => a.startedAt - b.startedAt),
    (session) => session.name,
  );

  const taken = new Set<string>();

  /** `launches`, one session's in call order, joined to children outside `graded`. */
  return (launches: readonly Launch[], graded: ReadonlySet<string>): Launch[] =>
    launches.map((launch) => {
      const name = launch.childName;
      const calledAt = Date.parse(launch.calledAt ?? "");

      if (launch.child !== undefined || name === undefined || !Number.isFinite(calledAt)) {
        return launch;
      }

      const retries = launches.flatMap((later) => {
        const at = Date.parse(later.calledAt ?? "");

        return later.childName === name && at > calledAt ? [at] : [];
      });

      const until = Math.min(Infinity, ...retries);

      const child = byName
        .get(name)
        ?.find(
          (session) =>
            session.startedAt >= calledAt &&
            session.startedAt < until &&
            !taken.has(session.id) &&
            !graded.has(session.id),
        );

      if (child === undefined) return launch;

      taken.add(child.id);

      return { ...launch, child: child.id };
    });
}
