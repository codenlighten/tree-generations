const https = require("https");
const fs = require("fs");
const path = require("path");

class GitHubJsonTreeGenerator {
  constructor(token = process.env.GITHUB_TOKEN) {
    this.token = token;
    this.excludePatterns = ["node_modules", "package-lock.json"];
    this.baseUrl = "api.github.com";
  }

  async makeGitHubRequest(path) {
    const options = {
      hostname: this.baseUrl,
      path: path,
      headers: {
        "User-Agent": "GitHub-JSON-Tree-Generator",
        Accept: "application/vnd.github.v3+json",
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    };

    return new Promise((resolve, reject) => {
      https
        .get(options, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const jsonData = JSON.parse(data);
              if (res.statusCode !== 200) {
                reject(
                  new Error(jsonData.message || "GitHub API request failed")
                );
                return;
              }
              resolve(jsonData);
            } catch (error) {
              reject(error);
            }
          });
        })
        .on("error", reject);
    });
  }

  async getRepositoryInfo(owner, repo) {
    return this.makeGitHubRequest(`/repos/${owner}/${repo}`);
  }

  async getDefaultBranch(owner, repo) {
    const repoInfo = await this.getRepositoryInfo(owner, repo);
    return repoInfo.default_branch;
  }

  async getTreeData(owner, repo, branch) {
    return this.makeGitHubRequest(
      `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
    );
  }

  buildJsonTree(items) {
    const root = {
      name: "root",
      type: "directory",
      children: {},
      metadata: {
        totalFiles: 0,
        totalDirectories: 0,
        fileTypes: {},
      },
    };

    items
      .filter(
        (item) =>
          !this.excludePatterns.some((pattern) => item.path.includes(pattern))
      )
      .forEach((item) => {
        const parts = item.path.split("/");
        let current = root.children;

        // Process each part of the path
        parts.forEach((part, index) => {
          const isLast = index === parts.length - 1;

          if (isLast) {
            if (item.type === "blob") {
              current[part] = {
                name: part,
                type: "file",
                size: item.size,
                sha: item.sha,
                metadata: {
                  mode: item.mode,
                  type: item.type,
                  url: item.url,
                },
              };
              root.metadata.totalFiles++;

              // Track file types
              const ext = path.extname(part).toLowerCase() || "no extension";
              root.metadata.fileTypes[ext] =
                (root.metadata.fileTypes[ext] || 0) + 1;
            } else {
              current[part] = {
                name: part,
                type: "directory",
                children: {},
                metadata: {
                  mode: item.mode,
                  type: item.type,
                  sha: item.sha,
                },
              };
              root.metadata.totalDirectories++;
            }
          } else {
            if (!current[part]) {
              current[part] = {
                name: part,
                type: "directory",
                children: {},
                metadata: {},
              };
              root.metadata.totalDirectories++;
            }
            current = current[part].children;
          }
        });
      });

    return this.convertToArray(root);
  }

  convertToArray(node) {
    if (node.type === "file") {
      return node;
    }

    const result = {
      ...node,
      children: Object.values(node.children).map((child) =>
        this.convertToArray(child)
      ),
    };

    // Sort children: directories first, then files, both alphabetically
    result.children.sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name);
      }
      return a.type === "directory" ? -1 : 1;
    });

    return result;
  }

  formatSize(bytes) {
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    if (bytes === 0) return "0 Bytes";
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i), 2) + " " + sizes[i];
  }

  calculateTotalSize(node) {
    if (node.type === "file") {
      return node.size || 0;
    }
    return node.children.reduce(
      (total, child) => total + this.calculateTotalSize(child),
      0
    );
  }

  async generateOutput(owner, repo, branch, treeData, repoInfo) {
    const processedTree = this.buildJsonTree(treeData.tree);
    const totalSize = this.calculateTotalSize(processedTree);

    return {
      repository: {
        name: repo,
        owner: owner,
        branch: branch,
        description: repoInfo.description,
        stars: repoInfo.stargazers_count,
        forks: repoInfo.forks_count,
        url: repoInfo.html_url,
      },
      metadata: {
        generatedAt: new Date().toISOString(),
        totalSize: this.formatSize(totalSize),
        ...processedTree.metadata,
      },
      tree: processedTree.children,
    };
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.error("Please provide a GitHub repository URL");
    console.error(
      "Usage: node json-tree-github-generator.js <github-repo-url> [output-path]"
    );
    process.exit(1);
  }

  const repoUrl = process.argv[2];
  const outputPath = process.argv[3] || "./github-tree-output.json";
  const repoUrlPattern = /github\.com\/([^\/]+)\/([^\/]+)/;
  const match = repoUrl.match(repoUrlPattern);

  if (!match) {
    console.error("Invalid GitHub repository URL");
    process.exit(1);
  }

  const [, owner, repo] = match;
  const generator = new GitHubJsonTreeGenerator();

  try {
    console.log(`Fetching repository structure for ${owner}/${repo}...`);

    const branch = await generator.getDefaultBranch(owner, repo);
    const repoInfo = await generator.getRepositoryInfo(owner, repo);
    const treeData = await generator.getTreeData(owner, repo, branch);

    const output = await generator.generateOutput(
      owner,
      repo,
      branch,
      treeData,
      repoInfo
    );

    // Create output directory if it doesn't exist
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save the JSON file
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    console.log("\nRepository structure generated successfully!");
    console.log("\nSummary:");
    console.log("-".repeat(50));
    console.log(`Repository: ${output.repository.name}`);
    console.log(`Owner: ${output.repository.owner}`);
    console.log(`Branch: ${output.repository.branch}`);
    console.log(`Total Files: ${output.metadata.totalFiles}`);
    console.log(`Total Directories: ${output.metadata.totalDirectories}`);
    console.log(`Total Size: ${output.metadata.totalSize}`);
    console.log("\nFile Types:");
    Object.entries(output.metadata.fileTypes)
      .sort(([, a], [, b]) => b - a)
      .forEach(([ext, count]) => {
        console.log(`  ${ext}: ${count} files`);
      });
    console.log("-".repeat(50));
    console.log(`\nOutput saved to: ${outputPath}`);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = GitHubJsonTreeGenerator;
