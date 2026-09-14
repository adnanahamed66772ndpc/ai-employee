import { expect, it } from "vitest";
import { isFolderName, isRepoName } from "./projects.ts";

it("accepts ordinary owner/name repositories", () => {
  for (const repo of ["octocat/hello-world", "example-org/ai-employee", "org1/repo.name_2"]) {
    expect(isRepoName(repo)).toBe(true);
  }
});

it("rejects repository values that could be read as flags or path segments", () => {
  for (const repo of ["-c/x", "owner/--upload-pack", "../evil", "owner/..", ".hidden/repo", "owner", "a/b/c", "owner/name --flag"]) {
    expect(isRepoName(repo)).toBe(false);
  }
});

it("only allows plain folder names", () => {
  expect(isFolderName("my-app")).toBe(true);
  for (const folder of ["-rf", "..", ".git", "a/b", "a b", ""]) expect(isFolderName(folder)).toBe(false);
});
