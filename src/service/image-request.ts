// An internal call allowance stops accidental agent loops without asking users
// to configure budgets. Requested counts only expand this allowance; the tool
// still defaults to one image and honors the user's requested total.
const numbers: Record<string, number> = {
  one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,
  twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,
};
export function imageAttemptAllowance(request: string): number {
  const word = `(?:${Object.keys(numbers).join('|')}|hundred|thousand)`;
  const amount = `(?:\\d+|${word}(?:[ -]+${word}){0,5})`;
  const adjective = '(?:more|additional|high|medium|low|quality|portrait|landscape|square|mockup|ui|design|generated|different|new)';
  const counts = new RegExp(`\\b(${amount})\\s+(?:${adjective}[ -]+){0,6}(?:images?|mockups?|concepts?|variations?|versions?|illustrations?|renders?)\\b`, 'gi');
  let allowance = 10;
  for (const match of request.matchAll(counts)) {
    let count = Number(match[1]);
    if (!Number.isFinite(count)) {
      let total = 0, group = 0;
      for (const token of match[1].toLowerCase().split(/[ -]+/)) {
        if (token === 'hundred') group = (group || 1) * 100;
        else if (token === 'thousand') { total += (group || 1) * 1000; group = 0; }
        else group += numbers[token] ?? 0;
      }
      count = total + group;
    }
    if (Number.isSafeInteger(count) && count > allowance) allowance = count;
  }
  return allowance;
}
