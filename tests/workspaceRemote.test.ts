import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  commitAll,
  configureRepoRemote,
  ensureRepo,
  pushRepo,
  writeFiles,
  WorkspaceError,
} from "../src/lib/workspace";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  return stdout.trim();
}

async function createPopulatedRemote(root: string): Promise<string> {
  const source = path.join(root, "source");
  const remote = path.join(root, "customer.git");
  await git(root, ["init", "--initial-branch=main", source]);
  await writeFile(path.join(source, "README.md"), "# Kundenprojekt\n", "utf8");
  await git(source, ["add", "README.md"]);
  await git(source, ["-c", "user.name=Kunde", "-c", "user.email=kunde@example.test", "commit", "-m", "Initial"]);
  await git(root, ["clone", "--bare", source, remote]);
  return remote;
}

test("Remote-Repositories werden geklont und Team-Commits gepusht", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scrumy-git-"));
  const previousWorkspaceRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  t.after(async () => {
    if (previousWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousWorkspaceRoot;
    await rm(root, { recursive: true, force: true });
  });

  const remote = await createPopulatedRemote(root);
  const { dir, created, cloned } = await ensureRepo("projekt-eins", {
    remoteUrl: remote,
    defaultBranch: "main",
  });

  assert.equal(created, true);
  assert.equal(cloned, true);
  assert.equal(await readFile(path.join(dir, "README.md"), "utf8"), "# Kundenprojekt\n");
  assert.equal(await git(dir, ["remote", "get-url", "origin"]), remote);

  await writeFiles(dir, [{ path: "src/feature.txt", content: "vom Team gebaut" }]);
  const commit = await commitAll(dir, { message: "Feature liefern", authorName: "Backend-Agent" });
  assert.ok(commit);

  const verification = path.join(root, "verification");
  await git(root, ["clone", remote, verification]);
  assert.equal(await readFile(path.join(verification, "src/feature.txt"), "utf8"), "vom Team gebaut\n");
  assert.equal(await git(verification, ["log", "-1", "--pretty=%an"]), "Backend-Agent");

  await t.test("ein bestehender lokaler Workspace kann nachtraeglich angebunden werden", async () => {
    const local = await ensureRepo("projekt-zwei");
    const emptyRemote = path.join(root, "empty.git");
    await git(root, ["init", "--bare", "--initial-branch=main", emptyRemote]);

    await configureRepoRemote(local.dir, { remoteUrl: emptyRemote, defaultBranch: "main" });
    await pushRepo(local.dir);

    const remoteHead = await git(root, ["--git-dir", emptyRemote, "rev-parse", "refs/heads/main"]);
    const localHead = await git(local.dir, ["rev-parse", "HEAD"]);
    assert.equal(remoteHead, localHead);

    const unavailableRemote = `${emptyRemote}.offline`;
    await rename(emptyRemote, unavailableRemote);
    await writeFiles(local.dir, [{ path: "nachtrag.txt", content: "wird nachgeliefert" }]);
    await assert.rejects(
      commitAll(local.dir, { message: "Nachtrag liefern", authorName: "Frontend-Agent" }),
      (error: unknown) => error instanceof WorkspaceError && /Push nach origin\/main fehlgeschlagen/.test(error.message),
    );
    await rename(unavailableRemote, emptyRemote);

    // Der Commit existiert nach dem fehlgeschlagenen Push bereits lokal. Ein
    // Wiederholungsversuch ohne neue Dateiaenderung muss genau diesen Stand
    // nachliefern, statt wegen "nichts zu committen" still aufzugeben.
    assert.equal(await commitAll(local.dir, { message: "irrelevant", authorName: "Scrumy" }), null);
    assert.equal(
      await git(root, ["--git-dir", emptyRemote, "rev-parse", "refs/heads/main"]),
      await git(local.dir, ["rev-parse", "HEAD"]),
    );
  });

  await t.test("Zugangsdaten in der URL werden abgelehnt", async () => {
    await assert.rejects(
      configureRepoRemote(dir, { remoteUrl: "https://token@github.com/example/repo.git" }),
      (error: unknown) => error instanceof WorkspaceError && /keine Zugangsdaten/.test(error.message),
    );
  });

  await t.test("ein fehlender GitHub-Token faellt vor dem Netzwerkzugriff auf", async () => {
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      await assert.rejects(
        configureRepoRemote(dir, { remoteUrl: "https://github.com/example/repo.git" }),
        (error: unknown) => error instanceof WorkspaceError && /GITHUB_TOKEN/.test(error.message),
      );
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });
});
