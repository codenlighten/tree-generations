const fs = require("fs");
const path = require("path");
const https = require("https");

class BaseJsonTreeGenerator {
  constructor(options = {}) {
    this.options = {
      includeMetadata: true,
      maxDepth: Infinity,
      excludePatterns: ["node_modules", "package-lock.json", ".git"],
      ...options,
    };
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

  generateSummary(treeData) {
    const summary = {
      totalFiles: 0,
      totalDirectories: 0,
      totalSize: 0,
      maxDepth: 0,
      fileTypes: {},
    };

    const processNode = (node, depth = 0) => {
      summary.maxDepth = Math.max(summary.maxDepth, depth);

      if (node.type === "file") {
        summary.totalFiles++;
        summary.totalSize += node.metadata?.size || node.size || 0;
        const ext = path.extname(node.name).toLowerCase() || "no extension";
        summary.fileTypes[ext] = (summary.fileTypes[ext] || 0) + 1;
      } else {
        summary.totalDirectories++;
      }

      for (const child of node.children || []) {
        processNode(child, depth + 1);
      }
    };

    processNode(treeData);
    summary.totalSize = this.formatSize(summary.totalSize);
    return summary;
  }

  async saveTreeData(treeData, outputPath) {
    const summary = this.generateSummary(treeData);
    const output = {
      generatedAt: new Date().toISOString(),
      summary,
      tree: treeData,
    };

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    return output;
  }

  sortChildren(node) {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.type === b.type) {
          return a.name.localeCompare(b.name);
        }
        return a.type === "directory" ? -1 : 1;
      });
    }
    return node;
  }
}

class FileSystemJsonTreeGenerator extends BaseJsonTreeGenerator {
  async generateTreeData(startPath, currentDepth = 0) {
    const stats = fs.statSync(startPath);
    const baseName = path.basename(startPath);

    const treeNode = {
      name: baseName,
      type: stats.isDirectory() ? "directory" : "file",
      path: startPath,
      children: [],
      metadata: this.options.includeMetadata
        ? {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            permissions: stats.mode,
          }
        : undefined,
    };

    if (!stats.isDirectory() || currentDepth >= this.options.maxDepth) {
      return treeNode;
    }

    try {
      const files = fs
        .readdirSync(startPath)
        .filter(
          (file) =>
            !this.options.excludePatterns.some((pattern) =>
              file.includes(pattern)
            )
        );

      for (const file of files) {
        const filePath = path.join(startPath, file);
        try {
          const childNode = await this.generateTreeData(
            filePath,
            currentDepth + 1
          );
          treeNode.children.push(childNode);
        } catch (error) {
          console.warn(
            `Warning: Could not process ${filePath}: ${error.message}`
          );
        }
      }

      this.sortChildren(treeNode);
    } catch (error) {
      console.error(`Error reading directory ${startPath}: ${error.message}`);
    }

    return treeNode;
  }
}

class GitHubJsonTreeGenerator extends BaseJsonTreeGenerator {
  constructor(options = {}) {
    super(options);
    this.token = options.token || process.env.GITHUB_TOKEN;
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

  processGitHubTree(items) {
    const root = {
      name: "root",
      type: "directory",
      children: [],
      metadata: {},
    };

    const itemsByPath = {};

    // First pass: create all nodes
    items
      .filter(
        (item) =>
          !this.options.excludePatterns.some((pattern) =>
            item.path.includes(pattern)
          )
      )
      .forEach((item) => {
        const parts = item.path.split("/");
        let currentPath = "";

        parts.forEach((part, index) => {
          const parentPath = currentPath;
          currentPath = currentPath ? `${currentPath}/${part}` : part;

          if (!itemsByPath[currentPath]) {
            const isFile = item.type === "blob" && index === parts.length - 1;
            itemsByPath[currentPath] = {
              name: part,
              type: isFile ? "file" : "directory",
              children: isFile ? undefined : [],
              metadata: {
                ...(isFile && { size: item.size }),
                sha: item.sha,
                mode: item.mode,
              },
            };

            if (parentPath) {
              itemsByPath[parentPath].children.push(itemsByPath[currentPath]);
            } else {
              root.children.push(itemsByPath[currentPath]);
            }
          }
        });
      });

    // Sort all children recursively
    const sortRecursively = (node) => {
      if (node.children) {
        node.children = node.children.sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === "directory" ? -1 : 1;
        });
        node.children.forEach(sortRecursively);
      }
      return node;
    };

    return sortRecursively(root);
  }

  async generate(repoUrl) {
    const repoUrlPattern = /github\.com\/([^\/]+)\/([^\/]+)/;
    const match = repoUrl.match(repoUrlPattern);

    if (!match) {
      throw new Error("Invalid GitHub repository URL");
    }

    const [, owner, repo] = match;
    const branch = await this.getDefaultBranch(owner, repo);
    const repoInfo = await this.getRepositoryInfo(owner, repo);
    const treeData = await this.getTreeData(owner, repo, branch);

    const processedTree = this.processGitHubTree(treeData.tree);

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
      tree: processedTree,
    };
  }
}
async function generateDevDocs(tree, repoInfo) {
  const timestamp = new Date().toISOString();
  const docTemplate = {
    metadata: {
      generatedAt: timestamp,
      repository: repoInfo,
      lastUpdated: repoInfo.repository?.updated_at || timestamp,
    },
    projectStructure: {
      overview: {
        sourceFiles: [],
        testFiles: [],
        configFiles: [],
        components: [],
        utilities: [],
        services: [],
        models: [],
        routes: [],
      },
      dataFlow: {
        entryPoints: [],
        services: [],
        dataModels: [],
        utilities: [],
      },
    },
  };

  function categorizeFile(filePath, fileName) {
    if (fileName.includes(".test.") || fileName.includes(".spec."))
      return "testFiles";
    if (fileName.match(/\.(js|ts|jsx|tsx)$/)) {
      if (filePath.includes("/components/")) return "components";
      if (filePath.includes("/services/")) return "services";
      if (filePath.includes("/utils/")) return "utilities";
      if (filePath.includes("/models/")) return "models";
      if (filePath.includes("/routes/")) return "routes";
      return "sourceFiles";
    }
    if (fileName.match(/\.(json|yaml|yml|env|config)$/)) return "configFiles";
    return null;
  }

  function processNode(node, parentPath = "") {
    const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;

    if (node.type === "file") {
      const category = categorizeFile(currentPath, node.name);
      if (category) {
        docTemplate.projectStructure.overview[category].push({
          name: node.name,
          path: currentPath,
          size: node.metadata?.size ? formatSize(node.metadata.size) : "N/A",
          lastModified: node.metadata?.modified || "N/A",
        });

        // Add to data flow if relevant
        if (node.name.includes("service") || node.name.includes("api")) {
          docTemplate.projectStructure.dataFlow.services.push({
            name: node.name,
            path: currentPath,
            dependencies: findDependencies(node),
          });
        } else if (
          node.name.includes("model") ||
          node.name.includes("schema")
        ) {
          docTemplate.projectStructure.dataFlow.dataModels.push({
            name: node.name,
            path: currentPath,
          });
        } else if (currentPath.includes("/utils/")) {
          docTemplate.projectStructure.dataFlow.utilities.push({
            name: node.name,
            path: currentPath,
          });
        } else if (
          currentPath.includes("index.") ||
          currentPath.includes("main.") ||
          currentPath.includes("app.")
        ) {
          docTemplate.projectStructure.dataFlow.entryPoints.push({
            name: node.name,
            path: currentPath,
          });
        }
      }
    }

    if (node.children) {
      node.children.forEach((child) => processNode(child, currentPath));
    }
  }

  function formatSize(bytes) {
    const sizes = ["Bytes", "KB", "MB", "GB"];
    if (bytes === 0) return "0 Bytes";
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i), 2) + " " + sizes[i];
  }

  // Process the tree to populate the documentation
  processNode(tree);

  // Generate markdown documentation
  const markdown = `# Project Structure Documentation
Generated on: ${new Date().toLocaleString()}

## Repository Information
- Name: ${repoInfo.repository.name}
- Owner: ${repoInfo.repository.owner}
- Branch: ${repoInfo.repository.branch}

## Project Overview

### Entry Points
${docTemplate.projectStructure.dataFlow.entryPoints
  .map((entry) => `- \`${entry.path}\``)
  .join("\n")}

### Services
${docTemplate.projectStructure.dataFlow.services
  .map((service) => `- \`${service.path}\``)
  .join("\n")}

### Data Models
${docTemplate.projectStructure.dataFlow.dataModels
  .map((model) => `- \`${model.path}\``)
  .join("\n")}

### Components
${docTemplate.projectStructure.overview.components
  .map((comp) => `- \`${comp.path}\``)
  .join("\n")}

### Utilities
${docTemplate.projectStructure.overview.utilities
  .map((util) => `- \`${util.path}\``)
  .join("\n")}

## Data Flow Diagram
\`\`\`mermaid
flowchart TD
    ${docTemplate.projectStructure.dataFlow.entryPoints
      .map((entry) => `Entry[${entry.name}]`)
      .join("\n    ")}
    ${docTemplate.projectStructure.dataFlow.services
      .map((service) => `Service[${service.name}]`)
      .join("\n    ")}
    ${docTemplate.projectStructure.dataFlow.dataModels
      .map((model) => `Model[${model.name}]`)
      .join("\n    ")}
    
    Entry --> Service
    Service --> Model
\`\`\`

## Directory Structure
\`\`\`
[Tree structure will be added here]
\`\`\`
`;

  return {
    markdown,
    documentation: docTemplate,
  };
}
async function generateDevDocs(tree, repoInfo) {
  const timestamp = new Date().toISOString();
  const docTemplate = {
    metadata: {
      generatedAt: timestamp,
      repository: repoInfo,
      lastUpdated: repoInfo.repository?.updated_at || timestamp,
    },
    projectStructure: {
      overview: {
        sourceFiles: [],
        testFiles: [],
        configFiles: [],
        components: [],
        utilities: [],
        services: [],
        models: [],
        routes: [],
      },
      dataFlow: {
        entryPoints: [],
        services: [],
        dataModels: [],
        utilities: [],
      },
    },
  };

  function categorizeFile(filePath, fileName) {
    if (fileName.includes(".test.") || fileName.includes(".spec."))
      return "testFiles";
    if (fileName.match(/\.(js|ts|jsx|tsx)$/)) {
      if (filePath.includes("/components/")) return "components";
      if (filePath.includes("/services/")) return "services";
      if (filePath.includes("/utils/")) return "utilities";
      if (filePath.includes("/models/")) return "models";
      if (filePath.includes("/routes/")) return "routes";
      return "sourceFiles";
    }
    if (fileName.match(/\.(json|yaml|yml|env|config)$/)) return "configFiles";
    return null;
  }

  function processNode(node, parentPath = "") {
    const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;

    if (node.type === "file") {
      const category = categorizeFile(currentPath, node.name);
      if (category) {
        docTemplate.projectStructure.overview[category].push({
          name: node.name,
          path: currentPath,
          size: node.metadata?.size ? formatSize(node.metadata.size) : "N/A",
          lastModified: node.metadata?.modified || "N/A",
        });

        // Add to data flow if relevant
        if (node.name.includes("service") || node.name.includes("api")) {
          docTemplate.projectStructure.dataFlow.services.push({
            name: node.name,
            path: currentPath,
            dependencies: findDependencies(node),
          });
        } else if (
          node.name.includes("model") ||
          node.name.includes("schema")
        ) {
          docTemplate.projectStructure.dataFlow.dataModels.push({
            name: node.name,
            path: currentPath,
          });
        } else if (currentPath.includes("/utils/")) {
          docTemplate.projectStructure.dataFlow.utilities.push({
            name: node.name,
            path: currentPath,
          });
        } else if (
          currentPath.includes("index.") ||
          currentPath.includes("main.") ||
          currentPath.includes("app.")
        ) {
          docTemplate.projectStructure.dataFlow.entryPoints.push({
            name: node.name,
            path: currentPath,
          });
        }
      }
    }

    if (node.children) {
      node.children.forEach((child) => processNode(child, currentPath));
    }
  }

  function formatSize(bytes) {
    const sizes = ["Bytes", "KB", "MB", "GB"];
    if (bytes === 0) return "0 Bytes";
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i), 2) + " " + sizes[i];
  }

  // Process the tree to populate the documentation
  processNode(tree);

  // Generate markdown documentation
  const markdown = `# Project Structure Documentation
Generated on: ${new Date().toLocaleString()}

## Repository Information
- Name: ${repoInfo.repository.name}
- Owner: ${repoInfo.repository.owner}
- Branch: ${repoInfo.repository.branch}

## Project Overview

### Entry Points
${docTemplate.projectStructure.dataFlow.entryPoints
  .map((entry) => `- \`${entry.path}\``)
  .join("\n")}

### Services
${docTemplate.projectStructure.dataFlow.services
  .map((service) => `- \`${service.path}\``)
  .join("\n")}

### Data Models
${docTemplate.projectStructure.dataFlow.dataModels
  .map((model) => `- \`${model.path}\``)
  .join("\n")}

### Components
${docTemplate.projectStructure.overview.components
  .map((comp) => `- \`${comp.path}\``)
  .join("\n")}

### Utilities
${docTemplate.projectStructure.overview.utilities
  .map((util) => `- \`${util.path}\``)
  .join("\n")}

## Data Flow Diagram
\`\`\`mermaid
flowchart TD
  ${docTemplate.projectStructure.dataFlow.entryPoints
    .map((entry) => `Entry[${entry.name}]`)
    .join("\n    ")}
  ${docTemplate.projectStructure.dataFlow.services
    .map((service) => `Service[${service.name}]`)
    .join("\n    ")}
  ${docTemplate.projectStructure.dataFlow.dataModels
    .map((model) => `Model[${model.name}]`)
    .join("\n    ")}
  
  Entry --> Service
  Service --> Model
\`\`\`

## Directory Structure
\`\`\`
[Tree structure will be added here]
\`\`\`
`;

  return {
    markdown,
    documentation: docTemplate,
  };
}

// Update the main function to use the new documentation generator
async function main() {
  try {
    const repoUrl =
      process.argv[2] || "https://github.com/codenlighten/tree-generations";
    const outputPath = process.argv[3] || "./docs/project-structure.md";

    console.log(`Analyzing repository structure for ${repoUrl}...`);

    const treeGenerator = new GitHubJsonTreeGenerator();
    const result = await treeGenerator.generate(repoUrl);

    const devDocs = await generateDevDocs(result.tree, result);

    // Ensure docs directory exists
    const docsDir = path.dirname(outputPath);
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }

    // Save the markdown documentation
    fs.writeFileSync(outputPath, devDocs.markdown);

    // Save the JSON structure for programmatic use
    fs.writeFileSync(
      outputPath.replace(".md", ".json"),
      JSON.stringify(devDocs.documentation, null, 2)
    );

    console.log(`\nDeveloper documentation generated successfully!`);
    console.log(`\nFiles generated:`);
    console.log(`- Markdown: ${outputPath}`);
    console.log(`- JSON: ${outputPath.replace(".md", ".json")}`);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}
main();

module.exports = {
  BaseJsonTreeGenerator,
  FileSystemJsonTreeGenerator,
  GitHubJsonTreeGenerator,
};
