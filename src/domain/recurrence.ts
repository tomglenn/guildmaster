import type { Recurrence } from './schedules.ts';

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-GB', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    if (formatters.size > 100) formatters.clear();
    formatters.set(zone,value);
  }
  return value;
}
function local(timestamp: number, zone: string) {
  const parts = Object.fromEntries(formatter(zone).formatToParts(timestamp).map(p => [p.type,p.value]));
  return {year:+parts.year,month:+parts.month,day:+parts.day,hour:+parts.hour,minute:+parts.minute};
}
function calendar(value: ReturnType<typeof local>) {return Date.UTC(value.year,value.month-1,value.day);}
export function validateRecurrence(value: Recurrence) {
  if (!value || !Array.isArray(value.days) || !value.days.length || value.days.length > 7 || value.days.some(d=>!Number.isInteger(d)||d<0||d>6) || new Set(value.days).size !== value.days.length) throw new Error('Choose at least one day of the week.');
  if (typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('Choose a valid time.');
  if (typeof value.timezone !== 'string') throw new Error('Choose a timezone.');
  try {formatter(value.timezone);} catch {throw new Error('Choose a valid timezone.');}
}
// Resolve a local wall time using the offsets on either side of a transition.
// In a repeated hour choose the first instant; in a gap choose the first valid minute.
function onDate(rule: Recurrence, date: number): number | undefined {
  if (!rule.days.includes(new Date(date).getUTCDay())) return;
  const [hour,minute] = rule.time.split(':').map(Number);
  const offsets = new Set<number>();
  for (let h=-36;h<=36;h+=6) {
    const timestamp = date+h*3600000;
    const p = local(timestamp,rule.timezone);
    offsets.add(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-timestamp);
  }
  for (let wall=hour*60+minute;wall<1440;wall++) {
    const target=date+wall*60000;
    const matches=[...offsets].map(offset=>target-offset).filter(timestamp=>{
      const p=local(timestamp,rule.timezone);
      return calendar(p)===date && p.hour*60+p.minute===wall;
    });
    if (matches.length) return Math.min(...matches);
  }
}
export function nextOccurrence(rule: Recurrence, after: number): number {
  validateRecurrence(rule);
  const date=calendar(local(after,rule.timezone));
  for (let day=0;day<370;day++) {
    const instant=onDate(rule,date+day*86400000);
    if (instant !== undefined && instant>after) return instant;
  }
  throw new Error('No future occurrence could be calculated.');
}
export function previousOccurrence(rule: Recurrence, now: number): number {
  validateRecurrence(rule);
  const date=calendar(local(now,rule.timezone));
  for (let day=0;day<370;day++) {
    const instant=onDate(rule,date-day*86400000);
    if (instant !== undefined && instant<=now) return instant;
  }
  throw new Error('No previous occurrence could be calculated.');
}
export function recurrenceSummary(rule: Recurrence): string {
  const names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const days=[...rule.days].sort((a,b)=>a-b);
  const label=days.length===7?'Every day':days.join(',')==='1,2,3,4,5'?'Weekdays':days.map(d=>names[d]).join(', ');
  return `${label} · ${rule.time} · ${rule.timezone}`;
}
