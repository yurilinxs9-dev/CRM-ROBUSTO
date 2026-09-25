export function entryReportParams(params: Record<string, string>): Record<string, string> {
  const result = { ...params };
  for (const [key, time] of [['created_from', '00:00:00.000'], ['created_to', '23:59:59.999']]) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(result[key] ?? '')) result[key] += `T${time}-03:00`;
  }
  return result;
}

export function currentMonthRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const month = `${get('year')}-${get('month')}`;
  return { created_from: `${month}-01`, created_to: `${month}-${get('day')}` };
}
