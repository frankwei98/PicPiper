import { execFileSync } from "node:child_process";
for (const pr of JSON.parse(process.env.RELEASE_PRS || "[]")) {
  const detail = JSON.parse(execFileSync("gh", ["api", `repos/${process.env.GH_REPO}/pulls/${pr.number}`], { encoding: "utf8" }));
  execFileSync("gh", ["workflow", "run", "release-pr-checks.yml", "--ref", "main", "--repo", process.env.GH_REPO, "-f", `sha=${detail.head.sha}`], { stdio: "inherit" });
}
