// Escapes user text (titles, names) so Slack mrkdwn does not read it as a
// control sequence such as <!channel>, <@USER>, or a spoofed link.
// https://api.slack.com/reference/surfaces/formatting#escaping
export function escapeSlackText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
