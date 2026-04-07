export function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    let str: string;
    if (val instanceof Date) {
      str = val.toISOString();
    } else if (
      typeof val === 'object' &&
      val !== null &&
      typeof (val as { toString?: unknown }).toString === 'function' &&
      (val as object).constructor.name === 'Decimal'
    ) {
      str = String(val);
    } else {
      str = String(val);
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines: string[] = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\r\n');
}
