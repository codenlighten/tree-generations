const https = require("https");
const fs = require("fs");
const path = require("path");

class GitHubTreeGenerator {
  constructor(token = process.env.GITHUB_TOKEN) {
    this.token = token;
    this.excludePatterns = [
      "node_modules",
      "package.json",
      "package-lock.json",
    ];
  }

  async getRepoTree(owner, repo) {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/git/trees/main?recursive=1`,
      headers: {
        "User-Agent": "GitHub-Tree-Generator",
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
            if (res.statusCode === 404) {
              // Try 'master' branch if 'main' fails
              options.path = `/repos/${owner}/${repo}/git/trees/master?recursive=1`;
              this.retryWithMaster(options, resolve, reject);
              return;
            }
            try {
              const jsonData = JSON.parse(data);
              resolve(jsonData);
            } catch (error) {
              reject(error);
            }
          });
        })
        .on("error", reject);
    });
  }

  retryWithMaster(options, resolve, reject) {
    https
      .get(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const jsonData = JSON.parse(data);
            resolve(jsonData);
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  }

  buildTreeStructure(treeData) {
    const tree = {};

    treeData.tree
      .filter((item) => item.type === "blob" || item.type === "tree")
      .filter(
        (item) =>
          !this.excludePatterns.some((pattern) => item.path.includes(pattern))
      )
      .forEach((item) => {
        const parts = item.path.split("/");
        let current = tree;

        parts.forEach((part, index) => {
          if (index === parts.length - 1) {
            current[part] = item.type === "tree" ? {} : null;
          } else {
            current[part] = current[part] || {};
            current = current[part];
          }
        });
      });

    return tree;
  }

  generateTreeString(tree, prefix = "") {
    let result = "";
    const entries = Object.entries(tree);

    entries.forEach(([key, value], index) => {
      const isLast = index === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";

      result += `${prefix}${connector}${key}\n`;

      if (value !== null) {
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        result += this.generateTreeString(value, newPrefix);
      }
    });

    return result;
  }

  generateMarkdownDoc(repoUrl, treeContent) {
    const timestamp = new Date().toLocaleString();
    return `# GitHub Repository Structure Documentation
Generated on: ${timestamp}
Repository: ${repoUrl}

## Repository Tree
\`\`\`
${treeContent}
\`\`\`

## Repository Details

This documentation shows the structure of the GitHub repository, excluding:
${this.excludePatterns.map((pattern) => `- ${pattern}`).join("\n")}

You can regenerate this documentation by running:
\`\`\`bash
node github-tree-generator.js <github-repo-url>
\`\`\`
`;
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.error("Please provide a GitHub repository URL");
    console.error("Usage: node github-tree-generator.js <github-repo-url>");
    process.exit(1);
  }

  const repoUrl = process.argv[2];
  const repoUrlPattern = /github\.com\/([^\/]+)\/([^\/]+)/;
  const match = repoUrl.match(repoUrlPattern);

  if (!match) {
    console.error("Invalid GitHub repository URL");
    process.exit(1);
  }

  const [, owner, repo] = match;
  const generator = new GitHubTreeGenerator();

  try {
    console.log(`Fetching repository structure for ${owner}/${repo}...`);

    const treeData = await generator.getRepoTree(owner, repo);
    const structure = generator.buildTreeStructure(treeData);
    const treeString = generator.generateTreeString(structure);

    // Create docs directory if it doesn't exist
    const docsDir = path.join(process.cwd(), "docs");
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir);
    }

    // Generate and save documentation
    const markdownContent = generator.generateMarkdownDoc(repoUrl, treeString);
    const timestamp = new Date().toISOString().split("T")[0];
    const docPath = path.join(
      docsDir,
      `github-structure-${owner}-${repo}-${timestamp}.md`
    );
    fs.writeFileSync(docPath, markdownContent);

    // Print the tree and success message
    console.log("\nRepository structure:");
    console.log(treeString);
    console.log(`\nDocumentation saved to: ${docPath}`);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
