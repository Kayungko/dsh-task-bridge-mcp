export function normalizeExternalRef(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length > 200) throw new Error('externalRef 必须是 trim 后 ≤200 字符的字符串。');
  return value.trim() || undefined;
}
