// Two-way sync between the local cache and the server. Last write wins.
export function mergeRecords(local, remote) {
  const merged = new Map(local.map((record) => [record.id, record]));
  for (const record of remote) {
    const existing = merged.get(record.id);
    if (!existing || record.updatedAt > existing.updatedAt) merged.set(record.id, record);
  }
  return [...merged.values()];
}

export function stampEdit(record, changes) {
  return { ...record, ...changes, updatedAt: Date.now() };
}
