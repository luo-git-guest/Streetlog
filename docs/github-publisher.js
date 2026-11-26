"use strict";

window.streetlogGitHub = (() => {
  function repository(value) {
    if (typeof value !== "string") return null;
    const match = /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+?)\/?$/i.exec(value.trim());
    if (!match) return null;
    const name = match[2].replace(/\.git$/i, "");
    if (!name || name === "." || name === "..") return null;
    return [match[1], name];
  }

  function folder(value) {
    if (typeof value !== "string" || /^\/|[\\:?#%\u0000-\u001f]/.test(value.trim())) return null;
    const parts = value.trim().split("/").filter(part => part && part !== ".");
    if (!parts.length || parts.some(part => part === ".." || /^\.git/i.test(part))) return null;
    return parts.join("/");
  }

  function connect(token = "") {
    async function request(parts, method = "GET", body, ref) {
      const url = new URL("https://api.github.com/" + parts.map(encodeURIComponent).join("/"));
      if (ref) url.searchParams.set("ref", ref);
      const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      if (token) headers.Authorization = "Bearer " + token;
      if (body) headers["Content-Type"] = "application/json";
      const response = await fetch(url, {
        method, headers, body: body && JSON.stringify(body),
        cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000)
      });
      const data = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error(data.message || `GitHub returned HTTP ${response.status}.`), { status: response.status });
      }
      return data;
    }

    async function optional(parts, ref, allowed = [404]) {
      try {
        return await request(parts, "GET", undefined, ref);
      } catch (error) {
        if (!allowed.includes(error.status)) throw error;
        return null;
      }
    }

    async function inspect(repo, publishedFolder, account) {
      const endpoint = ["repos", ...repo];
      const info = await request(endpoint);
      if (info.archived || info.disabled) throw new Error("This GitHub repository is read-only.");
      const pages = await optional([...endpoint, "pages"], undefined, [403, 404]);
      const branch = pages?.build_type === "legacy" ? pages.source?.branch || info.default_branch : info.default_branch;
      const contents = await optional([...endpoint, "contents", "site.json"], branch);
      if (contents?.type !== "file" || contents.encoding !== "base64") {
        throw new Error("The repository needs a readable site.json at its root.");
      }
      const bytes = Uint8Array.from(atob(contents.content), character => character.charCodeAt(0));
      const config = JSON.parse(new TextDecoder().decode(bytes));
      const path = folder(config.GeoJSON_folder);
      if (!path || path !== folder(publishedFolder) ||
          repository(config.git_url)?.join("/").toLowerCase() !== repo.join("/").toLowerCase()) {
        throw new Error("GitHub and the published site have different repository or folder settings.");
      }
      const prefix = pages?.source?.path === "/docs" ||
        (pages?.build_type !== "legacy" && (await optional([...endpoint, "contents", "docs", "index.html"], branch))?.type === "file")
        ? "docs/" : "";
      const detailed = account && await optional([...endpoint, "collaborators", account, "permission"], undefined, [403, 404]);
      const permissions = info.permissions ?? {};
      const role = detailed?.permission && detailed.permission !== "none"
        ? detailed.role_name || detailed.permission
        : (["admin", "maintain", "push", "triage"].find(key => permissions[key]) ??
          (info.private && permissions.pull ? "read" : "guest"));
      return { repo, endpoint, branch, path: prefix + path, account, role: role === "push" ? "write" : role,
        canPush: Boolean(account && permissions.push), isPrivate: info.private };
    }

    async function upload(target, filename, data) {
      const { repo, endpoint, branch, path, account, canPush } = target;
      const head = branch.split("/");
      const ref = await request([...endpoint, "git", "ref", "heads", ...head]);
      const parent = await request([...endpoint, "git", "commits", ref.object.sha]);
      const uploadBranch = "streetlog/upload-" + crypto.randomUUID();
      const fallback = error => [403, 404, 409, 422].includes(error.status);
      const createBranch = (destination, sha) => request([...destination, "git", "refs"], "POST",
        { ref: "refs/heads/" + uploadBranch, sha });
      const openPR = async source => {
        const pr = await request([...endpoint, "pulls"], "POST", {
          title: "Upload outing from Streetlog", head: source, base: branch,
          body: `Adds a Streetlog outing to \`${path}\`.`
        });
        return { url: pr.html_url, pullRequest: true };
      };
      const makeCommit = async destination => {
        const tree = await request([...destination, "git", "trees"], "POST", {
          base_tree: parent.tree.sha,
          tree: [{ path: path + "/" + filename, mode: "100644", type: "blob", content: data }]
        });
        return request([...destination, "git", "commits"], "POST", {
          message: "Upload outing from Streetlog", tree: tree.sha, parents: [parent.sha]
        });
      };
      if (canPush) {
        let commit;
        try {
          commit = await makeCommit(endpoint);
          await request([...endpoint, "git", "refs", "heads", ...head], "PATCH", { sha: commit.sha, force: false });
          return { url: `https://github.com/${repo.join("/")}/commit/${commit.sha}`, pullRequest: false };
        } catch (error) {
          if (!fallback(error)) throw error;
        }
        if (commit) {
          let created = false;
          try {
            await createBranch(endpoint, commit.sha);
            created = true;
          } catch (error) {
            if (!fallback(error)) throw error;
          }
          if (created) return openPR(uploadBranch);
        }
      }

      if (account.toLowerCase() === repo[0].toLowerCase()) {
        throw new Error("GitHub rejected the publishing branch. Check your token permissions and repository rules.");
      }
      const fork = ["repos", account, repo[1]];
      const existing = await optional(fork);
      if (existing && existing.parent?.full_name?.toLowerCase() !== repo.join("/").toLowerCase()) {
        throw new Error("Your account already has a repository with this name that was not forked from this site.");
      }
      if (!existing) await request([...endpoint, "forks"], "POST", {});
      for (let attempt = 0; ; attempt++) {
        if (await optional([...fork, "git", "commits", parent.sha], undefined, [404, 409, 422])) break;
        if (attempt === 9) throw new Error("The fork does not have the current base commit yet. Sync the fork and retry.");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const commit = await makeCommit(fork);
      await createBranch(fork, commit.sha);
      return openPR(account + ":" + uploadBranch);
    }

    return { user: () => request(["user"]), inspect, upload };
  }

  return { repository, connect };
})();
