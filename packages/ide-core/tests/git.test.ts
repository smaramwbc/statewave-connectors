import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readGitContext } from "../src/index.js";

async function makeRepo(
  head: string,
  config: string,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ide-core-git-"));
  const gitDir = path.join(root, ".git");
  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(gitDir, "HEAD"), head);
  await fs.writeFile(path.join(gitDir, "config"), config);
  return root;
}

describe("readGitContext", () => {
  it("reads branch + origin remote and parses owner/repo", async () => {
    const root = await makeRepo(
      "ref: refs/heads/feat/ide-companion\n",
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:smaramwbc/statewave-connectors.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
    const ctx = await readGitContext(root);
    expect(ctx.branch).toBe("feat/ide-companion");
    expect(ctx.remoteUrl).toBe("git@github.com:smaramwbc/statewave-connectors.git");
    expect(ctx.host).toBe("github.com");
    expect(ctx.owner).toBe("smaramwbc");
    expect(ctx.repo).toBe("statewave-connectors");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("prefers origin over other remotes", async () => {
    const root = await makeRepo(
      "ref: refs/heads/main\n",
      `[remote "upstream"]\n\turl = https://github.com/upstream/repo.git\n[remote "origin"]\n\turl = https://github.com/me/fork.git\n`,
    );
    const ctx = await readGitContext(root);
    expect(ctx.remoteUrl).toBe("https://github.com/me/fork.git");
    expect(ctx.owner).toBe("me");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("handles detached HEAD and missing remote", async () => {
    const root = await makeRepo("0123456789abcdef0123456789abcdef01234567\n", "[core]\n");
    const ctx = await readGitContext(root);
    expect(ctx.branch).toBe("0123456789ab");
    expect(ctx.remoteUrl).toBeNull();
    expect(ctx.owner).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns an empty context when there is no .git", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ide-core-nogit-"));
    const ctx = await readGitContext(root);
    expect(ctx).toEqual({
      branch: null,
      remoteUrl: null,
      owner: null,
      repo: null,
      host: null,
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("follows a .git file pointer (worktree)", async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "ide-core-gitreal-"));
    const gitDir = path.join(real, "actual-git");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/wt\n");
    await fs.writeFile(
      path.join(gitDir, "config"),
      `[remote "origin"]\n\turl = https://github.com/a/b.git\n`,
    );
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "ide-core-gitwork-"));
    await fs.writeFile(path.join(work, ".git"), `gitdir: ${gitDir}\n`);
    const ctx = await readGitContext(work);
    expect(ctx.branch).toBe("wt");
    expect(ctx.repo).toBe("b");
    await fs.rm(real, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  });
});
