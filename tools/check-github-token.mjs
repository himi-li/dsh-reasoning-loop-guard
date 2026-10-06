#!/usr/bin/env node
/**
 * Validate the stored GitHub token and report the account it belongs to,
 * without ever printing the token itself.
 *
 * The token is read from the environment (GITHUB_TOKEN), so this script never
 * spawns a child process and never echoes the secret. Feed it like this:
 *
 *   pwsh:
 *     $env:GITHUB_TOKEN = node <vault-cli> get <entry> --field apiKey
 *     node tools/check-github-token.mjs
 *
 * Exit 0 = token works, 1 = rejected, 2 = no token supplied.
 */
const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim();
if (token.length === 0) {
  console.error("no token in GITHUB_TOKEN / GH_TOKEN");
  process.exit(2);
}

console.log(`token shape: ${token.slice(0, 4)}…${token.slice(-4)} (len ${token.length})`);

const call = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "dsh-reasoning-loop-guard-release-check",
      "x-github-api-version": "2022-11-28",
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, scopes: res.headers.get("x-oauth-scopes"), body };
};

const user = await call("/user");
if (user.status !== 200) {
  console.error(`token rejected: HTTP ${user.status} ${JSON.stringify(user.body).slice(0, 200)}`);
  process.exit(1);
}
console.log(`authenticated as: ${user.body.login} (id ${user.body.id})`);
console.log(`token scopes: ${JSON.stringify(user.scopes)}`);

// A repo we may create: 404 means the name is free.
for (const name of ["dsh-reasoning-loop-guard", "dsh-thinking-guard"]) {
  const repo = await call(`/repos/${user.body.login}/${name}`);
  console.log(`repos/${user.body.login}/${name}: HTTP ${repo.status}${repo.status === 404 ? " (free)" : ""}`);
}

const rate = await call("/rate_limit");
console.log(`rate limit: ${rate.body?.rate?.remaining}/${rate.body?.rate?.limit}`);
