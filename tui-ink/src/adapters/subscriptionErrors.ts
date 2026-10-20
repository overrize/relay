/** Keep a useful stop reason without persisting a CLI's prompts, account or tokens. */
export function subscriptionStopReason(diagnostic: string): string {
  if (/rate.?limit|quota|hit your limit|usage limit|too many requests/i.test(diagnostic)) return "quota-or-rate-limit";
  if (/model.*(?:not supported|not found|unavailable|does not exist)|model_not_found/i.test(diagnostic)) return "model-not-available";
  if (/not logged|login required|unauthorized|authentication|oauth|expired.*token/i.test(diagnostic)) return "login-required";
  if (/timed? ?out|timeout/i.test(diagnostic)) return "timeout";
  return "cli-execution-failed";
}
