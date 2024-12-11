const fs = require("fs");
const path = require("path");
const https = require("https");

// Base class for tree generation
class BaseTreeGenerator {
  constructor(options = {}) {
    this.excludePatterns = options.excludePatterns || [
      "node_modules",
      "package.json",
      "package-lock.json",
    ];
    this.indentationMarkers = {
      pipe: "│   ",
      corner: "└── ",
      branch: "├── ",
      space: "    ",
    };
  }

  generateTreeString(tree, prefix = "") {
    let result = "";
    const entries = Object.entries(tree);

    entries.forEach(([key, value], index) => {
      const isLast = index === entries.length - 1;
      const connector = isLast
        ? this.indentationMarkers.corner
        : this.indentationMarkers.branch;

      result += `${prefix}${connector}${key}\n`;

      if (value !== null) {
        const newPrefix =
          prefix +
          (isLast
            ? this.indentationMarkers.space
            : this.indentationMarkers.pipe);
        result += this.generateTreeString(value, newPrefix);
      }
    });

    return result;
  }

  generateMarkdownDoc(title, treeContent) {
    const timestamp = new Date().toLocaleString();
    return `# ${title}
Generated on: ${timestamp}

## Tree Structure
\`\`\`
${treeContent}
\`\`\`

## Details

This documentation shows the structure, excluding:
${this.excludePatterns.map((pattern) => `- ${pattern}`).join("\n")}
`;
  }
}

// Local filesystem tree generator
class TreeGenerator extends BaseTreeGenerator {
  generateTree(startPath, indent = "") {
    let output = "";

    try {
      const files = fs.readdirSync(startPath);

      files.forEach((file, index) => {
        if (this.excludePatterns.some((pattern) => file.includes(pattern))) {
          return;
        }

        const filePath = path.join(startPath, file);
        const stats = fs.statSync(filePath);
        const isLast = index === files.length - 1;

        const connector = isLast
          ? this.indentationMarkers.corner
          : this.indentationMarkers.branch;
        output += `${indent}${connector}${file}\n`;

        if (stats.isDirectory()) {
          const newIndent =
            indent +
            (isLast
              ? this.indentationMarkers.space
              : this.indentationMarkers.pipe);
          output += this.generateTree(filePath, newIndent);
        }
      });

      return output;
    } catch (error) {
      throw new Error(
        `Error processing directory ${startPath}: ${error.message}`
      );
    }
  }

  static async generate(targetPath = ".", options = {}) {
    const generator = new TreeGenerator(options);
    const fullPath = path.resolve(targetPath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Directory "${fullPath}" does not exist`);
    }

    return {
      path: fullPath,
      tree: generator.generateTree(fullPath),
    };
  }
}

// GitHub repository tree generator
class GitHubTreeGenerator extends BaseTreeGenerator {
  constructor(options = {}) {
    super(options);
    this.token = options.token || process.env.GITHUB_TOKEN;
  }
  writeTreeToFile(tree, filePath) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, tree, "utf8");
    } catch (error) {
      throw new Error(`Failed to write tree to file: ${error.message}`);
    }
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

    return this.makeGitHubRequest(options);
  }

  async makeGitHubRequest(options) {
    return new Promise((resolve, reject) => {
      https
        .get(options, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode === 404 && options.path.includes("/main?")) {
              options.path = options.path.replace("/main?", "/master?");
              return this.makeGitHubRequest(options)
                .then(resolve)
                .catch(reject);
            }
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

  static async generate(repoUrl, options = {}) {
    const repoUrlPattern = /github\.com\/([^\/]+)\/([^\/]+)/;
    const match = repoUrl.match(repoUrlPattern);

    if (!match) {
      throw new Error("Invalid GitHub repository URL");
    }

    const [, owner, repo] = match;
    const generator = new GitHubTreeGenerator(options);

    try {
      const treeData = await generator.getRepoTree(owner, repo);
      const structure = generator.buildTreeStructure(treeData);
      const treeString = generator.generateTreeString(structure);

      return {
        owner,
        repo,
        tree: treeString,
        generator, // Return the generator instance for method access
      };
    } catch (error) {
      throw new Error(`Failed to generate tree: ${error.message}`);
    }
  }
}

//example usage

async function generateEnhancedDoc(repoUrl, treeContent, owner, repo) {
  const timestamp = new Date().toLocaleString();
  return `# Repository Structure Documentation
Generated on: ${timestamp}

## Repository Information
- Repository: ${repoUrl}
- Owner: ${owner}
- Repository Name: ${repo}

## Directory Structure
This tree shows the hierarchical layout of all files and directories in the repository:

\`\`\`
${treeContent}
\`\`\`

## Quick Navigation Guide

### Common Directories
The following sections are typically found in this repository structure:

${treeContent.includes("src") ? "- `src/`: Source code files\n" : ""}
${
  treeContent.includes("components")
    ? "- `components/`: React/UI components\n"
    : ""
}
${
  treeContent.includes("utils")
    ? "- `utils/`: Utility functions and helpers\n"
    : ""
}
${
  treeContent.includes("services")
    ? "- `services/`: Service layer implementations\n"
    : ""
}
${treeContent.includes("api") ? "- `api/`: API-related code\n" : ""}
${treeContent.includes("tests") ? "- `tests/`: Test files\n" : ""}
${treeContent.includes("docs") ? "- `docs/`: Documentation files\n" : ""}

### Key Files
Notable files in the repository:
${
  treeContent.includes("README") ? "- `README.md`: Project documentation\n" : ""
}
${
  treeContent.includes("package.json")
    ? "- `package.json`: Project dependencies and scripts\n"
    : ""
}
${
  treeContent.includes("tsconfig.json")
    ? "- `tsconfig.json`: TypeScript configuration\n"
    : ""
}
${treeContent.includes(".env") ? "- `.env`: Environment variables\n" : ""}

## File Organization

This repository follows a structured approach to organize its files:
1. Core application code is separated from configuration and documentation
2. Related functionality is grouped in dedicated directories
3. Common utilities and shared resources are centralized

## Excluded Items
The following patterns are excluded from this tree for clarity:
- node_modules
- package.json
- package-lock.json

## Usage
To regenerate this documentation, run:
\`\`\`bash
node script.js ${repoUrl}
\`\`\`
`;
}

async function main() {
  try {
    const repoUrl =
      process.argv[2] || "https://github.com/codenlighten/tree-generations";
    console.log(`Generating tree for ${repoUrl}...`);

    const result = await GitHubTreeGenerator.generate(repoUrl);

    console.log("\nTree structure:");
    console.log(result.tree);

    if (result.tree) {
      // Generate enhanced markdown documentation
      const enhancedDoc = await generateEnhancedDoc(
        repoUrl,
        result.tree,
        result.owner,
        result.repo
      );

      // Save documentation
      const timestamp = new Date().toISOString().split("T")[0];
      const docDir = path.join(process.cwd(), "docs");

      // Create docs directory if it doesn't exist
      if (!fs.existsSync(docDir)) {
        fs.mkdirSync(docDir, { recursive: true });
      }

      // Save markdown file
      const docPath = path.join(
        docDir,
        `repository-structure-${result.owner}-${result.repo}-${timestamp}.md`
      );
      fs.writeFileSync(docPath, enhancedDoc);

      // Also save raw tree file for reference
      const treePath = path.join(
        docDir,
        `tree-structure-${result.owner}-${result.repo}-${timestamp}.txt`
      );
      result.generator.writeTreeToFile(result.tree, treePath);

      console.log("\nDocumentation generated successfully!");
      console.log(`Markdown documentation: ${docPath}`);
      console.log(`Tree structure: ${treePath}`);
    } else {
      console.log("\nNo tree structure was generated.");
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  BaseTreeGenerator,
  TreeGenerator,
  GitHubTreeGenerator,
};
