const title = process.env.PR_TITLE ?? "";
if (!/^(feat|fix|perf|deps|docs|chore|refactor|test|ci|build|revert)(\([^\r\n)]+\))?!?: .+/.test(title)) {
  console.error("Use a Conventional Commit PR title, for example feat: add in-app updates or fix: preserve image transparency.");
  process.exitCode = 1;
}
