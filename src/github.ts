/**
 * GitHub Integration - REST API with Personal Access Token
 */

// ============================================================================
// Types
// ============================================================================

export interface GitHubConfig {
  token: string;
  owner: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  user: { login: string };
  created_at: string;
}

export interface GitHubComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  user: { login: string };
  created_at: string;
}

interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string;
  download_url: string | null;
  type: string;
  content?: string;
  encoding?: string;
}

// ============================================================================
// Module State
// ============================================================================

let _config: GitHubConfig | null = null;

// ============================================================================
// Initialization
// ============================================================================

export function initGitHub(config: GitHubConfig): void {
  _config = config;
  console.log(`[github] Initialized for ${config.owner}`);
}

// ============================================================================
// Connection Status
// ============================================================================

export function isConnected(): boolean {
  return _config !== null && _config.token.length > 0;
}

export function getConnectionStatus(): string {
  if (!_config || !_config.token) return "Not configured";
  return `Connected as ${_config.owner}`;
}

// ============================================================================
// REST API Helper
// ============================================================================

async function githubRequest(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  if (!_config) throw new Error("GitHub not initialized");

  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com/${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers as Record<string, string>,
      Authorization: `Bearer ${_config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

// ============================================================================
// Helpers
// ============================================================================

function parseRepoRef(repoRef: string): { owner: string; repo: string } {
  if (!_config) throw new Error("GitHub not initialized");

  if (repoRef.includes("/")) {
    const [owner, repo] = repoRef.split("/");
    return { owner, repo };
  }
  return { owner: _config.owner, repo: repoRef };
}

// ============================================================================
// Repo Operations
// ============================================================================

export async function listRepos(maxResults: number = 20): Promise<GitHubRepo[]> {
  const params = new URLSearchParams({
    affiliation: "owner,collaborator",
    per_page: String(maxResults),
    sort: "updated",
  });
  return await githubRequest(`user/repos?${params}`) as GitHubRepo[];
}

export async function createRepo(name: string, description?: string, isPrivate: boolean = false): Promise<GitHubRepo> {
  return await githubRequest("user/repos", {
    method: "POST",
    body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }),
  }) as GitHubRepo;
}

// ============================================================================
// Issue Operations
// ============================================================================

export async function listIssues(repoRef: string, state: "open" | "closed" | "all" = "open", maxResults: number = 10): Promise<GitHubIssue[]> {
  const { owner, repo } = parseRepoRef(repoRef);
  const params = new URLSearchParams({ state, per_page: String(maxResults) });
  return await githubRequest(`repos/${owner}/${repo}/issues?${params}`) as GitHubIssue[];
}

export async function createIssue(repoRef: string, title: string, body?: string): Promise<GitHubIssue> {
  const { owner, repo } = parseRepoRef(repoRef);
  return await githubRequest(`repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body }),
  }) as GitHubIssue;
}

export async function readIssue(repoRef: string, issueNumber: number): Promise<{ issue: GitHubIssue; comments: GitHubComment[] }> {
  const { owner, repo } = parseRepoRef(repoRef);
  const issue = await githubRequest(`repos/${owner}/${repo}/issues/${issueNumber}`) as GitHubIssue;
  const comments = await githubRequest(`repos/${owner}/${repo}/issues/${issueNumber}/comments`) as GitHubComment[];
  return { issue, comments };
}

export async function commentOnIssue(repoRef: string, issueNumber: number, body: string): Promise<GitHubComment> {
  const { owner, repo } = parseRepoRef(repoRef);
  return await githubRequest(`repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  }) as GitHubComment;
}

export async function closeIssue(repoRef: string, issueNumber: number): Promise<GitHubIssue> {
  const { owner, repo } = parseRepoRef(repoRef);
  return await githubRequest(`repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  }) as GitHubIssue;
}

// ============================================================================
// Pull Request Operations
// ============================================================================

export async function listPullRequests(repoRef: string, state: "open" | "closed" | "all" = "open", maxResults: number = 10): Promise<GitHubPullRequest[]> {
  const { owner, repo } = parseRepoRef(repoRef);
  const params = new URLSearchParams({ state, per_page: String(maxResults) });
  return await githubRequest(`repos/${owner}/${repo}/pulls?${params}`) as GitHubPullRequest[];
}

// ============================================================================
// File Operations
// ============================================================================

export async function readFile(repoRef: string, filePath: string, branch: string = "main"): Promise<string> {
  const { owner, repo } = parseRepoRef(repoRef);
  const params = new URLSearchParams({ ref: branch });
  const file = await githubRequest(`repos/${owner}/${repo}/contents/${filePath}?${params}`) as GitHubFile;

  if (file.type !== "file" || !file.content) {
    throw new Error(`${filePath} is not a file or has no content`);
  }

  return Buffer.from(file.content, (file.encoding as BufferEncoding) || "base64").toString("utf-8");
}

export async function createOrUpdateFile(
  repoRef: string, filePath: string, content: string, message: string, branch: string = "main",
): Promise<{ html_url: string }> {
  const { owner, repo } = parseRepoRef(repoRef);

  // Try to get existing file SHA for updates
  let sha: string | undefined;
  try {
    const existing = await githubRequest(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`) as GitHubFile;
    sha = existing.sha;
  } catch {
    // File doesn't exist — that's fine for create
  }

  const result = await githubRequest(`repos/${owner}/${repo}/contents/${filePath}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString("base64"),
      branch,
      ...(sha && { sha }),
    }),
  }) as { content: { html_url: string } };

  return { html_url: result.content.html_url };
}
