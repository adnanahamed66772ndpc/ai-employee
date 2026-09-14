/** Credentials that must never end up in memory, handoff notes or notifications. */
export const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_\w{20,}|ci_live_\w{10,}|cfat_\w{10,}|xox[abpr]-[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|\d{8,10}:AA[\w-]{30,})/;

export const containsSecret = (text: string) => SECRET_PATTERN.test(text);
