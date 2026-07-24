function utf8HeadEnd(bytes: Buffer, end: number) {
  end = Math.min(end, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

function utf8TailStart(bytes: Buffer, start: number) {
  start = Math.max(0, start);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return start;
}

export function truncateUtf8Head(text: string, maxBytes: number, marker = "") {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const markerBytes = Buffer.from(marker);
  if (markerBytes.length >= maxBytes) {
    return markerBytes
      .subarray(0, utf8HeadEnd(markerBytes, maxBytes))
      .toString();
  }
  const end = utf8HeadEnd(bytes, maxBytes - markerBytes.length);
  return Buffer.concat([bytes.subarray(0, end), markerBytes]).toString();
}

export function truncateUtf8Tail(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return bytes
    .subarray(utf8TailStart(bytes, bytes.length - maxBytes))
    .toString();
}

export function truncateUtf8Window(
  text: string,
  maxBytes: number,
  headBytes: number,
  marker: string,
) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const markerBytes = Buffer.from(marker);
  if (markerBytes.length >= maxBytes) {
    return markerBytes
      .subarray(0, utf8HeadEnd(markerBytes, maxBytes))
      .toString();
  }
  const headEnd = utf8HeadEnd(
    bytes,
    Math.min(headBytes, maxBytes - markerBytes.length),
  );
  const tailStart = utf8TailStart(
    bytes,
    bytes.length - (maxBytes - headEnd - markerBytes.length),
  );
  return Buffer.concat([
    bytes.subarray(0, headEnd),
    markerBytes,
    bytes.subarray(tailStart),
  ]).toString();
}
