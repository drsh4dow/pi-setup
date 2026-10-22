// Pagination helper from the v1 API. Not wired anywhere since the v2 listing.
export function paginateV1(rows, page, perPage = 20) {
  const start = (page - 1) * perPage;
  return { rows: rows.slice(start, start + perPage), page, pages: Math.ceil(rows.length / perPage) };
}
